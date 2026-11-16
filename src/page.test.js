import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_IMAGE_SIZE } from "./changes.js";
import { deltaHtml, intraline, renderDiff, renderHtml, reportFiles, walkHunk } from "./page.js";

const stats = { added: 1, removed: 1, modified: 1, additions: 3, deletions: 1 };
const totals = { headTotal: 2048, baseTotal: 1024 };

const hunk = { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" keep", "-color: red;", "+color: blue;", "+extra", "\\ No newline at end of file"] };
const change = (file, extra = {}) => ({ file, status: "modified", additions: 2, deletions: 1, hunks: [hunk], ...extra });

const rows = [
	{ packageName: "foo", packageDir: "packages/foo", file: "a.css", headByteSize: 200, baseByteSize: 100 },
	{ packageName: "foo", packageDir: "packages/foo", file: "b.css", headByteSize: undefined, baseByteSize: 50 },
	{ packageName: "foo", packageDir: "packages/foo", file: "c.css", headByteSize: 10, baseByteSize: 10 },
	{ packageName: "bar", packageDir: "packages/bar", file: "new.js", headByteSize: 5, baseByteSize: undefined },
];

describe("deltaHtml", () => {
	it("colors growth, shrinkage and no change", () => {
		expect(deltaHtml(2048, 1024)).toBe('<span class="delta up">+1.00 KB <small>+100.0%</small></span>');
		expect(deltaHtml(512, 1024)).toBe('<span class="delta down">−0.50 KB <small>-50.0%</small></span>');
		expect(deltaHtml(5, 5)).toContain("delta same");
		expect(deltaHtml(5, undefined)).not.toContain("<small>");
	});
});

describe("intraline", () => {
	it("marks only the changed words", () => {
		expect(intraline("color: red;", "color: blue;")).toEqual(["color: <mark>red</mark>;", "color: <mark>blue</mark>;"]);
	});

	it("escapes and skips very long lines", () => {
		const long = "<".repeat(1001);
		expect(intraline(long, "x")).toEqual(["&lt;".repeat(1001), "x"]);
	});
});

describe("walkHunk", () => {
	it("numbers lines and pairs removals with additions", () => {
		const { lines, pairs } = walkHunk(hunk);
		expect(lines.map(({ type, oldNo, newNo }) => [type, oldNo, newNo])).toEqual([
			["ctx", 1, 1],
			["del", 2, undefined],
			["add", undefined, 2],
			["add", undefined, 3],
			["meta", undefined, undefined],
		]);
		expect(pairs[1][0].html).toContain("<mark>");
		expect(pairs[2][0]).toBeUndefined();
		expect(pairs[2][1].html).toBe("extra");
	});
});

describe("renderDiff", () => {
	it("renders unified and split tables", () => {
		const html = renderDiff([hunk]);
		expect(html).toContain('<table class="diff unified">');
		expect(html).toContain('<table class="diff split">');
		expect(html).toContain("@@ -1,3 +1,3 @@");
		expect(html).toContain('<td class="ln empty"></td>');
		expect(html).toContain("\\ No newline at end of file");
	});
});

describe("renderHtml", () => {
	const changes = { stats, text: [change("packages/foo/dist/a.css"), change("packages/foo/dist/<x>.bin", { skipped: "binary file", hunks: [] })], images: [] };

	it("renders cards, tabs and escaped content without a visual tab", () => {
		const html = renderHtml({ title: "Report", rows, hasBase: true, changes, totals, context: "o/r#1" });
		expect(html).toContain('id="tab-overview" aria-selected="true"');
		expect(html).toContain('id="panel-code" aria-labelledby="tab-code" hidden="until-found"');
		expect(html).not.toContain('id="tab-visual"');
		expect(html).toContain("&lt;x&gt;.bin");
		expect(html).not.toContain("<x>.bin");
		expect(html).toContain("Line diff skipped: binary file.");
		expect(html).toContain("o/r#1");
		expect(html).toContain('<a href="#f-0">a.css</a>');
		expect(html).toContain('class="dot unchanged"');
		expect(html).toContain('<span class="chip added">1 added</span>');
	});

	it("adds the visual tab with compare controls and image URLs", () => {
		const images = [
			{ file: "i.png", status: "modified", headByteSize: 2, baseByteSize: 1 },
			{ file: "new.png", status: "added", headByteSize: 2 },
			{ file: "gone.png", status: "removed", baseByteSize: 2 },
		];
		const imageUrls = new Map([
			["i.png", { head: "images/head/i.png", base: "images/base/i.png" }],
			["new.png", { head: "images/head/new.png" }],
			["gone.png", { base: "images/base/gone.png" }],
		]);
		const html = renderHtml({ title: "Report", rows, hasBase: true, changes: { ...changes, images }, totals, imageUrls });
		expect(html).toContain('id="tab-visual"');
		expect(html).toContain('data-mode="swipe"');
		expect(html).toContain('data-control="opacity"');
		expect(html).toContain('src="images/head/i.png"');
		expect(html).toContain('id="img-1" hidden data-single');
		expect(html).toContain("New image: there's no base version to compare.");
		expect(html).toContain("Removed image: there's no head version to compare.");
	});

	it("handles no base and empty changes", () => {
		const empty = { stats: { added: 0, removed: 0, modified: 0, additions: 0, deletions: 0 }, text: [], images: [] };
		const html = renderHtml({ title: "Report", rows: [], hasBase: false, changes: empty, totals });
		expect(html).toContain("No base to compare");
		expect(html).toContain("No size changes.");
		expect(html).toContain("No text changes.");
	});
});

describe("reportFiles", () => {
	let dir;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "report-files-"));
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("returns the page plus images, skipping oversized ones", () => {
		writeFileSync(join(dir, "head.png"), "head");
		writeFileSync(join(dir, "base.png"), "base");
		const images = [
			{ file: "a b/logo.png", status: "modified", headByteSize: 4, baseByteSize: 4, headPath: join(dir, "head.png"), basePath: join(dir, "base.png") },
			{ file: "big.png", status: "added", headByteSize: MAX_IMAGE_SIZE + 1, headPath: join(dir, "head.png") },
		];
		const files = reportFiles({ title: "Report", rows, hasBase: true, changes: { stats, text: [], images }, totals });

		expect(files.map(({ path }) => path)).toEqual(["images/head/a b/logo.png", "images/base/a b/logo.png", "index.html"]);
		expect(String(files[0].content)).toBe("head");
		const html = String(files.at(-1).content);
		expect(html).toContain('src="images/head/a%20b/logo.png"');
		expect(html).toContain("Head: not available");
	});
});
