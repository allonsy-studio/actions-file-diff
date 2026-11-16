import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_IMAGE_SIZE } from "./changes.js";
import { compareLines, deltaHtml, hunkData, pairLines, renderHtml, reportFiles, scriptJson } from "./page.js";

const stats = { added: 1, removed: 1, modified: 1, additions: 3, deletions: 1 };
const totals = { headTotal: 2048, baseTotal: 1024 };

const hunk = { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" keep", "-color: red;", "+color: blue;", "+extra", "\\ No newline at end of file"] };
const change = (file, extra = {}) => ({ file, status: "modified", additions: 2, deletions: 1, hunks: [hunk], ...extra });

const row = (file, extra = {}) => ({ packageName: "foo", packageDir: "packages/foo", file, path: `packages/foo/dist/${file}`, headByteSize: 10, baseByteSize: 5, ...extra });
const rows = [row("a.css", { headByteSize: 200, baseByteSize: 100 }), row("b.css", { headByteSize: undefined, baseByteSize: 50 }), row("c.css", { baseByteSize: 10 }), row("new.js", { packageName: "bar", packageDir: "packages/bar", path: "packages/bar/dist/new.js", baseByteSize: undefined })];

/** Parses the JSON payload embedded for a file. */
const payload = (html, id) => {
	const section = html.slice(html.indexOf(`id="${id}"`));
	const match = /<script type="application\/json">(.*?)<\/script>/s.exec(section);
	return JSON.parse(match[1]);
};

describe("deltaHtml", () => {
	it("colors growth, shrinkage and no change", () => {
		expect(deltaHtml(2048, 1024)).toBe('<span class="delta up">+1.00 KB <small>+100.0%</small></span>');
		expect(deltaHtml(512, 1024)).toBe('<span class="delta down">−0.50 KB <small>-50.0%</small></span>');
		expect(deltaHtml(5, 5)).toContain("delta same");
		expect(deltaHtml(5, undefined)).not.toContain("<small>");
	});
});

describe("compareLines", () => {
	it("returns the changed word ranges and a similarity", () => {
		const result = compareLines("color: red;", "color: blue;");
		expect(result.old).toEqual([7, 10]);
		expect(result.new).toEqual([7, 11]);
		expect(result.similarity).toBeGreaterThan(0.5);
	});

	it("ignores indentation when judging similarity", () => {
		expect(compareLines("        foo(1);", "        bar(2);").similarity).toBeLessThan(0.5);
	});

	it("gives up on unrelated and very long lines", () => {
		expect(compareLines("aaaaaaaaaa", "b")).toEqual({ similarity: 0, old: [], new: [] });
		expect(compareLines("x".repeat(1001), "x".repeat(1001)).similarity).toBe(0);
	});
});

describe("pairLines", () => {
	it("pairs the edited lines, not the first two", () => {
		const pairs = pairLines([".a{color:red}", ".b{color:blue}"], [".b{color:green}", ".c{margin:0}"]);
		expect(pairs.map(({ del, add }) => [del, add])).toEqual([[1, 0]]);
	});

	it("keeps pairs in order and skips unrelated lines", () => {
		const pairs = pairLines(["alpha = 1;", "beta = 2;", "gamma = 3;"], ["alpha = 10;", "unrelated stuff here", "gamma = 30;"]);
		expect(pairs.map(({ del, add }) => [del, add])).toEqual([
			[0, 0],
			[2, 2],
		]);
	});

	it("handles empty sides and falls back to line-by-line pairs for big runs", () => {
		expect(pairLines([], ["x"])).toEqual([]);
		expect(pairLines(["x"], [])).toEqual([]);
		const many = Array.from({ length: 30 }, (_, i) => `value${i} = ${i};`);
		const pairs = pairLines(
			many,
			many.map((l) => l.replace("= ", "= 1")),
		);
		expect(pairs).toHaveLength(30);
		expect(pairs.every(({ del, add }) => del === add)).toBe(true);
	});
});

describe("hunkData", () => {
	it("embeds the raw lines once with pairs and marks", () => {
		const data = hunkData(hunk);
		expect(data).toMatchObject({ h: "@@ -1,3 +1,3 @@", o: 1, n: 1, l: hunk.lines, p: [[1, 2]] });
		expect(data.m[1]).toEqual([7, 10]);
		expect(data.m[2]).toEqual([7, 11]);
		expect(data.m[3]).toBeUndefined();
	});

	it("pairs across a no-newline marker between the removed and added lines", () => {
		const data = hunkData({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-const x = 1", "\\ No newline at end of file", "+const x = 2"] });
		expect(data.p).toEqual([[0, 2]]);
	});

	it("has no pairs for context-only or one-sided changes", () => {
		expect(hunkData({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", " b"] }).p).toEqual([]);
		expect(hunkData({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+a", "+b"] })).toMatchObject({ p: [], m: {} });
	});
});

describe("scriptJson", () => {
	it("cannot close the script element or break a line", () => {
		const text = scriptJson({ x: "</script><!--  " });
		expect(text).not.toContain("</script>");
		expect(text).not.toContain(" ");
		expect(JSON.parse(text).x).toBe("</script><!--  ");
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
		expect(html).toContain('<span class="chip added">1 added</span>');
		expect(html).toContain("<noscript>");
	});

	it("links overview rows to their own diff by exact path", () => {
		// `index.js` is unchanged; only `sub/index.js` has a diff. The suffix match used to link both to it.
		const exact = [row("index.js", { path: "packages/foo/dist/index.js", headByteSize: 5, baseByteSize: 5 }), row("sub/index.js", { path: "packages/foo/dist/sub/index.js" })];
		const html = renderHtml({ title: "Report", rows: exact, hasBase: true, changes: { stats, text: [change("packages/foo/dist/sub/index.js")], images: [] }, totals });
		const cells = [...html.matchAll(/<td class="file-cell">(.*?)<\/td>/g)].map((m) => m[1]);
		expect(cells).toEqual(["index.js", '<a href="#f-0">sub/index.js</a>']);
	});

	it("ships each diff once as JSON and opens only what is small", () => {
		const big = change("packages/foo/dist/big.js", { hunks: [{ oldStart: 1, oldLines: 900, newStart: 1, newLines: 900, lines: Array.from({ length: 900 }, (_, i) => `+line ${i}`) }] });
		const html = renderHtml({ title: "Report", rows, hasBase: true, changes: { stats, text: [change("packages/foo/dist/a.css"), big, change("packages/foo/dist/c.css")], images: [] }, totals });
		expect(payload(html, "f-0")[0]).toMatchObject({ h: "@@ -1,3 +1,3 @@", p: [[1, 2]] });
		// The first file and the small third one open; the 900-line second one stays closed.
		expect(html.match(/<details open>/g)).toHaveLength(2);
		expect(html.match(/<details>/g)).toHaveLength(1);
		// No diff rows are written into the markup; the script builds them when a file opens.
		const markup = html.replace(/<script[\s\S]*?<\/script>/g, "");
		expect(markup).not.toContain('<table class="diff');
		expect(markup).not.toContain('<tr class="add">');
	});

	it("explains diffs that were left out and keeps their line counts", () => {
		const omitted = change("packages/foo/dist/a.css", { omitted: "the report's diff budget (10 lines) is used up", hunks: [], additions: 7, deletions: 4 });
		const html = renderHtml({ title: "Report", rows, hasBase: true, changes: { stats, text: [omitted], images: [] }, totals });
		expect(html).toContain("Diff left out because the report&#39;s diff budget (10 lines) is used up.");
		expect(html).toContain("<code>max-diff-lines</code>");
		expect(html).toContain('<span class="add">+7</span> <span class="del">−4</span>');
		expect(html).not.toContain('application/json">[');
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

	it("points content-only changes to the Code tab", () => {
		const html = renderHtml({ title: "Report", rows: [], hasBase: true, changes: { stats, text: [change("packages/foo/dist/a.css")], images: [] }, totals });
		expect(html).toContain("3 files differ in content only. See the Code tab.");
	});

	it("shows neutral status dots when there is no base", () => {
		const html = renderHtml({ title: "Report", rows, hasBase: false, changes, totals });
		expect(html).toContain('class="dot unchanged"');
		expect(html).not.toContain('class="dot added"');
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
