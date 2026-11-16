/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

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
 * @property {string} [packageDir] Package directory relative to the root.
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
	return sections.flatMap(({ name, packageDir, files }) =>
		[...files.keys()]
			.filter(isReportedFile)
			.sort()
			.map((file) => ({ packageName: name, packageDir, file, ...files.get(file) })),
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
