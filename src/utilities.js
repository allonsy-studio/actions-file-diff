/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { create } from "@actions/glob";

/**
 * Lists every file under a path (for debugging an empty glob) and then throws.
 * @param {string} path
 * @param {string[]} pattern
 * @param {{ core: object }} options
 * @throws {Error} Always, describing the unmatched glob.
 */
function debugEmptyDirectory(path, pattern, { core }) {
	function reportOnDirectoryFiles(p, { rootDir = p }) {
		readdirSync(p, { withFileTypes: true }).forEach((dirent) => {
			if (dirent.name.startsWith(".")) return;
			if (dirent.isFile()) {
				const file = join(p, dirent.name);
				core.info(`- ${relative(rootDir, file)}  |  ${bytesToSize(statSync(file).size)}`);
			} else if (dirent.isDirectory()) {
				if (dirent.name === "node_modules") return;
				const dir = join(p, dirent.name);
				core.info(`${relative(rootDir, dir)}/`);
				reportOnDirectoryFiles(dir, { rootDir });
			}
		});
	}

	core.startGroup(`All files in ${path}`);
	reportOnDirectoryFiles(path, {});
	core.endGroup();

	throw new Error(`No files found matching the glob pattern: ${pattern.map((p) => join(path, p)).join(", ")}`);
}

/**
 * Prefixes each glob line with the root path, preserving `!` negations and
 * dropping empty lines.
 * @param {string} rootPath
 * @param {string[]} patterns
 * @returns {string[]}
 */
export function globPatterns(rootPath, patterns = []) {
	return patterns
		.map((pattern) => String(pattern ?? "").trim())
		.filter(Boolean)
		.map((pattern) => (pattern.startsWith("!") ? `!${join(rootPath, pattern.slice(1))}` : join(rootPath, pattern)));
}

/** Units above bytes; sub-KB sizes are shown in KB too. */
const UNITS = ["KB", "MB", "GB", "TB"];

/**
 * Formats a byte count as a human readable size using 1024-based units. The
 * unit is chosen after rounding, so 1,048,575 bytes reads "1.00 MB", not "1024.00 KB".
 * @param {number|undefined|null} bytes
 * @returns {string}
 */
export function bytesToSize(bytes) {
	if (bytes === 0) return "0";
	if (!bytes) return "-";

	let value = bytes / 1024;
	if (bytes < 1024) return value.toFixed(2) === "0.00" ? "< 0.01 KB" : `${value.toFixed(2)} KB`;

	let unit = 0;
	while (unit < UNITS.length - 1 && Number(value.toFixed(2)) >= 1024) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(2)} ${UNITS[unit]}`;
}

/**
 * Maps over items with at most `limit` calls in flight, preserving order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
	return results;
}

/**
 * Globs a root path and returns a map of relative file path → size in bytes.
 * Only regular files are returned: symbolic links are never followed, because
 * the tree may come from an untrusted pull request and a link could point at
 * files outside the checkout. A required root must exist and match at least
 * one file (otherwise throws); an optional root that is missing or unmatched
 * yields an empty map.
 * @param {string} rootPath
 * @param {string[]} [patterns]
 * @param {{ core: object, required?: boolean }} options
 * @returns {Promise<Map<string, number>>}
 */
export async function fetchFilesAndSizes(rootPath, patterns = [], { core, required = true }) {
	if (!rootPath || !existsSync(rootPath)) {
		if (required) throw new Error(`The provided path does not exist in the workspace: "${rootPath}"`);
		return new Map();
	}

	const globber = await create(globPatterns(rootPath, patterns).join("\n"), { matchDirectories: false, followSymbolicLinks: false });

	const files = new Map();
	let links = 0;
	(await globber.glob()).forEach((f) => {
		const stat = lstatSync(f, { throwIfNoEntry: false });
		if (stat?.isFile()) files.set(relative(rootPath, f), stat.size);
		else if (stat?.isSymbolicLink()) links++;
	});
	if (links > 0) core.warning(`From ${rootPath}, ignored ${links} symbolic link${links === 1 ? "" : "s"}; only regular files are measured.`);

	if (files.size === 0) {
		if (required) debugEmptyDirectory(rootPath, patterns, { core });
		core.warning(`From ${rootPath}, no files matched the glob pattern ${patterns.join(", ")}; continuing without a base.`);
		return new Map();
	}

	core.info(`From ${rootPath}, found ${files.size} files matching the glob pattern ${patterns.join(", ")}.`);

	return files;
}
