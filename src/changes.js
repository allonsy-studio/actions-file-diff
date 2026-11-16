/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { structuredPatch } from "diff";

import { baseExtension, filterByExtensions, isNew, isRemoved, isReportedFile, normalizeExtensions } from "./report.js";

/** Extensions treated as images for the visual diff tab. */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp"]);

/** Default per-file byte limit for line diffs. */
export const DEFAULT_MAX_DIFF_SIZE = 256 * 1024;

/** Largest image (bytes) copied into a published report. */
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/** Time budget (ms) for diffing one file before giving up. */
const DIFF_TIMEOUT = 2000;

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
 * @property {number} additions
 * @property {number} deletions
 * @property {Hunk[]} hunks Empty when skipped.
 * @property {string} [skipped] Reason the line diff was not computed.
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
	return buffer.subarray(0, 8000).includes(0);
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

/**
 * Reads a file, returning undefined when it cannot be read.
 * @param {string|undefined} path
 * @returns {Buffer|undefined}
 */
const read = (path) => {
	if (!path) return undefined;
	try {
		return readFileSync(path);
	} catch {
		return undefined;
	}
};

/**
 * Builds a line diff between two strings.
 * @param {string} file
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ hunks: Hunk[], additions: number, deletions: number }|undefined} Undefined on timeout.
 */
export function lineDiff(file, oldText, newText) {
	const patch = structuredPatch(`a/${file}`, `b/${file}`, oldText, newText, "", "", { context: 3, timeout: DIFF_TIMEOUT });
	if (!patch) return undefined;

	let additions = 0;
	let deletions = 0;
	patch.hunks.forEach(({ lines }) =>
		lines.forEach((line) => {
			if (line.startsWith("+")) additions++;
			else if (line.startsWith("-")) deletions++;
		}),
	);

	return { hunks: patch.hunks, additions, deletions };
}

/**
 * Compares head and base trees file by file. Minified, gzip and sourcemap
 * siblings are skipped (they duplicate their source and diff as one long line).
 * @param {object} options
 * @param {Map<string, number>} options.headMap Relative path → size on head.
 * @param {Map<string, number>} [options.baseMap] Relative path → size on base.
 * @param {string} options.headRoot
 * @param {string} [options.baseRoot]
 * @param {string|string[]} [options.extensions]
 * @param {number} [options.maxDiffSize] Per-file byte limit for line diffs.
 * @returns {{ text: TextChange[], images: ImageChange[], stats: Stats }}
 */
export function collectChanges({ headMap, baseMap = new Map(), headRoot, baseRoot, extensions = [], maxDiffSize = DEFAULT_MAX_DIFF_SIZE }) {
	const allowed = normalizeExtensions(extensions);
	const head = filterByExtensions(headMap, allowed);
	const base = filterByExtensions(baseMap, allowed);

	const text = [];
	const images = [];
	const stats = { added: 0, removed: 0, modified: 0, additions: 0, deletions: 0 };

	const files = [...new Set([...head.keys(), ...base.keys()])].filter(isReportedFile).sort();

	files.forEach((file) => {
		const headByteSize = head.get(file);
		const baseByteSize = base.get(file);
		const headPath = headByteSize != null ? join(headRoot, file) : undefined;
		const basePath = baseByteSize != null && baseRoot ? join(baseRoot, file) : undefined;

		const headBuffer = read(headPath);
		const baseBuffer = read(basePath);
		const status = changeStatus(headBuffer?.length, baseBuffer?.length);
		if (!status) return;
		if (status === "modified" && headBuffer.equals(baseBuffer)) return;

		stats[status]++;

		if (isImage(file)) {
			images.push({ file, status, headByteSize, baseByteSize, headPath, basePath });
			// SVG is text, so it also gets a line diff.
			if (baseExtension(file) !== "svg") return;
		}

		const change = { file, status, additions: 0, deletions: 0, hunks: [] };
		text.push(change);

		if ((headBuffer && isBinary(headBuffer)) || (baseBuffer && isBinary(baseBuffer))) {
			change.skipped = "binary file";
			return;
		}
		if (Math.max(headBuffer?.length ?? 0, baseBuffer?.length ?? 0) > maxDiffSize) {
			change.skipped = "file exceeds max-diff-size";
			return;
		}

		const result = lineDiff(file, baseBuffer?.toString("utf8") ?? "", headBuffer?.toString("utf8") ?? "");
		if (!result) {
			change.skipped = "diff too large to compute";
			return;
		}

		Object.assign(change, result);
		stats.additions += result.additions;
		stats.deletions += result.deletions;
	});

	return { text, images, stats };
}
