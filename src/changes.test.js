import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { changeStatus, collectChanges, isBinary, isImage, lineDiff } from "./changes.js";

/** Writes files under a root: { "a/b.js": "content" }. */
const tree = (root, files) => {
	const map = new Map();
	Object.entries(files).forEach(([path, content]) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
		map.set(path, Buffer.byteLength(content));
	});
	return map;
};

describe("isBinary", () => {
	it("detects NUL bytes", () => {
		expect(isBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
		expect(isBinary(Buffer.from("plain text"))).toBe(false);
	});
});

describe("isImage", () => {
	it("matches image extensions through .gz/.map layers", () => {
		expect(isImage("a/logo.png")).toBe(true);
		expect(isImage("a/icon.svg.gz")).toBe(true);
		expect(isImage("a/index.js")).toBe(false);
	});
});

describe("changeStatus", () => {
	it("classifies size pairs", () => {
		expect(changeStatus(1, undefined)).toBe("added");
		expect(changeStatus(undefined, 1)).toBe("removed");
		expect(changeStatus(1, 1)).toBe("modified");
		expect(changeStatus(undefined, undefined)).toBeUndefined();
	});
});

describe("lineDiff", () => {
	it("counts additions and deletions", () => {
		const result = lineDiff("a.css", "a\nb\nc\n", "a\nB\nc\nd\n");
		expect(result.additions).toBe(2);
		expect(result.deletions).toBe(1);
		expect(result.hunks).toHaveLength(1);
	});
});

describe("collectChanges", () => {
	let dir;
	let head;
	let base;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "changes-"));
		head = join(dir, "head");
		base = join(dir, "base");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reports added, removed and modified files with line stats", () => {
		const headMap = tree(head, { "dist/a.css": "a\nb\n", "dist/new.js": "x\n", "dist/same.js": "s\n", "dist/a.min.css": "ab" });
		const baseMap = tree(base, { "dist/a.css": "a\n", "dist/old.js": "y\nz\n", "dist/same.js": "s\n", "dist/a.min.css": "a" });

		const { text, images, stats } = collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base });

		expect(images).toEqual([]);
		expect(text.map(({ file, status }) => [file, status])).toEqual([
			["dist/a.css", "modified"],
			["dist/new.js", "added"],
			["dist/old.js", "removed"],
		]);
		expect(stats).toEqual({ added: 1, removed: 1, modified: 1, additions: 2, deletions: 2 });
	});

	it("detects content changes that keep the same size", () => {
		const headMap = tree(head, { "dist/a.js": "aaa" });
		const baseMap = tree(base, { "dist/a.js": "bbb" });
		const { text } = collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base });
		expect(text).toHaveLength(1);
		expect(text[0].additions).toBe(1);
	});

	it("skips binary and oversized files", () => {
		const headMap = tree(head, { "dist/bin.dat": Buffer.from([1, 0, 2]), "dist/big.js": "x".repeat(20) });
		const baseMap = tree(base, { "dist/bin.dat": Buffer.from([1, 0, 3]), "dist/big.js": "y".repeat(20) });
		const { text } = collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base, maxDiffSize: 10 });
		expect(Object.fromEntries(text.map(({ file, skipped }) => [file, skipped]))).toEqual({
			"dist/big.js": "file exceeds max-diff-size",
			"dist/bin.dat": "binary file",
		});
	});

	it("routes images to the visual list and gives SVG a line diff too", () => {
		const headMap = tree(head, { "dist/a.png": Buffer.from([1, 0, 9]), "dist/i.svg": "<svg>1</svg>" });
		const baseMap = tree(base, { "dist/a.png": Buffer.from([1, 0, 8]), "dist/i.svg": "<svg>2</svg>" });
		const { text, images } = collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base });
		expect(images.map(({ file }) => file)).toEqual(["dist/a.png", "dist/i.svg"]);
		expect(images[0].headPath).toBe(join(head, "dist/a.png"));
		expect(text.map(({ file }) => file)).toEqual(["dist/i.svg"]);
	});

	it("filters by extension and works without a base", () => {
		const headMap = tree(head, { "dist/a.css": "a\n", "dist/a.js": "b\n" });
		const { text, stats } = collectChanges({ headMap, headRoot: head, extensions: "css" });
		expect(text.map(({ file, status }) => [file, status])).toEqual([["dist/a.css", "added"]]);
		expect(stats.added).toBe(1);
	});
});
