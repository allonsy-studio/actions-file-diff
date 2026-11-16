/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import { readFileSync } from "node:fs";

import { diffWordsWithSpace } from "diff";

import { MAX_IMAGE_SIZE } from "./changes.js";
import { barScale, escapeHtml as esc } from "./render.js";
import css from "./report-page.css";
import client from "./report-page.client.js";
import { bytesToSize } from "./utilities.js";

/** Longest line (chars) that gets word-level highlighting. */
const INTRALINE_LIMIT = 1000;

/**
 * @typedef {object} PageOptions
 * @property {string} title
 * @property {import("./render.js").SizeRow[]} rows
 * @property {boolean} hasBase
 * @property {ReturnType<import("./changes.js").collectChanges>} changes
 * @property {{ headTotal: number, baseTotal: number }} totals
 * @property {Map<string, { head?: string, base?: string }>} [imageUrls] File → relative image URLs.
 * @property {string} [context] Line under the title (e.g. PR and commit).
 */

/** Inline SVG icons (decorative; always paired with text). */
const ICON = {
	logo: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="12" height="12" rx="3" fill="currentColor" opacity=".35"/><rect x="9" y="9" width="12" height="12" rx="3" fill="currentColor"/></svg>',
	side: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="8" height="14" rx="1.5"/><rect x="13" y="5" width="8" height="14" rx="1.5"/></svg>',
	overlay: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="13" height="13" rx="1.5"/><rect x="8" y="8" width="13" height="13" rx="1.5"/></svg>',
	swipe: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M12 3v18"/></svg>',
	diff: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></svg>',
	prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
	next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
	chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
};

/**
 * Splits a path into a muted directory part and the file name.
 * @param {string} path
 * @returns {string}
 */
const pathHtml = (path) => {
	const i = path.lastIndexOf("/");
	const inner = i === -1 ? `<span class="name">${esc(path)}</span>` : `<span class="dir">${esc(path.slice(0, i + 1))}</span><span class="name">${esc(path.slice(i + 1))}</span>`;
	return `<bdi>${inner}</bdi>`;
};

/**
 * Size change as a colored delta with percentage.
 * @param {number|undefined} head
 * @param {number|undefined} base
 * @returns {string}
 */
export function deltaHtml(head, base) {
	const d = (head ?? 0) - (base ?? 0);
	if (d === 0) return '<span class="delta same">—</span>';
	const percent = head != null && base ? ` <small>${d > 0 ? "+" : ""}${((d / base) * 100).toFixed(1)}%</small>` : "";
	return `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "+" : "−"}${esc(bytesToSize(Math.abs(d)))}${percent}</span>`;
}

/**
 * Change status for a pair of sizes.
 * @param {number|undefined} head
 * @param {number|undefined} base
 * @param {boolean} hasBase
 * @returns {"added"|"removed"|"modified"|"unchanged"}
 */
const rowStatus = (head, base, hasBase) => {
	if (!hasBase) return "unchanged";
	if (base == null) return "added";
	if (head == null) return "removed";
	return head === base ? "unchanged" : "modified";
};

/** Smallest similarity (0–1) at which a removed and an added line are shown as an edit of one another. */
const PAIR_THRESHOLD = 0.5;

/** Most removed × added line pairs compared when matching a run of changes. */
const PAIR_LIMIT = 400;

/** Non-whitespace characters in a string. */
const solid = (text) => text.replace(/\s+/g, "").length;

/**
 * Word-level comparison of two lines. Similarity is the share of non-whitespace
 * characters the lines have in common, so indentation can't make unrelated
 * lines look alike.
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ similarity: number, old: number[], new: number[] }} Changed ranges as flat `[start, end, …]` offsets.
 */
export function compareLines(oldText, newText) {
	const none = { similarity: 0, old: [], new: [] };
	if (oldText.length > INTRALINE_LIMIT || newText.length > INTRALINE_LIMIT) return none;
	const longest = Math.max(1, solid(oldText), solid(newText));
	// Common characters can't exceed the shorter line, which bounds the similarity cheaply.
	if (Math.min(solid(oldText), solid(newText)) / longest < PAIR_THRESHOLD) return none;

	const old = [];
	const next = [];
	let oldAt = 0;
	let newAt = 0;
	let common = 0;
	const push = (ranges, start, end) => (ranges.length > 0 && ranges.at(-1) === start ? (ranges[ranges.length - 1] = end) : ranges.push(start, end));

	diffWordsWithSpace(oldText, newText).forEach(({ added, removed, value }) => {
		if (added) {
			push(next, newAt, newAt + value.length);
			newAt += value.length;
		} else if (removed) {
			push(old, oldAt, oldAt + value.length);
			oldAt += value.length;
		} else {
			common += solid(value);
			oldAt += value.length;
			newAt += value.length;
		}
	});

	return { similarity: common / longest, old, new: next };
}

/**
 * Matches removed lines to the added lines they were edited into. Chooses the
 * order-preserving set of pairs with the highest total similarity, so an
 * inserted or deleted line doesn't shift every pairing after it.
 * @param {string[]} oldTexts
 * @param {string[]} newTexts
 * @returns {Array<{ del: number, add: number, old: number[], new: number[] }>} Indexes into the two arrays.
 */
export function pairLines(oldTexts, newTexts) {
	if (oldTexts.length === 0 || newTexts.length === 0) return [];

	const cells = new Map();
	const score = (i, j) => {
		const key = i * newTexts.length + j;
		if (!cells.has(key)) cells.set(key, compareLines(oldTexts[i], newTexts[j]));
		return cells.get(key);
	};

	// Too many combinations to compare all of them: pair line by line instead.
	if (oldTexts.length * newTexts.length > PAIR_LIMIT) {
		const pairs = [];
		for (let k = 0; k < Math.min(oldTexts.length, newTexts.length); k++) {
			const { similarity, old, new: next } = score(k, k);
			if (similarity >= PAIR_THRESHOLD) pairs.push({ del: k, add: k, old, new: next });
		}
		return pairs;
	}

	const rows = oldTexts.length + 1;
	const cols = newTexts.length + 1;
	const best = Array.from({ length: rows }, () => new Array(cols).fill(0));
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const { similarity } = score(i - 1, j - 1);
			best[i][j] = Math.max(best[i - 1][j], best[i][j - 1], similarity >= PAIR_THRESHOLD ? best[i - 1][j - 1] + similarity : 0);
		}
	}

	const pairs = [];
	for (let i = rows - 1, j = cols - 1; i > 0 && j > 0; ) {
		const { similarity, old, new: next } = score(i - 1, j - 1);
		if (similarity >= PAIR_THRESHOLD && best[i][j] === best[i - 1][j - 1] + similarity) {
			pairs.push({ del: i - 1, add: j - 1, old, new: next });
			i--;
			j--;
		} else if (best[i][j] === best[i - 1][j]) i--;
		else j--;
	}
	return pairs.reverse();
}

/**
 * Hunk data for the browser: the raw lines once, the matched removed/added
 * pairs, and the changed word ranges. The page builds table rows from this when
 * a file is opened, which keeps the HTML about as large as the diff itself.
 * @param {import("./changes.js").Hunk} hunk
 * @returns {{ h: string, o: number, n: number, l: string[], p: number[][], m: Record<number, number[]> }}
 *   `p` pairs `[removedLineIndex, addedLineIndex]`; `m` maps a line index to `[start, end, …]` offsets in its text (after the sign).
 */
export function hunkData({ oldStart, oldLines, newStart, newLines, lines }) {
	const p = [];
	const m = {};

	for (let i = 0; i < lines.length; ) {
		if (lines[i][0] !== "-" && lines[i][0] !== "+") {
			i++;
			continue;
		}
		const dels = [];
		const adds = [];
		while (lines[i]?.[0] === "-") dels.push(i++);
		// A "\ No newline" marker can sit between the removed and added lines.
		if (dels.length > 0 && lines[i]?.[0] === "\\") i++;
		while (lines[i]?.[0] === "+") adds.push(i++);

		pairLines(
			dels.map((k) => lines[k].slice(1)),
			adds.map((k) => lines[k].slice(1)),
		).forEach((pair) => {
			p.push([dels[pair.del], adds[pair.add]]);
			if (pair.old.length) m[dels[pair.del]] = pair.old;
			if (pair.new.length) m[adds[pair.add]] = pair.new;
		});
	}

	return { h: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, o: oldStart, n: newStart, l: lines, p, m };
}

/**
 * JSON safe to place inside a `<script>` element.
 * @param {unknown} value
 * @returns {string}
 */
export const scriptJson = (value) =>
	JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");

/**
 * Summary cards at the top of the page.
 * @param {PageOptions} options
 * @returns {string}
 */
function renderCards({ hasBase, changes, totals }) {
	const { stats } = changes;
	const files = stats.added + stats.removed + stats.modified;
	const lines = stats.additions + stats.deletions;
	const addShare = lines ? (stats.additions / lines) * 100 : 0;
	const chip = (n, label, cls) => (n ? `<span class="chip ${cls}">${n} ${label}</span>` : "");

	return `<section class="cards" aria-label="Summary">
<article class="card"><h2>Total size</h2><p class="metric">${esc(bytesToSize(totals.headTotal))}</p><p class="sub">${hasBase ? `${esc(bytesToSize(totals.baseTotal))} on base ${deltaHtml(totals.headTotal, totals.baseTotal)}` : "No base to compare"}</p></article>
<article class="card"><h2>Files changed</h2><p class="metric">${files}</p><p class="sub chips">${chip(stats.added, "added", "added") + chip(stats.removed, "removed", "removed") + chip(stats.modified, "modified", "modified") || "No changes"}</p></article>
<article class="card"><h2>Lines</h2><p class="metric"><span class="add">+${stats.additions}</span> <span class="del">−${stats.deletions}</span></p><p class="sub"><span class="ratio" role="img" aria-label="${stats.additions} added, ${stats.deletions} removed"><span style="inline-size:${addShare.toFixed(1)}%"></span></span></p></article>
<article class="card"><h2>Visual</h2><p class="metric">${changes.images.length}</p><p class="sub">${changes.images.length === 1 ? "image" : "images"} changed</p></article>
</section>`;
}

/**
 * Overview panel: sizes grouped by package.
 * @param {PageOptions} options
 * @param {Map<string, string>} anchors Change path → element id.
 * @returns {string}
 */
function renderOverview({ rows, hasBase, changes }, anchors) {
	if (rows.length === 0) {
		const { added, removed, modified } = changes.stats;
		const files = added + removed + modified;
		return `<p class="empty-state">No size changes.${files > 0 ? ` ${files} ${files === 1 ? "file differs" : "files differ"} in content only. See the Code tab.` : ""}</p>`;
	}
	const max = Math.max(1, ...rows.flatMap(({ headByteSize, baseByteSize }) => [headByteSize ?? 0, baseByteSize ?? 0]));
	const pct = (v) => `${(barScale(v, max) * 100).toFixed(1)}%`;

	const groups = new Map();
	rows.forEach((row) => {
		const key = row.packageDir ?? row.packageName;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(row);
	});

	const body = [...groups.values()]
		.map((group) => {
			const { packageName } = group[0];
			const head = group.reduce((sum, r) => sum + (r.headByteSize ?? 0), 0);
			const base = group.reduce((sum, r) => sum + (r.baseByteSize ?? 0), 0);
			const header = `<tr class="pkg"><th scope="rowgroup" colspan="2">${esc(packageName)} <span class="muted">${group.length} ${group.length === 1 ? "file" : "files"}</span></th>${hasBase ? `<td class="num">${esc(bytesToSize(base))}</td>` : ""}<td class="num">${esc(bytesToSize(head))}</td>${hasBase ? `<td class="num">${deltaHtml(head, base)}</td>` : ""}<td></td></tr>`;
			const items = group.map(({ file, path, headByteSize, baseByteSize }) => {
				const status = rowStatus(headByteSize, baseByteSize, hasBase);
				const name = anchors.has(path) ? `<a href="#${anchors.get(path)}">${esc(file)}</a>` : esc(file);
				const bars = `${hasBase ? `<span class="bar base" style="inline-size:${pct(baseByteSize)}"></span>` : ""}<span class="bar head" style="inline-size:${pct(headByteSize)}"></span>`;
				return `<tr><td><span class="dot ${status}" title="${status}"></span><span class="sr-only">${status}</span></td><td class="file-cell">${name}</td>${hasBase ? `<td class="num">${esc(bytesToSize(baseByteSize))}</td>` : ""}<td class="num">${esc(bytesToSize(headByteSize))}</td>${hasBase ? `<td class="num">${deltaHtml(headByteSize, baseByteSize)}</td>` : ""}<td class="chart" aria-hidden="true">${bars}</td></tr>`;
			});
			return `<tbody>${header}${items.join("")}</tbody>`;
		})
		.join("");

	return `<div class="table-card"><table class="sizes">
<thead><tr><th scope="col"><span class="sr-only">Status</span></th><th scope="col">File</th>${hasBase ? '<th scope="col" class="num">Base</th>' : ""}<th scope="col" class="num">Head</th>${hasBase ? '<th scope="col" class="num">Change</th>' : ""}<th scope="col" class="chart">Size <span class="muted">(log)</span>${hasBase ? ' <span class="key base">base</span><span class="key head">head</span>' : ""}</th></tr></thead>
${body}</table></div>`;
}

/**
 * Sticky file list shared by the code and visual panels.
 * @param {Array<{ id: string, file: string, status: string, meta: string }>} items
 * @param {string} label
 * @param {boolean} [buttons] Render buttons (visual) instead of links (code).
 * @returns {string}
 */
function renderFileList(items, label, buttons = false) {
	const entries = items.map(({ id, file, status, meta }, i) => {
		const inner = `<span class="dot ${status}" title="${status}"></span><span class="path">${pathHtml(file)}</span><span class="meta">${meta}</span>`;
		return `<li>${buttons ? `<button type="button" data-target="${id}"${i === 0 ? ' aria-current="true"' : ""}>${inner}</button>` : `<a href="#${id}">${inner}</a>`}</li>`;
	});
	return `<nav class="filelist" aria-label="${esc(label)}"><ul>${entries.join("")}</ul></nav>`;
}

/** Diff lines shown open on load, so small diffs are visible without a click. */
const OPEN_LINES = 800;

/**
 * Code panel: file list and per-file diffs with a unified/split toggle. Each
 * diff ships as JSON and is turned into rows when its `<details>` opens.
 * @param {PageOptions} options
 * @param {Map<string, string>} anchors
 * @returns {string}
 */
function renderCode({ changes }, anchors) {
	if (changes.text.length === 0) return '<p class="empty-state">No text changes.</p>';
	const counts = (c) => (c.skipped ? '<span class="muted">skipped</span>' : `<span class="add">+${c.additions}</span> <span class="del">−${c.deletions}</span>`);

	const list = renderFileList(
		changes.text.map((c) => ({ id: anchors.get(c.file), file: c.file, status: c.status, meta: counts(c) })),
		"Changed files",
	);

	let shown = 0;
	const files = changes.text
		.map((c, i) => {
			const size = c.hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0);
			const open = c.hunks.length > 0 && (i === 0 || shown + size <= OPEN_LINES);
			if (open) shown += size;

			let body;
			if (c.skipped) body = `<p class="note">Line diff skipped: ${esc(c.skipped)}.</p>`;
			else if (c.omitted) body = `<p class="note">Diff left out because ${esc(c.omitted)}. Raise <code>max-diff-lines</code> to include it.</p>`;
			else if (c.hunks.length === 0) body = '<p class="note">No line changes.</p>';
			else body = `<div class="diff-scroll"><script type="application/json">${scriptJson(c.hunks.map(hunkData))}</script></div>`;

			return `<section class="file" id="${anchors.get(c.file)}"><details${open ? " open" : ""}><summary><span class="chev">${ICON.chevron}</span><span class="pill ${c.status}">${c.status}</span><span class="path">${pathHtml(c.file)}</span><span class="meta">${counts(c)}</span></summary>${body}</details></section>`;
		})
		.join("");

	return `<div class="layout">${list}<div class="main code-main" data-view="unified">
<div class="toolbar" role="toolbar" aria-label="Diff options">
<div class="segmented" role="group" aria-label="Diff layout"><button type="button" data-view="unified" aria-pressed="true">Unified</button><button type="button" data-view="split" aria-pressed="false">Split</button></div>
<span class="spacer"></span>
<button type="button" class="ghost" data-action="collapse">Collapse all</button>
</div>
<noscript><p class="note">Diffs are drawn by script. Enable JavaScript to see them.</p></noscript>
${files}</div></div>`;
}

/**
 * Visual panel: image list and a compare viewer.
 * @param {PageOptions} options
 * @returns {string}
 */
function renderVisual({ changes, imageUrls = new Map() }) {
	if (changes.images.length === 0) return "";

	const items = changes.images.map((img, i) => ({ ...img, id: `img-${i}`, urls: imageUrls.get(img.file) ?? {} }));
	const list = renderFileList(
		items.map(({ id, file, status, baseByteSize, headByteSize }) => ({ id, file, status, meta: deltaHtml(headByteSize, baseByteSize) })),
		"Changed images",
		true,
	);

	const figure = (side, url) => (url ? `<figure class="layer ${side}"><img src="${esc(url)}" alt="${side === "base" ? "Base" : "Head"} version" decoding="async" data-side="${side}"><figcaption>${side === "base" ? "Base" : "Head"}</figcaption></figure>` : `<figure class="layer ${side} missing"><figcaption>${side === "base" ? "Base" : "Head"}: not available</figcaption></figure>`);

	const viewers = items
		.map(({ id, file, status, urls, baseByteSize, headByteSize }, i) => {
			const single = !(urls.base && urls.head);
			return `<section class="image-item" id="${id}"${i ? " hidden" : ""}${single ? " data-single" : ""} aria-label="${esc(file)}">
<header class="image-head"><span class="pill ${status}">${status}</span><span class="path">${pathHtml(file)}</span><span class="meta">${esc(bytesToSize(baseByteSize))} → ${esc(bytesToSize(headByteSize))} ${deltaHtml(headByteSize, baseByteSize)}</span><span class="meta dims"><span data-dims="base"></span><span data-dims="head"></span></span></header>
<div class="stage"><div class="layers">${figure("base", urls.base)}${figure("head", urls.head)}<span class="divider" aria-hidden="true"></span><span class="tag tag-base" aria-hidden="true">Base</span><span class="tag tag-head" aria-hidden="true">Head</span></div></div>
${single ? `<p class="note">${status === "added" ? "New image: there's no base version to compare." : status === "removed" ? "Removed image: there's no head version to compare." : "Only one version could be included."}</p>` : ""}
</section>`;
		})
		.join("");

	const button = (attr, value, label, pressed, icon = "") => `<button type="button" data-${attr}="${value}" aria-pressed="${pressed}" title="${label}">${icon}<span>${label}</span></button>`;

	return `<div class="layout">${list}<div class="main viewer" data-mode="side" data-bg="checker" data-zoom="fit" style="--opacity:0.5;--pos:50%">
<div class="toolbar" role="toolbar" aria-label="Compare options">
<div class="segmented modes" role="group" aria-label="Compare mode">${button("mode", "side", "Side by side", true, ICON.side)}${button("mode", "overlay", "Overlay", false, ICON.overlay)}${button("mode", "swipe", "Swipe", false, ICON.swipe)}${button("mode", "diff", "Difference", false, ICON.diff)}</div>
<span class="spacer"></span>
<div class="segmented" role="group" aria-label="Background">${button("bg", "checker", "Checker", true)}${button("bg", "light", "Light", false)}${button("bg", "dark", "Dark", false)}</div>
<div class="segmented" role="group" aria-label="Zoom">${button("zoom", "fit", "Fit", true)}${button("zoom", "1", "1×", false)}${button("zoom", "2", "2×", false)}${button("zoom", "4", "4×", false)}</div>
</div>
<div class="sliders">
<label class="slider-field opacity-field">Head opacity <input type="range" min="0" max="100" value="50" data-control="opacity"> <output>50%</output></label>
<label class="slider-field swipe-field">Swipe position <input type="range" min="0" max="100" value="50" data-control="pos"> <output>50%</output></label>
<p class="hint diff-hint">Matching pixels turn black; changes stay bright.</p>
<p class="hint side-hint">Use Overlay, Swipe or Difference to compare in place.</p>
</div>
${viewers}
<div class="pager"><button type="button" class="ghost" data-step="-1">${ICON.prev}<span>Previous</span></button><span class="pager-count" aria-live="polite">1 of ${items.length}</span><button type="button" class="ghost" data-step="1"><span>Next</span>${ICON.next}</button><span class="hint"><kbd>J</kbd> / <kbd>K</kbd> to switch images</span></div>
</div></div>`;
}

/**
 * Self-contained HTML report: summary cards, then Overview, Code and (when
 * images changed) Visual tabs. Without JavaScript, the Overview tab shows.
 * @param {PageOptions} options
 * @returns {string}
 */
export function renderHtml(options) {
	const { title, rows, changes, context = "" } = options;
	const anchors = new Map(changes.text.map((c, i) => [c.file, `f-${i}`]));

	const tabs = [["overview", "Overview", rows.length, renderOverview(options, anchors)], ["code", "Code", changes.text.length, renderCode(options, anchors)], ...(changes.images.length ? [["visual", "Visual", changes.images.length, renderVisual(options)]] : [])];

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
${css}
</style>
</head>
<body>
<header class="topbar"><div class="wrap topbar-inner"><span class="brand">${ICON.logo}<span>${esc(title)}</span></span>${context ? `<span class="context">${esc(context)}</span>` : ""}</div></header>
<main class="wrap">
${renderCards(options)}
<div class="tabs">
<div class="tablist" role="tablist" aria-label="Report sections">${tabs.map(([id, label, count], i) => `<button type="button" role="tab" id="tab-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${label}<span class="count">${count}</span></button>`).join("")}</div>
${tabs.map(([id, , , html], i) => `<div role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}"${i ? ' hidden="until-found"' : ""}><div class="panel">${html}</div></div>`).join("\n")}
</div>
</main>
<footer class="wrap footer">Generated by <a href="https://github.com/allonsy-studio/actions-file-diff">actions-file-diff</a></footer>
<script>
${client}
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
 * @param {Omit<PageOptions, "imageUrls">} options
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
