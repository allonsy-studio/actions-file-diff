import { jest } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bytesToSize, fetchFilesAndSizes, globPatterns } from "./utilities.js";

describe("bytesToSize", () => {
	it("returns '0' for a zero-byte file", () => {
		expect(bytesToSize(0)).toBe("0");
	});

	it("returns '-' for nullish input", () => {
		expect(bytesToSize(undefined)).toBe("-");
		expect(bytesToSize(null)).toBe("-");
	});

	it("uses '< 0.01 KB' for values that round to zero", () => {
		expect(bytesToSize(1)).toBe("< 0.01 KB");
	});

	it("formats sub-KB values", () => {
		expect(bytesToSize(512)).toBe("0.50 KB");
	});

	it("formats KB values", () => {
		expect(bytesToSize(2048)).toBe("2.00 KB");
	});

	it("formats MB values", () => {
		expect(bytesToSize(5 * 1024 * 1024)).toBe("5.00 MB");
	});

	it("formats GB values", () => {
		expect(bytesToSize(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
	});
});

describe("bytesToSize consistency", () => {
	it("uses 1024-based units at every scale", () => {
		expect(bytesToSize(1024)).toBe("1.00 KB");
		expect(bytesToSize(1023)).toBe("1.00 KB");
		expect(bytesToSize(1024 * 1024)).toBe("1.00 MB");
		expect(bytesToSize(1536)).toBe("1.50 KB");
	});
});

describe("globPatterns", () => {
	it("prefixes patterns with the root and keeps negations", () => {
		expect(globPatterns("/root", ["**/dist/**", "", " !base/** ", "!**/node_modules/**"])).toEqual(["/root/**/dist/**", "!/root/base/**", "!/root/**/node_modules/**"]);
	});
});

describe("fetchFilesAndSizes", () => {
	let root;
	const core = () => ({ info: jest.fn(), warning: jest.fn(), startGroup: jest.fn(), endGroup: jest.fn() });

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "file-diff-"));
		mkdirSync(join(root, "pkg/dist/nested"), { recursive: true });
		mkdirSync(join(root, "pkg/node_modules"), { recursive: true });
		writeFileSync(join(root, "pkg/dist/index.css"), "abc");
		writeFileSync(join(root, "pkg/dist/nested/a.js"), "abcd");
		writeFileSync(join(root, "pkg/README.md"), "x");
		writeFileSync(join(root, "pkg/node_modules/x.js"), "x");
		mkdirSync(join(root, "base/dist"), { recursive: true });
		writeFileSync(join(root, "base/dist/index.css"), "abcde");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("maps relative paths to sizes", async () => {
		const log = core();
		const files = await fetchFilesAndSizes(root, ["**/dist/**"], { core: log });
		expect([...files.entries()].sort()).toEqual([
			["base/dist/index.css", 5],
			["pkg/dist/index.css", 3],
			["pkg/dist/nested/a.js", 4],
		]);
		expect(log.info).toHaveBeenCalledTimes(1);
	});

	it("applies negated glob lines as exclusions", async () => {
		const all = await fetchFilesAndSizes(root, ["**/dist/**"], { core: core() });
		expect(all.has("base/dist/index.css")).toBe(true);
		const files = await fetchFilesAndSizes(root, ["**/dist/**", "!base/**", ""], { core: core() });
		expect([...files.keys()].sort()).toEqual(["pkg/dist/index.css", "pkg/dist/nested/a.js"]);
	});

	it("throws for a missing required path and returns empty for an optional one", async () => {
		await expect(fetchFilesAndSizes(join(root, "nope"), ["**"], { core: core() })).rejects.toThrow(/does not exist/);
		await expect(fetchFilesAndSizes("", ["**"], { core: core(), required: false })).resolves.toEqual(new Map());
	});

	it("lists the directory and throws when a required path matches nothing", async () => {
		const log = core();
		await expect(fetchFilesAndSizes(root, ["**/out/**"], { core: log })).rejects.toThrow(/No files found/);
		expect(log.startGroup).toHaveBeenCalledTimes(1);
		const listed = log.info.mock.calls.map(([line]) => line).join("\n");
		expect(listed).toContain("README.md");
		expect(listed).not.toContain("node_modules");
	});

	it("warns and returns empty when an optional path matches nothing", async () => {
		const log = core();
		await expect(fetchFilesAndSizes(root, ["**/out/**"], { core: log, required: false })).resolves.toEqual(new Map());
		expect(log.warning).toHaveBeenCalledTimes(1);
	});
});
