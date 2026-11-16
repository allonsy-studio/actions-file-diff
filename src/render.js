/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import { readFileSync } from "node:fs";

import { MAX_IMAGE_SIZE } from "./changes.js";
import css from "./report-page.css";
import { isReportedFile, printChange, printPercentChange } from "./report.js";
import { bytesToSize } from "./utilities.js";

/** GitHub caps a step summary at 1 MiB; keep headroom for the size report. */
export const SUMMARY_BUDGET = 900 * 1024;

/** Width of the text bars in the markdown size chart. */
const BAR_WIDTH = 20;

/** Status labels shared by both renderers. */
const STATUS_LABEL = { added: "🆕 added", removed: "🚨 removed", modified: "✏️ modified" };

/**
 * @typedef {object} SizeRow
 * @property {string} packageName
 * @property {string} file Readable filename within the package.
 * @property {number|undefined} headByteSize
 * @property {number|undefined} baseByteSize
 */

/**
 * Escapes text for HTML.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Flattens report sections into one row per reported file.
 * @param {import("./report.js").Section[]} sections
 * @returns {SizeRow[]}
 */
export function sizeRows(sections = []) {
	return sections.flatMap(({ name, files }) =>
		[...files.keys()]
			.filter(isReportedFile)
			.sort()
			.map((file) => ({ packageName: name, file, ...files.get(file) })),
	);
}

/**
 * Bar length as a 0–1 fraction of `max`, on a log scale so small files stay
 * visible next to large ones.
 * @param {number|undefined} value
 * @param {number} max
 * @returns {number}
 */
export function barScale(value, max) {
	if (!value || !max) return 0;
	return Math.log1p(value) / Math.log1p(max);
}

/**
 * Text bar scaled against a maximum (log scale, see barScale).
 * @param {number|undefined} value
 * @param {number} max
 * @returns {string}
 */
export function textBar(value, max) {
	if (!value || !max) return "";
	return "█".repeat(Math.max(1, Math.round(barScale(value, max) * BAR_WIDTH)));
}

/**
 * Markdown fence longer than any backtick run in the content.
 * @param {string} content
 * @returns {string}
 */
export function fenceFor(content) {
	const longest = Math.max(0, ...(String(content).match(/`+/g) ?? []).map((run) => run.length));
	return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Unified diff text for one change, including file headers.
 * @param {import("./changes.js").TextChange} change
 * @returns {string}
 */
export function unifiedDiff({ file, status, hunks }) {
	const from = status === "added" ? "/dev/null" : `a/${file}`;
	const to = status === "removed" ? "/dev/null" : `b/${file}`;
	const body = hunks.flatMap(({ oldStart, oldLines, newStart, newLines, lines }) => [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, ...lines]);
	return [`--- ${from}`, `+++ ${to}`, ...body].join("\n");
}

/**
 * One-line change stats for the pull request comment.
 * @param {object} options
 * @param {import("./changes.js").Stats} options.stats
 * @param {number} [options.imageCount]
 * @returns {string}
 */
export function renderStats({ stats, imageCount = 0 }) {
	const files = stats.added + stats.removed + stats.modified;
	if (files === 0) return "**Changed files**: none";
	const parts = [`**Changed files**: ${files}`, `${stats.added} added`, `${stats.removed} removed`, `${stats.modified} modified`];
	const lines = `**Lines**: +${stats.additions} / −${stats.deletions}`;
	const images = imageCount ? ` · **Images**: ${imageCount}` : "";
	return `${parts[0]} (${parts.slice(1).join(", ")}) · ${lines}${images}`;
}

/**
 * Markdown size chart: one row per file with base/head text bars.
 * @param {SizeRow[]} rows
 * @param {boolean} hasBase
 * @returns {string[]}
 */
export function renderSizeChartMarkdown(rows, hasBase) {
	if (rows.length === 0) return ["No size changes."];
	const max = Math.max(...rows.flatMap(({ headByteSize, baseByteSize }) => [headByteSize ?? 0, baseByteSize ?? 0]));
	const header = hasBase ? ["Package", "File", "Base", "Head", "Δ", "Chart (base / head, log)"] : ["Package", "File", "Head", "Chart (log)"];
	const body = rows.map(({ packageName, file, headByteSize, baseByteSize }) => {
		const headBar = `\`${textBar(headByteSize, max) || "·"}\``;
		if (!hasBase) return [packageName, file, bytesToSize(headByteSize), headBar];
		const baseBar = `\`${textBar(baseByteSize, max) || "·"}\``;
		const percent = printPercentChange(headByteSize, baseByteSize);
		const delta = printChange(headByteSize, baseByteSize);
		return [packageName, file, bytesToSize(baseByteSize), bytesToSize(headByteSize), delta !== "-" && percent ? `${delta} (${percent})` : delta, `${baseBar}<br/>${headBar}`];
	});
	return [header, header.map(() => "-"), ...body].map((row) => `| ${row.join(" | ")} |`);
}

/**
 * Job summary markdown with collapsible Sizes, Line diffs and (when present)
 * Visual diffs sections. Line diffs stop once the byte budget is spent.
 * @param {object} options
 * @param {SizeRow[]} options.rows
 * @param {boolean} options.hasBase
 * @param {ReturnType<import("./changes.js").collectChanges>} options.changes
 * @param {number} [options.budget] Byte budget for the diff section.
 * @param {string} [options.reportUrl] Full report link shown when diffs are truncated.
 * @returns {string}
 */
export function renderSummaryMarkdown({ rows, hasBase, changes, budget = SUMMARY_BUDGET, reportUrl }) {
	const out = ["<details open>", "<summary><b>📊 Sizes</b></summary>", "", ...renderSizeChartMarkdown(rows, hasBase), "", "</details>", ""];

	out.push("<details>", `<summary><b>📝 Line diffs (${changes.text.length})</b></summary>`, "");
	if (changes.text.length === 0) out.push("No text changes.", "");

	let spent = 0;
	const truncated = [];
	changes.text.forEach((change) => {
		const counts = change.skipped ? "" : ` (+${change.additions} / −${change.deletions})`;
		const heading = `#### \`${change.file}\` — ${STATUS_LABEL[change.status]}${counts}`;
		if (change.skipped) {
			out.push(heading, "", `_Line diff skipped: ${change.skipped}._`, "");
			return;
		}
		const diff = unifiedDiff(change);
		const fence = fenceFor(diff);
		const block = [heading, "", `${fence}diff`, diff, fence, ""].join("\n");
		const size = Buffer.byteLength(block);
		if (spent + size > budget) {
			truncated.push(change.file);
			return;
		}
		spent += size;
		out.push(block);
	});

	if (truncated.length > 0) {
		const where = reportUrl ? ` See the [full report](${reportUrl}).` : "";
		out.push(`> [!NOTE]`, `> ${truncated.length} diff(s) omitted to stay under GitHub's summary size limit: ${truncated.map((f) => `\`${f}\``).join(", ")}.${where}`, "");
	}
	out.push("</details>", "");

	if (changes.images.length > 0) {
		out.push("<details>", `<summary><b>🖼️ Visual diffs (${changes.images.length})</b></summary>`, "");
		out.push("| File | Status | Base | Head |", "| - | - | - | - |");
		changes.images.forEach(({ file, status, baseByteSize, headByteSize }) => out.push(`| \`${file}\` | ${STATUS_LABEL[status]} | ${bytesToSize(baseByteSize)} | ${bytesToSize(headByteSize)} |`));
		out.push("", reportUrl ? `Side-by-side previews are in the [full report](${reportUrl}).` : "_Set `visual-diff: branch` to publish side-by-side image previews._", "", "</details>", "");
	}

	return out.join("\n");
}

/**
 * HTML rows for one diff, with old/new line numbers.
 * @param {import("./changes.js").TextChange} change
 * @returns {string}
 */
function renderDiffTable({ hunks }) {
	const rows = [];
	hunks.forEach(({ oldStart, oldLines, newStart, newLines, lines }) => {
		rows.push(`<tr class="hunk"><td></td><td></td><td>@@ -${oldStart},${oldLines} +${newStart},${newLines} @@</td></tr>`);
		let oldNo = oldStart;
		let newNo = newStart;
		lines.forEach((line) => {
			const sign = line[0];
			const code = escapeHtml(line.slice(1));
			if (sign === "+") rows.push(`<tr class="add"><td></td><td>${newNo++}</td><td>+${code}</td></tr>`);
			else if (sign === "-") rows.push(`<tr class="del"><td>${oldNo++}</td><td></td><td>-${code}</td></tr>`);
			else if (sign === "\\") rows.push(`<tr class="meta"><td></td><td></td><td>${escapeHtml(line)}</td></tr>`);
			else rows.push(`<tr><td>${oldNo++}</td><td>${newNo++}</td><td> ${code}</td></tr>`);
		});
	});
	return `<table class="diff">${rows.join("")}</table>`;
}

/**
 * Self-contained HTML report with tabs for sizes, line diffs and, when images
 * changed, visual diffs. Works without JavaScript (all panels show).
 * @param {object} options
 * @param {string} options.title
 * @param {SizeRow[]} options.rows
 * @param {boolean} options.hasBase
 * @param {ReturnType<import("./changes.js").collectChanges>} options.changes
 * @param {{ headTotal: number, baseTotal: number }} options.totals
 * @param {Map<string, { head?: string, base?: string }>} [options.imageUrls] File → relative image URLs.
 * @param {string} [options.context] Line under the title (e.g. PR and commit).
 * @returns {string}
 */
export function renderHtml({ title, rows, hasBase, changes, totals, imageUrls = new Map(), context = "" }) {
	const max = Math.max(1, ...rows.flatMap(({ headByteSize, baseByteSize }) => [headByteSize ?? 0, baseByteSize ?? 0]));
	const pct = (v) => `${(barScale(v, max) * 100).toFixed(2)}%`;

	const sizeRowsHtml = rows
		.map(({ packageName, file, headByteSize, baseByteSize }) => {
			const delta = hasBase ? printChange(headByteSize, baseByteSize) : "";
			const percent = hasBase ? printPercentChange(headByteSize, baseByteSize) : "";
			const bars = [hasBase ? `<div class="bar base" style="width:${pct(baseByteSize)}" title="base ${escapeHtml(bytesToSize(baseByteSize))}"></div>` : "", `<div class="bar head" style="width:${pct(headByteSize)}" title="head ${escapeHtml(bytesToSize(headByteSize))}"></div>`].join("");
			return `<tr><td>${escapeHtml(packageName)}</td><td><code>${escapeHtml(file)}</code></td>${hasBase ? `<td>${escapeHtml(bytesToSize(baseByteSize))}</td>` : ""}<td>${escapeHtml(bytesToSize(headByteSize))}</td>${hasBase ? `<td>${escapeHtml(delta)}${delta !== "-" && percent ? ` (${escapeHtml(percent)})` : ""}</td>` : ""}<td class="chart">${bars}</td></tr>`;
		})
		.join("");

	const sizesPanel = rows.length ? `<table class="sizes"><thead><tr><th>Package</th><th>File</th>${hasBase ? "<th>Base</th>" : ""}<th>Head</th>${hasBase ? "<th>Δ</th>" : ""}<th>Chart <small title="Log scale, so small files stay visible">(log)</small>${hasBase ? ' <span class="key base">base</span> <span class="key head">head</span>' : ""}</th></tr></thead><tbody>${sizeRowsHtml}</tbody></table>` : "<p>No size changes.</p>";

	const diffsPanel = changes.text.length
		? changes.text
				.map((change) => {
					const body = change.skipped ? `<p class="note">Line diff skipped: ${escapeHtml(change.skipped)}.</p>` : renderDiffTable(change);
					return `<details open class="file"><summary><code>${escapeHtml(change.file)}</code> <span class="status ${change.status}">${change.status}</span>${change.skipped ? "" : ` <span class="add">+${change.additions}</span> <span class="del">−${change.deletions}</span>`}</summary>${body}</details>`;
				})
				.join("")
		: "<p>No text changes.</p>";

	const image = (url, label) => (url ? `<figure><img src="${escapeHtml(url)}" alt="${label}" loading="lazy"><figcaption>${label}</figcaption></figure>` : `<figure class="empty"><figcaption>${label}: not available</figcaption></figure>`);
	const visualPanel = changes.images
		.map(({ file, status, headByteSize, baseByteSize }) => {
			const urls = imageUrls.get(file) ?? {};
			return `<section class="image"><h3><code>${escapeHtml(file)}</code> <span class="status ${status}">${status}</span> <small>${escapeHtml(bytesToSize(baseByteSize))} → ${escapeHtml(bytesToSize(headByteSize))}</small></h3><div class="pair">${image(urls.base, "Base")}${image(urls.head, "Head")}</div></section>`;
		})
		.join("");

	const tabs = [["sizes", `Sizes (${rows.length})`, sizesPanel], ["diffs", `Line diffs (${changes.text.length})`, diffsPanel], ...(changes.images.length ? [["visual", `Visual diffs (${changes.images.length})`, visualPanel]] : [])];

	const { stats } = changes;
	const totalLine = hasBase ? `${escapeHtml(bytesToSize(totals.baseTotal))} → ${escapeHtml(bytesToSize(totals.headTotal))} (${escapeHtml(printChange(totals.headTotal, totals.baseTotal))})` : escapeHtml(bytesToSize(totals.headTotal));

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${context ? `<p class="meta-line">${escapeHtml(context)}</p>` : ""}
<ul class="stats"><li><b>Total</b>: ${totalLine}</li><li><b>Files</b>: ${stats.added} added, ${stats.removed} removed, ${stats.modified} modified</li><li><b>Lines</b>: <span class="add">+${stats.additions}</span> / <span class="del">−${stats.deletions}</span></li></ul>
<div role="tablist" aria-label="Report sections" hidden>${tabs.map(([id, label], i) => `<button role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${escapeHtml(label)}</button>`).join("")}</div>
${tabs.map(([id, label, html]) => `<section role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}"><h2 class="panel-title">${escapeHtml(label)}</h2>${html}</section>`).join("\n")}
</main>
<script>
(() => {
	const list = document.querySelector('[role=tablist]');
	const tabs = [...list.querySelectorAll('[role=tab]')];
	const select = (tab) => tabs.forEach((t) => {
		const on = t === tab;
		t.setAttribute('aria-selected', on);
		t.tabIndex = on ? 0 : -1;
		document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
	});
	list.hidden = false;
	document.querySelectorAll('.panel-title').forEach((h) => (h.hidden = true));
	list.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t) select(t); });
	list.addEventListener('keydown', (e) => {
		const i = tabs.indexOf(document.activeElement);
		const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
		if (next === undefined || i < 0) return;
		e.preventDefault();
		const t = tabs[(next + tabs.length) % tabs.length];
		t.focus();
		select(t);
	});
	select(tabs.find((t) => location.hash === '#' + t.id.slice(4)) ?? tabs[0]);
})();
</script>
</body>
</html>
`;
}

/** Encodes each path segment for use in a relative URL. */
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

/**
 * Files for a published report: `index.html` plus changed images (up to
 * MAX_IMAGE_SIZE each) under `images/head/` and `images/base/`.
 * @param {Omit<Parameters<typeof renderHtml>[0], "imageUrls">} options
 * @returns {import("./publish.js").ReportFile[]}
 */
export function reportFiles(options) {
	const files = [];
	const imageUrls = new Map();

	options.changes.images.forEach((image) => {
		const urls = {};
		[
			["head", image.headPath, image.headByteSize],
			["base", image.basePath, image.baseByteSize],
		].forEach(([side, path, size]) => {
			if (!path || size > MAX_IMAGE_SIZE) return;
			files.push({ path: `images/${side}/${image.file}`, content: readFileSync(path) });
			urls[side] = `images/${side}/${encodePath(image.file)}`;
		});
		imageUrls.set(image.file, urls);
	});

	files.push({ path: "index.html", content: renderHtml({ ...options, imageUrls }) });
	return files;
}
