/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bytesToSize } from "./utilities.js";

/** Default path segment separating a package from its built output. */
export const DEFAULT_BUILD_DIR = "dist";

/** Default main file (relative to the build dir) when package.json has none. */
export const DEFAULT_MAIN_FILE = "index.css";

/**
 * @typedef {object} FileEntry
 * @property {number|undefined} headByteSize Size on the head checkout, undefined when absent.
 * @property {number|undefined} baseByteSize Size on the base checkout, undefined when absent.
 */

/**
 * @typedef {object} Package
 * @property {string} name Display name (directory immediately before the build dir).
 * @property {string} packageDir Directory containing the build dir, relative to the root path.
 * @property {Map<string, FileEntry>} files Readable filename → sizes.
 */

/**
 * @typedef {object} Section
 * @property {string} name Package display name.
 * @property {string} packageDir Package directory relative to the root path.
 * @property {string} mainFile Resolved main file, relative to the build dir.
 * @property {boolean} hasChange Whether any file in the package differs from base.
 * @property {Map<string, FileEntry>} files Readable filename → sizes.
 */

/** Splits a path into segments regardless of separator. */
const segments = (filepath) =>
	String(filepath ?? "")
		.split(/[\\/]+/)
		.filter(Boolean);

/** Basename of a path (last segment). */
const basename = (filepath) => segments(filepath).at(-1) ?? "";

/**
 * Escapes a string for literal use inside a RegExp.
 * @param {string} value
 * @returns {string}
 */
export function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the hidden HTML marker that identifies this action's sticky comment.
 * Different comment headers yield different markers so instances can coexist.
 * @param {string} header Comment header text.
 * @returns {string}
 */
export function commentMarker(header) {
	const slug =
		String(header ?? "")
			.replace(/[^a-z0-9]+/gi, "-")
			.replace(/^-+|-+$/g, "")
			.toLowerCase() || "default";
	return `<!-- actions-file-diff:${slug} -->`;
}

/**
 * Normalizes an extensions input (multiline and/or comma-separated, with or
 * without leading dots) into a set of lowercase extensions without dots.
 * @param {string|string[]} input
 * @returns {Set<string>}
 */
export function normalizeExtensions(input = []) {
	const list = Array.isArray(input) ? input : [input];
	return new Set(
		list
			.flatMap((entry) => String(entry ?? "").split(/[,\n]/))
			.map((entry) => entry.trim().replace(/^\.+/, "").toLowerCase())
			.filter(Boolean),
	);
}

/**
 * Returns the base extension of a file after stripping `.map`, `.gz` and
 * `.min` layers, lowercase and without the leading dot.
 * @example baseExtension("index.min.css.gz") // "css"
 * @param {string} filepath
 * @returns {string}
 */
export function baseExtension(filepath) {
	let name = basename(filepath);
	while (/\.(map|gz)$/i.test(name)) name = name.replace(/\.(map|gz)$/i, "");
	name = name.replace(/\.min$/i, "");
	const match = name.match(/\.([^.]+)$/);
	return match ? match[1].toLowerCase() : "";
}

/**
 * Whether a file is reported on its own row (not a map, gzip or minified sibling).
 * @param {string} filepath
 * @returns {boolean}
 */
export function isReportedFile(filepath) {
	const name = basename(filepath);
	return !/\.(map|gz)$/i.test(name) && !/\.min(\.|$)/i.test(name);
}

/**
 * Name of the minified sibling for a file, or undefined when it has no extension.
 * @param {string} filepath
 * @returns {string|undefined}
 */
export function minifiedName(filepath) {
	const match = String(filepath).match(/\.([^./\\]+)$/);
	if (!match) return undefined;
	return filepath.replace(/\.([^./\\]+)$/, ".min.$1");
}

/**
 * Name of the gzipped, minified sibling for a file, or undefined when it has no extension.
 * @param {string} filepath
 * @returns {string|undefined}
 */
export function gzippedName(filepath) {
	const minified = minifiedName(filepath);
	return minified ? `${minified}.gz` : undefined;
}

/**
 * Filters a file map down to the files whose base extension is allowed.
 * An empty allow-list keeps everything.
 * @param {Map<string, number>} fileMap
 * @param {Set<string>|string|string[]} extensions
 * @returns {Map<string, number>}
 */
export function filterByExtensions(fileMap, extensions = []) {
	const allowed = extensions instanceof Set ? extensions : normalizeExtensions(extensions);
	if (allowed.size === 0) return new Map(fileMap);
	return new Map([...fileMap].filter(([file]) => allowed.has(baseExtension(file))));
}

/**
 * Size counted toward the total for a file: its `.min.<ext>` sibling when
 * that sibling exists in the same map, otherwise its own size.
 * @param {string} filepath
 * @param {Map<string, number>} fileMap
 * @returns {number}
 */
export function countedSize(filepath, fileMap) {
	const minified = minifiedName(filepath);
	if (minified && fileMap.has(minified)) return fileMap.get(minified) ?? 0;
	return fileMap.get(filepath) ?? 0;
}

/**
 * Total size of a map: the sum of counted sizes over all reported files.
 * @param {Map<string, number>} fileMap
 * @returns {number}
 */
export function totalSize(fileMap) {
	return [...fileMap.keys()].reduce((sum, file) => (isReportedFile(file) ? sum + countedSize(file, fileMap) : sum), 0);
}

/**
 * Splits a relative file path into its package and readable filename using
 * the build dir segment. Paths without the segment fall back to the parent
 * directory as the package and the basename as the filename.
 * @param {string} filepath
 * @param {string} [buildDir]
 * @returns {{ packageName: string, packageDir: string, readableFilename: string }}
 */
export function splitPath(filepath, buildDir = DEFAULT_BUILD_DIR) {
	const parts = segments(filepath);
	const idx = buildDir ? parts.indexOf(buildDir) : -1;

	if (idx !== -1 && idx < parts.length - 1) {
		const packagePath = parts.slice(0, idx);
		return {
			packageName: packagePath.at(-1) ?? ".",
			packageDir: packagePath.join("/") || ".",
			readableFilename: parts.slice(idx + 1).join("/"),
		};
	}

	const dirParts = parts.slice(0, -1);
	return {
		packageName: dirParts.at(-1) ?? ".",
		packageDir: dirParts.join("/") || ".",
		readableFilename: parts.at(-1) ?? "",
	};
}

/**
 * Groups head and base file maps into packages keyed by package directory.
 * @param {Map<string, number>} headMap
 * @param {Map<string, number>} [baseMap]
 * @param {{ buildDir?: string }} [options]
 * @returns {Map<string, Package>}
 */
export function groupByPackage(headMap, baseMap = new Map(), { buildDir = DEFAULT_BUILD_DIR } = {}) {
	const packages = new Map();

	const add = (filepath) => {
		const { packageName, packageDir, readableFilename } = splitPath(filepath, buildDir);
		if (!packages.has(packageDir)) packages.set(packageDir, { name: packageName, packageDir, files: new Map() });
		const { files } = packages.get(packageDir);
		if (files.has(readableFilename)) return;
		files.set(readableFilename, { headByteSize: headMap.get(filepath), baseByteSize: baseMap.get(filepath) });
	};

	[...headMap.keys(), ...baseMap.keys()].forEach(add);

	return new Map([...packages].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Resolves the main file for a package. When enabled and `<packageDir>/package.json`
 * declares a string `main`, it is used (stripped of everything up to and including
 * `<buildDir>/`); otherwise the fallback is returned. A malformed package.json
 * logs a warning and falls back.
 * @param {object} options
 * @param {string} [options.rootPath]
 * @param {string} [options.packageDir]
 * @param {string} [options.buildDir]
 * @param {string} [options.mainFile]
 * @param {boolean} [options.readPackageJson]
 * @param {{ warning?: Function }} [options.core]
 * @returns {string}
 */
export function resolveMainFile({ rootPath = ".", packageDir = ".", buildDir = DEFAULT_BUILD_DIR, mainFile = DEFAULT_MAIN_FILE, readPackageJson = true, core } = {}) {
	if (!readPackageJson) return mainFile;

	const packagePath = join(rootPath, packageDir, "package.json");
	if (!existsSync(packagePath)) return mainFile;

	try {
		const { main } = JSON.parse(readFileSync(packagePath, "utf8")) ?? {};
		if (typeof main !== "string" || !main.trim()) return mainFile;
		const stripper = new RegExp(`^(?:.*/)?${escapeRegExp(buildDir)}/`);
		return main.trim().replace(/\\/g, "/").replace(stripper, "");
	} catch (error) {
		core?.warning?.(`Unable to read ${packagePath}: ${error.message}. Falling back to "${mainFile}".`);
		return mainFile;
	}
}

/**
 * Byte difference between two sizes, treating missing values as zero.
 * @param {number|undefined} v1
 * @param {number|undefined} v0
 * @returns {number}
 */
export const difference = (v1, v0) => (v1 ?? 0) - (v0 ?? 0);

/**
 * Whether a file exists on base but not on head.
 * @param {number|undefined} head
 * @param {number|undefined} base
 * @returns {boolean}
 */
export const isRemoved = (head, base) => head == null && base != null;

/**
 * Whether a file exists on head but not on base.
 * @param {number|undefined} head
 * @param {number|undefined} base
 * @returns {boolean}
 */
export const isNew = (head, base) => head != null && base == null;

/**
 * Formats a size change with a direction indicator.
 * @param {number|undefined} v1 Head size.
 * @param {number|undefined} v0 Base size.
 * @returns {string}
 */
export function printChange(v1, v0) {
	const d = difference(v1, v0);
	if (d === 0) return "-";
	return `${d > 0 ? "🔴 ⬆" : "🟢 ⬇"} ${bytesToSize(Math.abs(d))}`;
}

/**
 * Formats a percentage change; empty when there is no base value or no head value.
 * @param {number|undefined} v1 Head size.
 * @param {number|undefined} v0 Base size.
 * @returns {string}
 */
export function printPercentChange(v1, v0) {
	if (!v0 || v1 == null) return "";
	const delta = ((v1 - v0) / v0) * 100;
	if (delta === 0) return "no change";
	return `${delta.toFixed(2)}%`;
}

/**
 * Builds the table row cells for a reported file. The "Compared to base"
 * cell is only present when there is a base.
 * @param {object} options
 * @param {string} options.readableFilename
 * @param {Map<string, FileEntry>} options.files Package file map.
 * @param {boolean} options.hasBase
 * @param {boolean} [options.isMainFile]
 * @returns {string[]}
 */
export function buildFileRow({ readableFilename, files, hasBase, isMainFile = false }) {
	const { headByteSize, baseByteSize } = files.get(readableFilename) ?? {};
	const removed = hasBase && isRemoved(headByteSize, baseByteSize);
	const added = hasBase && isNew(headByteSize, baseByteSize);

	const siblingCell = (name) => {
		const sibling = name ? files.get(name) : undefined;
		if (!sibling) return " - ";
		if (hasBase && isRemoved(sibling.headByteSize, sibling.baseByteSize)) return "🚨 deleted/moved";
		if (sibling.headByteSize == null) return " - ";
		if (hasBase && isNew(sibling.headByteSize, sibling.baseByteSize)) return `🆕 ${bytesToSize(sibling.headByteSize)}`;
		return bytesToSize(sibling.headByteSize);
	};

	let size;
	let delta;
	if (removed) {
		size = "🚨 deleted/moved";
		delta = `⬇ ${bytesToSize(baseByteSize)}`;
	} else {
		size = bytesToSize(headByteSize);
		if (added) delta = `🆕 ${bytesToSize(headByteSize)}`;
		else {
			delta = printChange(headByteSize, baseByteSize);
			const percent = printPercentChange(headByteSize, baseByteSize);
			if (delta !== "-" && percent) delta += ` (${percent})`;
		}
	}

	const minSize = removed ? " - " : siblingCell(minifiedName(readableFilename));
	const gzipSize = removed ? " - " : siblingCell(gzippedName(readableFilename));

	return [isMainFile ? `**${readableFilename}**` : readableFilename, size, minSize, gzipSize, ...(hasBase ? [delta] : [])];
}

/**
 * Turns packages into report sections. A section is included when any file
 * differs between head and base, or always when there is no base.
 * @param {Map<string, Package>} packages
 * @param {object} options
 * @param {boolean} options.hasBase
 * @param {string} [options.rootPath]
 * @param {string} [options.buildDir]
 * @param {string} [options.mainFile]
 * @param {boolean} [options.readPackageJson]
 * @param {{ warning?: Function }} [options.core]
 * @returns {Section[]}
 */
export function buildSections(packages, { hasBase, rootPath = ".", buildDir = DEFAULT_BUILD_DIR, mainFile = DEFAULT_MAIN_FILE, readPackageJson = true, core } = {}) {
	const sections = [];

	packages.forEach(({ name, packageDir, files }) => {
		if (files.size === 0) return;
		const hasChange = [...files.values()].some(({ headByteSize, baseByteSize }) => headByteSize !== baseByteSize);
		if (hasBase && !hasChange) return;

		sections.push({
			name,
			packageDir,
			hasChange,
			mainFile: resolveMainFile({ rootPath, packageDir, buildDir, mainFile, readPackageJson, core }),
			files,
		});
	});

	return sections;
}

/** Renders a header and rows as markdown table lines. */
const toTable = (header, rows) => [header, header.map(() => "-"), ...rows].map((row) => `| ${row.join(" | ")} |`);

/**
 * Builds the full report: summary lines, detail markdown lines, totals and
 * the has-changed flag. Totals use the same formula as the `total-size` and
 * `has-changed` outputs so the two can never disagree.
 * @param {object} options
 * @param {Map<string, number>} options.headMap Relative path → size on head.
 * @param {Map<string, number>} [options.baseMap] Relative path → size on base.
 * @param {boolean} [options.hasBase] Defaults to whether baseMap has entries.
 * @param {string} [options.rootPath] Head root, used to locate package.json files.
 * @param {string} [options.buildDir]
 * @param {string} [options.mainFile]
 * @param {boolean} [options.readPackageJson]
 * @param {string|string[]} [options.extensions]
 * @param {{ warning?: Function }} [options.core]
 * @returns {{ summary: string[], markdown: string[], text: string, headTotal: number, baseTotal: number, hasBase: boolean, hasChanged: boolean, sections: Section[] }}
 */
export function buildReport({ headMap = new Map(), baseMap = new Map(), hasBase = baseMap.size > 0, rootPath = ".", buildDir = DEFAULT_BUILD_DIR, mainFile = DEFAULT_MAIN_FILE, readPackageJson = true, extensions = [], core } = {}) {
	const allowed = normalizeExtensions(extensions);
	const head = filterByExtensions(headMap, allowed);
	const base = hasBase ? filterByExtensions(baseMap, allowed) : new Map();

	const headTotal = totalSize(head);
	const baseTotal = hasBase ? totalSize(base) : 0;
	const hasChanged = hasBase && headTotal !== baseTotal;

	const sections = buildSections(groupByPackage(head, base, { buildDir }), { hasBase, rootPath, buildDir, mainFile, readPackageJson, core });

	const summary = ["### Summary", `**Total size**: ${bytesToSize(headTotal)}<sup>*</sup>`];
	const markdown = [];
	const summaryRows = [];

	if (sections.length === 0) {
		summary.push("", "🎉 No changes detected in any packages");
	} else {
		const tableHead = ["Filename", "Head", "Minified", "Gzipped", ...(hasBase ? ["Compared to base"] : [])];

		sections.forEach(({ name, mainFile: packageMain, files }) => {
			const rows = [];
			[...files.keys()].sort().forEach((readableFilename) => {
				if (!isReportedFile(readableFilename)) return;
				const isMainFile = readableFilename === packageMain;
				const row = buildFileRow({ readableFilename, files, hasBase, isMainFile });
				if (isMainFile) summaryRows.push([name, ...row.slice(1)]);
				rows.push(row);
			});
			markdown.push("", `#### ${name}`, "", ...toTable(tableHead, rows));
		});

		if (!hasBase) {
			summary.push("No base branch to compare against.", "");
		} else if (hasChanged) {
			const percent = printPercentChange(headTotal, baseTotal);
			summary.push(`**Total change (Δ)**: ${printChange(headTotal, baseTotal)}${percent ? ` (${percent})` : ""}`, "", `<small><em>Table reports on changes to a package's main file.${sections.length > 1 ? ` Other changes can be found in the collapsed <a href="#details">Details</a> section below.` : ""}</em></small>`, "");
		} else {
			summary.push("✅ **No change in file sizes**", "");
		}

		if (sections.length > 1) {
			markdown.unshift('<a name="details"></a>', "<details>", "<summary><b>File change details</b></summary>", "");
			markdown.push("", "</details>");
		}
	}

	if (summaryRows.length > 0) {
		const summaryHead = ["Package", "Size", "Minified", "Gzipped", ...(hasBase ? ["Δ"] : [])];
		summary.push(...toTable(summaryHead, summaryRows));
	}

	markdown.push("", "<small>", "* <em>Size is the sum of all reported files, using the minified size where one exists.</em><br/>", "* <em>An ASCII character in UTF-8 is 8 bits or 1 byte.</em>", "</small>");

	return {
		summary,
		markdown,
		text: [summary.join("\n"), markdown.join("\n")].join("\n\n"),
		headTotal,
		baseTotal,
		hasBase,
		hasChanged,
		sections,
	};
}
