import { jest } from "@jest/globals";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { changeStatus, collectChanges, gitDiff, hasGit, isBinary, isBinaryFile, isImage, parseUnifiedDiff, sameContent } from "./changes.js";

/** Writes files under a root: { "a/b.js": "content" } and returns their sizes. */
const tree = (root, files) => {
	const map = new Map();
	Object.entries(files).forEach(([path, content]) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
		map.set(path, Buffer.byteLength(content));
	});
	return map;
};

const core = () => ({ warning: jest.fn() });

describe("isBinary / isBinaryFile / isImage", () => {
	let dir;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "changes-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("detects NUL bytes in a buffer", () => {
		expect(isBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
		expect(isBinary(Buffer.from("plain text"))).toBe(false);
	});

	it("sniffs only the start of a file", () => {
		writeFileSync(join(dir, "bin"), Buffer.from([1, 0, 2]));
		writeFileSync(join(dir, "text"), "hello\n");
		writeFileSync(join(dir, "late-nul"), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
		writeFileSync(join(dir, "empty"), "");
		expect(isBinaryFile(join(dir, "bin"))).toBe(true);
		expect(isBinaryFile(join(dir, "text"))).toBe(false);
		expect(isBinaryFile(join(dir, "late-nul"))).toBe(false);
		expect(isBinaryFile(join(dir, "empty"))).toBe(false);
		expect(() => isBinaryFile(join(dir, "missing"))).toThrow(/ENOENT/);
	});

	it("matches image extensions through .gz/.map layers", () => {
		expect(isImage("a/logo.png")).toBe(true);
		expect(isImage("a/icon.svg.gz")).toBe(true);
		expect(isImage("a/index.js")).toBe(false);
	});
});

describe("sameContent", () => {
	let dir;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "changes-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("compares bytes across chunk boundaries", () => {
		const a = Buffer.alloc(200_000, 7);
		const b = Buffer.from(a);
		const c = Buffer.from(a);
		c[c.length - 1] = 8;
		writeFileSync(join(dir, "a"), a);
		writeFileSync(join(dir, "b"), b);
		writeFileSync(join(dir, "c"), c);
		writeFileSync(join(dir, "short"), a.subarray(0, 65536));
		expect(sameContent(join(dir, "a"), join(dir, "b"))).toBe(true);
		expect(sameContent(join(dir, "a"), join(dir, "c"))).toBe(false);
		expect(sameContent(join(dir, "a"), join(dir, "short"))).toBe(false);
	});

	it("treats two empty files as equal and throws on unreadable ones", () => {
		writeFileSync(join(dir, "e1"), "");
		writeFileSync(join(dir, "e2"), "");
		expect(sameContent(join(dir, "e1"), join(dir, "e2"))).toBe(true);
		expect(() => sameContent(join(dir, "e1"), join(dir, "nope"))).toThrow(/ENOENT/);
		expect(() => sameContent(join(dir, "nope"), join(dir, "e1"))).toThrow(/ENOENT/);
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

describe("parseUnifiedDiff", () => {
	const GIT_OUTPUT = ["diff --git a/a.css b/a.css", "index 123..456 100644", "--- a/a.css", "+++ b/a.css", "@@ -1,3 +1,4 @@ .button {", " a", "-b", "+B", "+c", " d", "@@ -20 +21 @@", "-old", "\\ No newline at end of file", "+new", ""].join("\n");

	it("returns hunks and counts, ignoring file headers", () => {
		const { hunks, additions, deletions } = parseUnifiedDiff(GIT_OUTPUT);
		expect({ additions, deletions }).toEqual({ additions: 3, deletions: 2 });
		expect(hunks).toHaveLength(2);
		expect(hunks[0]).toEqual({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [" a", "-b", "+B", "+c", " d"] });
		expect(hunks[1]).toEqual({ oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: ["-old", "\\ No newline at end of file", "+new"] });
	});

	it("does not mistake content that looks like a header for one", () => {
		const { hunks, additions, deletions } = parseUnifiedDiff("@@ -1,2 +1,2 @@\n--- not a header\n+++ also content\n ctx\n");
		expect({ additions, deletions }).toEqual({ additions: 1, deletions: 1 });
		expect(hunks[0].lines).toEqual(["--- not a header", "+++ also content", " ctx"]);
	});

	it("handles empty output and a new file", () => {
		expect(parseUnifiedDiff("")).toEqual({ hunks: [], additions: 0, deletions: 0 });
		expect(parseUnifiedDiff("@@ -0,0 +1,2 @@\n+a\n+b\n").hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
	});
});

describe("git helpers", () => {
	let dir;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "changes-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("hasGit reports whether the executable runs", async () => {
		await expect(hasGit()).resolves.toBe(true);
		await expect(hasGit("definitely-not-git-xyz")).resolves.toBe(false);
	});

	it("gitDiff diffs modified, added and removed files", async () => {
		tree(dir, { "old.css": "a\nb\nc\n", "new.css": "a\nB\nc\nd\n" });
		const modified = await gitDiff({ basePath: join(dir, "old.css"), headPath: join(dir, "new.css") });
		expect({ additions: modified.additions, deletions: modified.deletions }).toEqual({ additions: 2, deletions: 1 });

		const added = await gitDiff({ headPath: join(dir, "new.css") });
		expect(added).toMatchObject({ additions: 4, deletions: 0 });
		expect(added.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0 });

		const removed = await gitDiff({ basePath: join(dir, "old.css") });
		expect(removed).toMatchObject({ additions: 0, deletions: 3 });
	});

	it("gitDiff ignores user git config", async () => {
		tree(dir, { "a.txt": "one\n", "b.txt": "two\n" });
		const result = await gitDiff({ basePath: join(dir, "a.txt"), headPath: join(dir, "b.txt") });
		expect(result.hunks[0].lines).toEqual(["-one", "+two"]);
	});

	it("gitDiff reports timeouts and missing git", async () => {
		const script = join(dir, "slow-git");
		writeFileSync(script, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 0"; exit 0; fi\nsleep 5\n');
		chmodSync(script, 0o755);
		tree(dir, { "a.txt": "one\n", "b.txt": "two\n" });
		await expect(gitDiff({ basePath: join(dir, "a.txt"), headPath: join(dir, "b.txt"), git: script, timeout: 100 })).rejects.toMatchObject({ reason: "diff timed out" });
		await expect(gitDiff({ basePath: join(dir, "a.txt"), headPath: join(dir, "b.txt"), git: "definitely-not-git-xyz" })).rejects.toMatchObject({ reason: expect.stringMatching(/git failed/) });
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

	it("reports added, removed and modified files with line stats", async () => {
		const headMap = tree(head, { "dist/a.css": "a\nb\n", "dist/new.js": "x\n", "dist/same.js": "s\n", "dist/a.min.css": "ab" });
		const baseMap = tree(base, { "dist/a.css": "a\n", "dist/old.js": "y\nz\n", "dist/same.js": "s\n", "dist/a.min.css": "a" });

		const { text, images, stats } = await collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base });

		expect(images).toEqual([]);
		expect(text.map(({ file, status }) => [file, status])).toEqual([
			["dist/a.css", "modified"],
			["dist/new.js", "added"],
			["dist/old.js", "removed"],
		]);
		expect(text.map(({ additions, deletions }) => [additions, deletions])).toEqual([
			[1, 0],
			[1, 0],
			[0, 2],
		]);
		expect(stats).toEqual({ added: 1, removed: 1, modified: 1, additions: 2, deletions: 2 });
	});

	it("detects content changes that keep the same size, and ignores identical files", async () => {
		const headMap = tree(head, { "dist/a.js": "aaa\n", "dist/b.js": "same\n" });
		const baseMap = tree(base, { "dist/a.js": "bbb\n", "dist/b.js": "same\n" });
		const { text, stats } = await collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base });
		expect(text.map(({ file }) => file)).toEqual(["dist/a.js"]);
		expect(stats.modified).toBe(1);
	});

	it("skips binary and oversized files without diffing them", async () => {
		const headMap = tree(head, { "dist/bin.dat": Buffer.from([1, 0, 2]), "dist/big.js": "x".repeat(20) });
		const baseMap = tree(base, { "dist/bin.dat": Buffer.from([1, 0, 3, 4]), "dist/big.js": "y".repeat(21) });
		const { text, stats } = await collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base, maxDiffSize: 10 });
		expect(Object.fromEntries(text.map(({ file, skipped }) => [file, skipped]))).toEqual({
			"dist/big.js": "file exceeds max-diff-size",
			"dist/bin.dat": "binary file",
		});
		expect(stats).toMatchObject({ modified: 2, additions: 0, deletions: 0 });
	});

	it("routes images to the visual list and gives SVG a line diff too", async () => {
		const headMap = tree(head, { "dist/a.png": Buffer.from([1, 0, 9]), "dist/i.svg": "<svg>1</svg>" });
		const baseMap = tree(base, { "dist/a.png": Buffer.from([1, 0, 8, 8]), "dist/i.svg": "<svg>22</svg>" });
		const { text, images } = await collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base });
		expect(images.map(({ file }) => file)).toEqual(["dist/a.png", "dist/i.svg"]);
		expect(images[0].headPath).toBe(join(head, "dist/a.png"));
		expect(text.map(({ file }) => file)).toEqual(["dist/i.svg"]);
		expect(text[0].additions).toBe(1);
	});

	it("filters by extension and works without a base", async () => {
		const headMap = tree(head, { "dist/a.css": "a\n", "dist/a.js": "b\n" });
		const { text, stats } = await collectChanges({ headMap, headRoot: head, extensions: "css" });
		expect(text.map(({ file, status }) => [file, status])).toEqual([["dist/a.css", "added"]]);
		expect(stats.added).toBe(1);
	});

	it("reports unreadable files instead of dropping them", async () => {
		// The size maps say both files exist and match in size, but neither is on disk.
		const log = core();
		const headMap = new Map([["dist/ghost.js", 3]]);
		const baseMap = new Map([["dist/ghost.js", 3]]);
		const { text, stats } = await collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base, core: log });
		expect(text).toEqual([expect.objectContaining({ file: "dist/ghost.js", status: "modified", skipped: expect.stringMatching(/^unreadable \(ENOENT\)/) })]);
		expect(stats.modified).toBe(1);
		expect(log.warning).toHaveBeenCalledWith(expect.stringContaining("dist/ghost.js"));
	});

	it("keeps line counts but drops hunks once the diff budget is spent", async () => {
		const lines = (tag) => Array.from({ length: 30 }, (_, i) => `${tag} ${i}`).join("\n") + "\n";
		const files = { "dist/a.js": lines("head-a"), "dist/b.js": lines("head-b"), "dist/c.js": lines("head-c") };
		const baseFiles = { "dist/a.js": lines("base-a"), "dist/b.js": lines("base-b"), "dist/c.js": lines("base-c") };
		const headMap = tree(head, files);
		const baseMap = tree(base, baseFiles);
		// One file is 61 lines (30 + 30 + header); a budget of 70 keeps the first only.
		const { text, stats } = await collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base, maxDiffLines: 70 });
		expect(text.map(({ hunks }) => hunks.length > 0)).toEqual([true, false, false]);
		expect(text[1].omitted).toMatch(/diff budget/);
		expect(text[1]).toMatchObject({ additions: 30, deletions: 30 });
		expect(text[1].skipped).toBeUndefined();
		expect(stats).toMatchObject({ additions: 90, deletions: 90 });
	});

	it("degrades with one warning when git is missing", async () => {
		const log = core();
		const headMap = tree(head, { "dist/a.js": "a\n", "dist/b.js": "b\n" });
		const baseMap = tree(base, { "dist/a.js": "A\n", "dist/b.js": "B\n" });
		const { text, stats } = await collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base, git: "definitely-not-git-xyz", core: log });
		expect(text.map(({ skipped }) => skipped)).toEqual(["git is not available on PATH", "git is not available on PATH"]);
		expect(stats).toMatchObject({ modified: 2, additions: 0, deletions: 0 });
		expect(log.warning).toHaveBeenCalledTimes(1);
		expect(log.warning).toHaveBeenCalledWith(expect.stringContaining("PATH"));
	});

	it("skips remaining diffs when the time budget is exhausted or a diff times out", async () => {
		const headMap = tree(head, { "dist/a.js": "a\n" });
		const baseMap = tree(base, { "dist/a.js": "A\n" });
		const spent = await collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base, diffTimeBudget: -1 });
		expect(spent.text[0].skipped).toBe("diff time budget exhausted");

		const script = join(dir, "slow-git");
		writeFileSync(script, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 0"; exit 0; fi\nsleep 5\n');
		chmodSync(script, 0o755);
		const slow = await collectChanges({ headMap, baseMap, headRoot: head, baseRoot: base, git: script, diffTimeout: 100 });
		expect(slow.text[0].skipped).toBe("diff timed out");
	});
});
