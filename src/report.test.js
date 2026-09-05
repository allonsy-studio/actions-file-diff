import { jest } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { baseExtension, buildFileRow, buildReport, commentMarker, countedSize, filterByExtensions, groupByPackage, isReportedFile, normalizeExtensions, printChange, printPercentChange, resolveMainFile, splitPath, totalSize } from "./report.js";

/** Head/base maps matching the e2e fixture. */
const HEAD = new Map([
	["packages/foo/dist/index.css", 100],
	["packages/foo/dist/index.min.css", 50],
	["packages/foo/dist/index.min.css.gz", 20],
	["packages/bar/dist/index.js", 5000],
]);
const BASE = new Map([
	["packages/foo/dist/index.css", 80],
	["packages/foo/dist/index.min.css", 40],
	["packages/bar/dist/index.js", 3000],
	["packages/bar/dist/removed.js", 10],
]);

/** Parses markdown table lines into arrays of cells. */
const tableRows = (lines) =>
	lines
		.filter((line) => line.startsWith("|"))
		.map((line) =>
			line
				.slice(1, -1)
				.split(" | ")
				.map((cell) => cell.trim()),
		);

/** Groups consecutive table lines into tables of [header, ...rows]. */
const tables = (lines) => {
	const result = [];
	let current;
	lines.forEach((line) => {
		if (line.startsWith("|")) {
			if (!current) result.push((current = []));
			current.push(line.slice(1, -1).split(" | "));
		} else current = undefined;
	});
	return result;
};

describe("commentMarker", () => {
	it("slugs the header into a marker comment", () => {
		expect(commentMarker("## File metrics")).toBe("<!-- actions-file-diff:file-metrics -->");
	});

	it("gives different headers different markers", () => {
		expect(commentMarker("## CSS")).not.toBe(commentMarker("## JS"));
	});

	it("falls back to a default slug for an empty header", () => {
		expect(commentMarker("")).toBe("<!-- actions-file-diff:default -->");
	});
});

describe("normalizeExtensions", () => {
	it("accepts multiline, comma-separated and dotted entries", () => {
		expect([...normalizeExtensions(["css, .JS", "", ".map"])]).toEqual(["css", "js", "map"]);
		expect([...normalizeExtensions("css,js")]).toEqual(["css", "js"]);
	});

	it("is empty for no input", () => {
		expect(normalizeExtensions().size).toBe(0);
		expect(normalizeExtensions([""]).size).toBe(0);
	});
});

describe("baseExtension", () => {
	it("strips map, gz and min layers", () => {
		expect(baseExtension("index.min.css.gz")).toBe("css");
		expect(baseExtension("index.js.map")).toBe("js");
		expect(baseExtension("index.min.js.map")).toBe("js");
		expect(baseExtension("a/b/index.CSS")).toBe("css");
	});

	it("is empty without an extension", () => {
		expect(baseExtension("README")).toBe("");
		expect(baseExtension("foo.min")).toBe("");
	});
});

describe("isReportedFile", () => {
	it("excludes map, gz and minified files", () => {
		expect(isReportedFile("index.css")).toBe(true);
		expect(isReportedFile("index.min.css")).toBe(false);
		expect(isReportedFile("index.min.css.gz")).toBe(false);
		expect(isReportedFile("index.css.map")).toBe(false);
		expect(isReportedFile("index.min")).toBe(false);
	});
});

describe("filterByExtensions", () => {
	it("keeps everything with an empty list", () => {
		expect(filterByExtensions(HEAD, []).size).toBe(HEAD.size);
		expect(filterByExtensions(HEAD, "").size).toBe(HEAD.size);
	});

	it("keeps only files whose base extension matches, including siblings", () => {
		const css = filterByExtensions(HEAD, ["css"]);
		expect([...css.keys()]).toEqual(["packages/foo/dist/index.css", "packages/foo/dist/index.min.css", "packages/foo/dist/index.min.css.gz"]);
		expect([...filterByExtensions(HEAD, ".JS").keys()]).toEqual(["packages/bar/dist/index.js"]);
	});
});

describe("countedSize and totalSize", () => {
	it("uses the minified sibling from the same map", () => {
		expect(countedSize("packages/foo/dist/index.css", HEAD)).toBe(50);
		expect(countedSize("packages/foo/dist/index.css", BASE)).toBe(40);
		expect(countedSize("packages/bar/dist/index.js", HEAD)).toBe(5000);
	});

	it("totals the head using minified substitution", () => {
		expect(totalSize(HEAD)).toBe(5050);
	});

	it("totals the base using the base map's minified sibling (not the head's)", () => {
		expect(totalSize(BASE)).toBe(40 + 3000 + 10);
	});

	it("ignores map files", () => {
		expect(
			totalSize(
				new Map([
					["dist/a.js", 10],
					["dist/a.js.map", 999],
				]),
			),
		).toBe(10);
	});

	it("counts files with no extension by their own size", () => {
		expect(totalSize(new Map([["dist/LICENSE", 7]]))).toBe(7);
	});
});

describe("splitPath and groupByPackage", () => {
	it("splits on the default build dir", () => {
		expect(splitPath("packages/foo/dist/css/index.css")).toEqual({ packageName: "foo", packageDir: "packages/foo", readableFilename: "css/index.css" });
	});

	it("splits on a custom build dir", () => {
		expect(splitPath("apps/web/build/app.js", "build")).toEqual({ packageName: "web", packageDir: "apps/web", readableFilename: "app.js" });
	});

	it("uses the root package when the build dir is the first segment", () => {
		expect(splitPath("build/app.js", "build")).toEqual({ packageName: ".", packageDir: ".", readableFilename: "app.js" });
	});

	it("falls back to the parent directory when the segment is absent", () => {
		expect(splitPath("lib/out/app.js", "dist")).toEqual({ packageName: "out", packageDir: "lib/out", readableFilename: "app.js" });
		expect(splitPath("app.js", "dist")).toEqual({ packageName: ".", packageDir: ".", readableFilename: "app.js" });
	});

	it("groups head and base files by package with both sizes", () => {
		const packages = groupByPackage(HEAD, BASE);
		expect([...packages.keys()]).toEqual(["packages/bar", "packages/foo"]);
		const bar = packages.get("packages/bar");
		expect(bar.name).toBe("bar");
		expect(bar.files.get("index.js")).toEqual({ headByteSize: 5000, baseByteSize: 3000 });
		expect(bar.files.get("removed.js")).toEqual({ headByteSize: undefined, baseByteSize: 10 });
		expect(packages.get("packages/foo").files.get("index.min.css.gz")).toEqual({ headByteSize: 20, baseByteSize: undefined });
	});

	it("groups with a custom build dir", () => {
		const packages = groupByPackage(new Map([["apps/web/build/app.js", 1]]), new Map(), { buildDir: "build" });
		expect(packages.get("apps/web").name).toBe("web");
		expect([...packages.get("apps/web").files.keys()]).toEqual(["app.js"]);
	});
});

describe("resolveMainFile", () => {
	let root;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "file-diff-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const writePackage = (dir, contents) => {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, dir, "package.json"), contents);
	};

	it("reads main from package.json and strips the build dir prefix", () => {
		writePackage("packages/foo", JSON.stringify({ main: "./dist/js/index.js" }));
		expect(resolveMainFile({ rootPath: root, packageDir: "packages/foo" })).toBe("js/index.js");
	});

	it("strips a custom build dir", () => {
		writePackage("packages/foo", JSON.stringify({ main: "build/app.js" }));
		expect(resolveMainFile({ rootPath: root, packageDir: "packages/foo", buildDir: "build" })).toBe("app.js");
	});

	it("ignores package.json when read-package-json is false", () => {
		writePackage("packages/foo", JSON.stringify({ main: "dist/other.css" }));
		expect(resolveMainFile({ rootPath: root, packageDir: "packages/foo", readPackageJson: false })).toBe("index.css");
	});

	it("falls back when package.json is missing or has no string main", () => {
		expect(resolveMainFile({ rootPath: root, packageDir: "packages/foo", mainFile: "main.css" })).toBe("main.css");
		writePackage("packages/foo", JSON.stringify({ main: ["x"] }));
		expect(resolveMainFile({ rootPath: root, packageDir: "packages/foo", mainFile: "main.css" })).toBe("main.css");
	});

	it("warns and falls back on malformed package.json", () => {
		writePackage("packages/foo", "{ not json");
		const core = { warning: jest.fn() };
		expect(resolveMainFile({ rootPath: root, packageDir: "packages/foo", core })).toBe("index.css");
		expect(core.warning).toHaveBeenCalledTimes(1);
	});
});

describe("printChange and printPercentChange", () => {
	it("formats direction and size", () => {
		expect(printChange(200, 100)).toMatch(/⬆ 0\.10 KB/);
		expect(printChange(100, 200)).toMatch(/⬇ 0\.10 KB/);
		expect(printChange(100, 100)).toBe("-");
	});

	it("never yields NaN for missing values", () => {
		expect(printPercentChange(undefined, 100)).toBe("");
		expect(printPercentChange(100, undefined)).toBe("");
		expect(printPercentChange(100, 0)).toBe("");
		expect(printPercentChange(100, 100)).toBe("no change");
		expect(printPercentChange(150, 100)).toBe("50.00%");
	});
});

describe("buildFileRow", () => {
	it("omits the base column when there is no base", () => {
		const files = new Map([["index.css", { headByteSize: 100, baseByteSize: undefined }]]);
		expect(buildFileRow({ readableFilename: "index.css", files, hasBase: false })).toHaveLength(4);
	});

	it("marks deleted files without NaN", () => {
		const files = new Map([["removed.js", { headByteSize: undefined, baseByteSize: 10 }]]);
		const row = buildFileRow({ readableFilename: "removed.js", files, hasBase: true });
		expect(row).toHaveLength(5);
		expect(row[1]).toBe("🚨 deleted/moved");
		expect(row.join(" ")).not.toContain("NaN");
	});

	it("marks new files", () => {
		const files = new Map([["new.js", { headByteSize: 10, baseByteSize: undefined }]]);
		const row = buildFileRow({ readableFilename: "new.js", files, hasBase: true });
		expect(row[4]).toMatch(/^🆕/);
	});
});

describe("buildReport", () => {
	it("computes totals and has-changed with a base", () => {
		const report = buildReport({ headMap: HEAD, baseMap: BASE });
		expect(report.headTotal).toBe(5050);
		expect(report.baseTotal).toBe(3050);
		expect(report.hasChanged).toBe(true);
		expect(report.text).not.toContain("NaN");
		expect(report.text).not.toContain("No change");
		expect(report.text).toContain("**Total change (Δ)**");
		expect(report.text).toContain("Size is the sum of all reported files, using the minified size where one exists.");
	});

	it("reports has-changed false and no base line without a base", () => {
		const report = buildReport({ headMap: HEAD });
		expect(report.hasBase).toBe(false);
		expect(report.hasChanged).toBe(false);
		expect(report.headTotal).toBe(5050);
		expect(report.text).toContain("No base branch to compare against.");
		expect(report.sections.map((s) => s.name)).toEqual(["bar", "foo"]);
	});

	it("keeps row cell counts equal to the header count without a base", () => {
		const report = buildReport({ headMap: HEAD });
		const found = tables([...report.summary, ...report.markdown]);
		expect(found.length).toBeGreaterThan(1);
		found.forEach((table) => {
			expect(table[0]).toHaveLength(4);
			table.forEach((row) => expect(row).toHaveLength(table[0].length));
		});
	});

	it("keeps row cell counts equal to the header count with a base", () => {
		const report = buildReport({ headMap: HEAD, baseMap: BASE });
		const found = tables([...report.summary, ...report.markdown]);
		expect(found.length).toBeGreaterThan(1);
		found.forEach((table) => {
			expect(table[0]).toHaveLength(5);
			table.forEach((row) => expect(row).toHaveLength(5));
		});
	});

	it("shows deleted and new file rows", () => {
		const head = new Map([...HEAD, ["packages/bar/dist/new.js", 7]]);
		const report = buildReport({ headMap: head, baseMap: BASE });
		const rows = tableRows(report.markdown);
		const removed = rows.find((row) => row[0] === "removed.js");
		const added = rows.find((row) => row[0] === "new.js");
		expect(removed[1]).toBe("🚨 deleted/moved");
		expect(removed[4]).toBe("⬇ 0.01 KB");
		expect(added[4]).toBe("🆕 0.01 KB");
		expect(report.text).not.toContain("NaN");
	});

	it("only prints the no-change line when the totals are equal", () => {
		const report = buildReport({ headMap: HEAD, baseMap: new Map(HEAD) });
		expect(report.hasChanged).toBe(false);
		expect(report.text).toContain("🎉 No changes detected in any packages");
		expect(report.text).not.toContain("Total change");

		// A package changed, but the totals still match.
		const base = new Map([...HEAD, ["packages/bar/dist/index.js", 5100], ["packages/foo/dist/index.min.css", 40], ["packages/foo/dist/index.css", 90]]);
		const shuffled = buildReport({ headMap: HEAD, baseMap: base });
		expect(shuffled.baseTotal).toBe(5140);
		expect(shuffled.hasChanged).toBe(true);
		expect(shuffled.text).not.toContain("No change in file sizes");

		const offset = new Map([...HEAD, ["packages/bar/dist/index.js", 5010], ["packages/foo/dist/index.min.css", 40]]);
		const balanced = buildReport({ headMap: HEAD, baseMap: offset });
		expect(balanced.hasChanged).toBe(false);
		expect(balanced.text).toContain("✅ **No change in file sizes**");
		expect(balanced.text).not.toContain("Total change");
	});

	it("only includes packages whose files differ from base", () => {
		const base = new Map([...BASE, ["packages/foo/dist/index.css", 100], ["packages/foo/dist/index.min.css", 50], ["packages/foo/dist/index.min.css.gz", 20]]);
		const report = buildReport({ headMap: HEAD, baseMap: base });
		expect(report.sections.map((s) => s.name)).toEqual(["bar"]);
		expect(report.markdown.join("\n")).not.toContain("<details>");
	});

	it("filters by extension before reporting and totalling", () => {
		const report = buildReport({ headMap: HEAD, baseMap: BASE, extensions: ["css"] });
		expect(report.headTotal).toBe(50);
		expect(report.baseTotal).toBe(40);
		expect(report.sections.map((s) => s.name)).toEqual(["foo"]);
		expect(report.text).not.toContain("index.js");
	});

	it("uses a custom build dir and bolds the main file", () => {
		const report = buildReport({ headMap: new Map([["apps/web/build/app.js", 10]]), buildDir: "build", mainFile: "app.js" });
		expect(report.sections[0].name).toBe("web");
		expect(report.markdown.join("\n")).toContain("| **app.js** |");
		expect(tableRows(report.summary).some((row) => row[0] === "web")).toBe(true);
	});

	it("reads the main file from package.json in the head root", () => {
		const root = mkdtempSync(join(tmpdir(), "file-diff-"));
		try {
			mkdirSync(join(root, "packages/bar"), { recursive: true });
			writeFileSync(join(root, "packages/bar/package.json"), JSON.stringify({ main: "dist/index.js" }));
			const report = buildReport({ headMap: HEAD, baseMap: BASE, rootPath: root });
			expect(report.sections.find((s) => s.name === "bar").mainFile).toBe("index.js");
			expect(tableRows(report.summary).some((row) => row[0] === "bar")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
