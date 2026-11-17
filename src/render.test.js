import { barScale, escapeHtml, fenceFor, renderSizeChartMarkdown, renderStats, renderSummaryMarkdown, sizeRows, textBar, unifiedDiff } from "./render.js";

const stats = { added: 1, removed: 0, modified: 1, additions: 3, deletions: 1 };

const change = (file, extra = {}) => ({
	file,
	status: "modified",
	additions: 1,
	deletions: 1,
	hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }],
	...extra,
});

const rows = [
	{ packageName: "foo", file: "a.css", headByteSize: 200, baseByteSize: 100 },
	{ packageName: "foo", file: "b.css", headByteSize: undefined, baseByteSize: 50 },
];

describe("escapeHtml", () => {
	it("escapes markup characters", () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
	});
});

describe("sizeRows", () => {
	it("flattens sections and drops sibling files", () => {
		const files = new Map([
			["b.js", { headByteSize: 2 }],
			["a.js", { headByteSize: 1 }],
			["a.min.js", { headByteSize: 1 }],
		]);
		expect(sizeRows([{ name: "pkg", files }]).map(({ file }) => file)).toEqual(["a.js", "b.js"]);
	});
});

describe("barScale", () => {
	it("uses a log scale so small values stay visible", () => {
		expect(barScale(1000, 1000)).toBe(1);
		expect(barScale(0, 1000)).toBe(0);
		expect(barScale(undefined, 1000)).toBe(0);
		// Linear would be 0.0025; log keeps it near half the bar.
		expect(barScale(1000, 400000)).toBeGreaterThan(0.5);
	});
});

describe("textBar", () => {
	it("scales to the maximum with at least one block", () => {
		expect(textBar(10, 10)).toHaveLength(20);
		expect(textBar(1, 1e12).length).toBe(1);
		expect(textBar(0, 10)).toBe("");
	});
});

describe("fenceFor", () => {
	it("outgrows backtick runs in the content", () => {
		expect(fenceFor("plain")).toBe("```");
		expect(fenceFor("has ```` inside")).toBe("`````");
	});
});

describe("unifiedDiff", () => {
	it("uses /dev/null for added and removed files", () => {
		expect(unifiedDiff(change("a.js", { status: "added" }))).toMatch(/^--- \/dev\/null\n\+\+\+ b\/a\.js\n@@ -1,1 \+1,1 @@/);
		expect(unifiedDiff(change("a.js", { status: "removed" }))).toMatch(/\+\+\+ \/dev\/null/);
	});
});

describe("renderStats", () => {
	it("summarizes files, lines and images", () => {
		expect(renderStats({ stats, imageCount: 2 })).toBe("**Changed files**: 2 (1 added, 0 removed, 1 modified) · **Lines**: +3 / −1 · **Images**: 2");
	});

	it("reports no changes", () => {
		expect(renderStats({ stats: { added: 0, removed: 0, modified: 0, additions: 0, deletions: 0 } })).toBe("**Changed files**: none");
	});
});

describe("renderSizeChartMarkdown", () => {
	it("includes base columns only when there is a base", () => {
		expect(renderSizeChartMarkdown(rows, true)[0]).toBe("| Package | File | Base | Head | Δ | Chart (base / head, log) |");
		expect(renderSizeChartMarkdown(rows, false)[0]).toBe("| Package | File | Head | Chart (log) |");
		expect(renderSizeChartMarkdown([], true)).toEqual(["No size changes."]);
	});
});

describe("renderSummaryMarkdown", () => {
	it("renders sections, skipped notes and the image list", () => {
		const changes = {
			stats,
			text: [change("a.css"), change("bin.dat", { skipped: "binary file", hunks: [] })],
			images: [{ file: "i.png", status: "added", headByteSize: 10 }],
		};
		const md = renderSummaryMarkdown({ rows, hasBase: true, changes });
		expect(md).toContain("📊 Sizes");
		expect(md).toContain("📝 Line diffs (2)");
		expect(md).toContain("```diff\n--- a/a.css");
		expect(md).toContain("_Line diff skipped: binary file._");
		expect(md).toContain("#### `bin.dat` — ✏️ modified\n");
		expect(md).toContain("🖼️ Visual diffs (1)");
		expect(md).toContain("visual-diff: branch");
	});

	it("omits diffs past the budget and links the full report", () => {
		const changes = { stats, text: [change("a.css"), change("b.css")], images: [] };
		const md = renderSummaryMarkdown({ rows, hasBase: true, changes, budget: 120, reportUrl: "https://x/pr-1/" });
		expect(md).toContain("--- a/a.css");
		expect(md).not.toContain("--- a/b.css");
		expect(md).toContain("1 diff(s) omitted");
		expect(md).toContain("[full report](https://x/pr-1/)");
		expect(md).not.toContain("Visual diffs");
	});
});
