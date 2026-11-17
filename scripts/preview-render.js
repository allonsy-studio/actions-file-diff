/**
 * Renders the preview fixture through the same pipeline as the action.
 * Bundled by scripts/preview.js (esbuild loads the stylesheet as text).
 * @module
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { collectChanges } from "../src/changes.js";
import { reportFiles } from "../src/page.js";
import { renderStats, renderSummaryMarkdown, sizeRows } from "../src/render.js";
import { buildReport } from "../src/report.js";
import { fetchFilesAndSizes } from "../src/utilities.js";

const quiet = { info() {}, warning() {}, startGroup() {}, endGroup() {} };

/** Injected into preview pages: variant links, plus live reload when served. */
const toolbar = (live) => `<nav style="position:fixed;bottom:12px;right:12px;display:flex;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);font-size:12px">Preview: <a href="../base/">base</a><a href="../no-base/">no base</a><a href="comment.md">comment.md</a><a href="summary.md">summary.md</a></nav>` + (live ? `<script>new EventSource("/__reload").onmessage = () => location.reload();</script>` : "");

/**
 * Writes one report variant to `outDir`.
 * @param {object} options
 * @param {string} options.outDir
 * @param {string} options.head
 * @param {string} [options.base]
 * @param {string} options.title
 * @param {boolean} [options.live] Inject the live-reload snippet.
 */
async function writeVariant({ outDir, head, base, title, live }) {
	const glob = ["**/dist/**"];
	const headMap = await fetchFilesAndSizes(head, glob, { core: quiet });
	const baseMap = await fetchFilesAndSizes(base, glob, { core: quiet, required: false });
	const hasBase = baseMap.size > 0;

	const report = buildReport({ headMap, baseMap, hasBase, rootPath: head, core: quiet });
	// A budget the largest sample file exceeds, so the preview also shows a diff that was left out.
	const changes = await collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base, maxDiffLines: 2500, core: quiet });
	const rows = sizeRows(report.sections);
	const totals = { headTotal: report.headTotal, baseTotal: report.baseTotal };

	rmSync(outDir, { recursive: true, force: true });
	reportFiles({ title, rows, hasBase, changes, totals, context: "preview/repo#123 @ abc1234" }).forEach(({ path, content }) => {
		const file = join(outDir, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, path === "index.html" ? String(content).replace("</body>", `${toolbar(live)}\n</body>`) : content);
	});

	const stats = renderStats({ stats: changes.stats, imageCount: changes.images.length });
	writeFileSync(join(outDir, "comment.md"), ["## File metrics", "", `${stats}<br/>`, "📊 [View the visual diff](./)", "", report.text].join("\n"));
	writeFileSync(join(outDir, "summary.md"), ["## File metrics", "", stats, "", report.text, "", renderSummaryMarkdown({ rows, hasBase, changes })].join("\n"));
}

/**
 * Renders `<outDir>/base/` and `<outDir>/no-base/`, plus a root redirect.
 * @param {{ outDir: string, head: string, base: string, live?: boolean }} options
 */
export async function render({ outDir, head, base, live = false }) {
	await writeVariant({ outDir: join(outDir, "base"), head, base, title: "File metrics", live });
	await writeVariant({ outDir: join(outDir, "no-base"), head, title: "File metrics (no base)", live });
	writeFileSync(join(outDir, "index.html"), '<!doctype html><meta http-equiv="refresh" content="0; url=base/">');
}
