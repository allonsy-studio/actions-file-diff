/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import { execFile } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { baseExtension, filterByExtensions, isNew, isRemoved, isReportedFile, normalizeExtensions } from "./report.js";
import { mapLimit } from "./utilities.js";

const execFileAsync = promisify(execFile);

/** Extensions treated as images for the visual diff tab. */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp"]);

/** Default per-file byte limit for line diffs. */
export const DEFAULT_MAX_DIFF_SIZE = 256 * 1024;

/** Default limit on diff lines kept for the whole report. */
export const DEFAULT_MAX_DIFF_LINES = 20000;

/** Largest image (bytes) copied into a published report. */
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/** Time (ms) one `git diff` may run before it is killed. */
const DIFF_TIMEOUT = 10_000;

/** Time (ms) all diffs together may take before the rest are skipped. */
const DIFF_TIME_BUDGET = 60_000;

/** Concurrent `git diff` processes. */
const DIFF_CONCURRENCY = 4;

/** Bytes sniffed for NUL to decide a file is binary (the same window git uses). */
const SNIFF_BYTES = 8000;

/** Chunk size when comparing two files of equal size. */
const COMPARE_CHUNK = 64 * 1024;

/** Largest `git diff` output (bytes) accepted for one file. */
const MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * @typedef {"added"|"removed"|"modified"} ChangeStatus
 */

/**
 * @typedef {object} Hunk
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {string[]} lines Prefixed with " ", "+", "-" or "\\".
 */

/**
 * @typedef {object} TextChange
 * @property {string} file Path relative to the roots.
 * @property {ChangeStatus} status
 * @property {number} additions Lines added (0 when `skipped`).
 * @property {number} deletions Lines removed (0 when `skipped`).
 * @property {Hunk[]} hunks Empty when `skipped` or `omitted`.
 * @property {string} [skipped] Why no diff was computed. Line counts are unknown.
 * @property {string} [omitted] Why a computed diff was left out of the report. Line counts are accurate.
 */

/**
 * @typedef {object} ImageChange
 * @property {string} file Path relative to the roots.
 * @property {ChangeStatus} status
 * @property {number|undefined} headByteSize
 * @property {number|undefined} baseByteSize
 * @property {string|undefined} headPath Absolute path on head, when present.
 * @property {string|undefined} basePath Absolute path on base, when present.
 */

/**
 * @typedef {object} Stats
 * @property {number} added Files only on head.
 * @property {number} removed Files only on base.
 * @property {number} modified Files on both with different contents.
 * @property {number} additions Changed lines added.
 * @property {number} deletions Changed lines removed.
 */

/**
 * Whether a buffer looks binary (contains a NUL byte in its first 8000 bytes).
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isBinary(buffer) {
	return buffer.subarray(0, SNIFF_BYTES).includes(0);
}

/**
 * Whether a file looks binary, reading only its first 8000 bytes.
 * @param {string} path
 * @returns {boolean}
 */
export function isBinaryFile(path) {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(SNIFF_BYTES);
		const read = readSync(fd, buffer, 0, SNIFF_BYTES, 0);
		return isBinary(buffer.subarray(0, read));
	} finally {
		closeSync(fd);
	}
}

/**
 * Whether two files have identical bytes, reading in chunks and stopping at the
 * first difference. Callers should compare sizes first.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameContent(a, b) {
	const fa = openSync(a, "r");
	let fb;
	try {
		fb = openSync(b, "r");
		const bufA = Buffer.alloc(COMPARE_CHUNK);
		const bufB = Buffer.alloc(COMPARE_CHUNK);
		for (let position = 0; ; position += COMPARE_CHUNK) {
			const readA = readSync(fa, bufA, 0, COMPARE_CHUNK, position);
			const readB = readSync(fb, bufB, 0, COMPARE_CHUNK, position);
			if (readA !== readB || !bufA.subarray(0, readA).equals(bufB.subarray(0, readB))) return false;
			if (readA === 0) return true;
		}
	} finally {
		closeSync(fa);
		if (fb !== undefined) closeSync(fb);
	}
}

/**
 * Whether a file is an image by base extension.
 * @param {string} filepath
 * @returns {boolean}
 */
export const isImage = (filepath) => IMAGE_EXTENSIONS.has(baseExtension(filepath));

/**
 * Change status for a pair of sizes, or undefined when the file is on neither side.
 * @param {number|undefined} head
 * @param {number|undefined} base
 * @returns {ChangeStatus|undefined}
 */
export function changeStatus(head, base) {
	if (isNew(head, base)) return "added";
	if (isRemoved(head, base)) return "removed";
	if (head == null) return undefined;
	return "modified";
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses unified diff text (as `git diff` prints it) into hunks and line counts.
 * Everything before the first hunk header (file headers, modes) is ignored.
 * @param {string} text
 * @returns {{ hunks: Hunk[], additions: number, deletions: number }}
 */
export function parseUnifiedDiff(text) {
	const hunks = [];
	let additions = 0;
	let deletions = 0;
	let current;

	for (const line of text.split("\n")) {
		const header = HUNK_HEADER.exec(line);
		if (header) {
			current = { oldStart: Number(header[1]), oldLines: header[2] === undefined ? 1 : Number(header[2]), newStart: Number(header[3]), newLines: header[4] === undefined ? 1 : Number(header[4]), lines: [] };
			hunks.push(current);
			continue;
		}
		if (!current) continue;
		const sign = line[0];
		if (sign === "+") additions++;
		else if (sign === "-") deletions++;
		else if (sign !== " " && sign !== "\\") continue;
		current.lines.push(line);
	}

	return { hunks, additions, deletions };
}

/** Environment that keeps user and system git config out of the diff. */
const gitEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: "0" });

/**
 * Whether `git` can be run.
 * @param {string} [git] Executable name or path.
 * @returns {Promise<boolean>}
 */
export async function hasGit(git = "git") {
	try {
		await execFileAsync(git, ["--version"], { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Diffs two files with `git diff --no-index`. A missing side is diffed against
 * `/dev/null`. The command runs outside any repository, so repository config
 * and attributes never apply.
 * @param {object} options
 * @param {string|undefined} options.basePath
 * @param {string|undefined} options.headPath
 * @param {string} [options.git]
 * @param {number} [options.timeout] Milliseconds before the process is killed.
 * @returns {Promise<{ hunks: Hunk[], additions: number, deletions: number }>}
 * @throws {Error} When git fails or times out (`error.reason` says which).
 */
export async function gitDiff({ basePath, headPath, git = "git", timeout = DIFF_TIMEOUT }) {
	const args = ["-c", "core.quotepath=off", "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", "--", basePath ?? "/dev/null", headPath ?? "/dev/null"];
	try {
		const { stdout } = await execFileAsync(git, args, { cwd: tmpdir(), env: gitEnv(), timeout, maxBuffer: MAX_OUTPUT, encoding: "utf8" });
		return parseUnifiedDiff(stdout);
	} catch (error) {
		// `git diff --no-index` exits 1 when the files differ.
		if (error.code === 1 && typeof error.stdout === "string") return parseUnifiedDiff(error.stdout);
		const reason = error.killed ? "diff timed out" : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "diff output too large" : `git failed (${error.code ?? error.message})`;
		throw Object.assign(new Error(reason), { reason, cause: error });
	}
}

/**
 * Compares head and base trees file by file. Sizes decide most cases without
 * reading anything: only same-size files are compared byte by byte, and only
 * small text files are diffed (with `git diff --no-index`, which must be on
 * the PATH). Minified, gzip and sourcemap siblings are skipped.
 *
 * A file that cannot be read or diffed is still reported, with `skipped` saying
 * why. Diffs beyond `maxDiffLines` in total keep their line counts but not
 * their hunks.
 * @param {object} options
 * @param {Map<string, number>} options.headMap Relative path → size on head.
 * @param {Map<string, number>} [options.baseMap] Relative path → size on base.
 * @param {string} options.headRoot
 * @param {string} [options.baseRoot]
 * @param {string|string[]} [options.extensions]
 * @param {number} [options.maxDiffSize] Per-file byte limit for line diffs.
 * @param {number} [options.maxDiffLines] Total diff lines kept for the report.
 * @param {string} [options.git] Executable used for diffs.
 * @param {number} [options.diffTimeout] Per-file diff time limit in ms.
 * @param {number} [options.diffTimeBudget] Total diff time limit in ms.
 * @param {{ warning?: Function }} [options.core]
 * @returns {Promise<{ text: TextChange[], images: ImageChange[], stats: Stats }>}
 */
export async function collectChanges({ headMap, baseMap = new Map(), headRoot, baseRoot, extensions = [], maxDiffSize = DEFAULT_MAX_DIFF_SIZE, maxDiffLines = DEFAULT_MAX_DIFF_LINES, git = "git", diffTimeout = DIFF_TIMEOUT, diffTimeBudget = DIFF_TIME_BUDGET, core }) {
	const allowed = normalizeExtensions(extensions);
	const head = filterByExtensions(headMap, allowed);
	const base = filterByExtensions(baseMap, allowed);

	const text = [];
	const images = [];
	const stats = { added: 0, removed: 0, modified: 0, additions: 0, deletions: 0 };
	/** Text changes that still need a diff, with their paths. */
	const pending = [];
	const unreadable = [];

	const files = [...new Set([...head.keys(), ...base.keys()])].filter(isReportedFile).sort();

	files.forEach((file) => {
		const headByteSize = head.get(file);
		const baseByteSize = base.get(file);
		const status = changeStatus(headByteSize, baseByteSize);
		if (!status) return;

		const headPath = headByteSize != null ? join(headRoot, file) : undefined;
		const basePath = baseByteSize != null && baseRoot ? join(baseRoot, file) : undefined;
		/** First failure for this file, if any. */
		let failure;

		// Only same-size files need their bytes compared; different sizes already differ.
		if (status === "modified" && headByteSize === baseByteSize) {
			try {
				if (sameContent(headPath, basePath)) return;
			} catch (error) {
				failure = error;
			}
		}

		stats[status]++;

		if (isImage(file)) {
			images.push({ file, status, headByteSize, baseByteSize, headPath, basePath });
			// SVG is text, so it also gets a line diff.
			if (baseExtension(file) !== "svg") return;
		}

		const change = { file, status, additions: 0, deletions: 0, hunks: [] };
		text.push(change);

		if (!failure) {
			try {
				if ((headPath && isBinaryFile(headPath)) || (basePath && isBinaryFile(basePath))) {
					change.skipped = "binary file";
					return;
				}
			} catch (error) {
				failure = error;
			}
		}
		if (failure) {
			change.skipped = `unreadable (${failure.code ?? failure.message})`;
			unreadable.push(file);
			return;
		}
		if (Math.max(headByteSize ?? 0, baseByteSize ?? 0) > maxDiffSize) {
			change.skipped = "file exceeds max-diff-size";
			return;
		}

		pending.push({ change, headPath, basePath });
	});

	if (unreadable.length > 0) core?.warning?.(`Could not read ${unreadable.length} file${unreadable.length === 1 ? "" : "s"}; listed without a diff: ${unreadable.slice(0, 5).join(", ")}${unreadable.length > 5 ? ", …" : ""}`);

	if (pending.length > 0 && !(await hasGit(git))) {
		core?.warning?.("`git` was not found on the PATH, so line diffs are skipped. Install git (it is preinstalled on GitHub-hosted runners) to see them.");
		pending.forEach(({ change }) => (change.skipped = "git is not available on PATH"));
		return { text, images, stats };
	}

	// Diff in ordered batches so the line budget is applied in file order and memory stays bounded.
	const started = Date.now();
	let retained = 0;
	for (let i = 0; i < pending.length; i += DIFF_CONCURRENCY * 8) {
		const batch = pending.slice(i, i + DIFF_CONCURRENCY * 8);
		const results = await mapLimit(batch, DIFF_CONCURRENCY, async ({ headPath, basePath }) => {
			if (Date.now() - started > diffTimeBudget) return { reason: "diff time budget exhausted" };
			try {
				return await gitDiff({ basePath, headPath, git, timeout: diffTimeout });
			} catch (error) {
				return { reason: error.reason ?? error.message };
			}
		});

		results.forEach((result, index) => {
			const { change } = batch[index];
			if (result.reason) {
				change.skipped = result.reason;
				return;
			}
			change.additions = result.additions;
			change.deletions = result.deletions;
			stats.additions += result.additions;
			stats.deletions += result.deletions;

			const lines = result.hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0);
			if (retained + lines > maxDiffLines) change.omitted = `the report's diff budget (${maxDiffLines.toLocaleString("en-US")} lines) is used up`;
			else {
				retained += lines;
				change.hunks = result.hunks;
			}
		});
	}

	return { text, images, stats };
}
