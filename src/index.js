/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import { existsSync } from "node:fs";
import { join, sep } from "node:path";

import core from "@actions/core";

import { fetchFilesAndSizes, bytesToSize, addComment } from "./utilities.js";

async function run() {
	const token = core.getInput("token");
	const headPath = core.getInput("head-path");
	const basePath = core.getInput("base-path");
	const fileGlobPattern = core.getMultilineInput("file-glob-pattern", { trimWhitespace: true });
	const shouldAddComment = core.getBooleanInput("comment") ?? true;
	const commentHeader = core.getInput("comment-header");

	const headOutput = await fetchFilesAndSizes(headPath, fileGlobPattern, { core });
	const baseOutput = await fetchFilesAndSizes(basePath, fileGlobPattern, { core });
	const hasBase = baseOutput.size > 0;

	const { filePath, PACKAGES } = splitDataByPackage(headOutput, baseOutput);
	const sections = makeTable(PACKAGES, filePath, headPath);

	const calculateMinifiedTotal = (contentMap) =>
		[...contentMap.entries()].reduce((acc, [filename, size]) => {
			if (!filename.endsWith(".css") || filename.endsWith(".min.css")) return acc;
			if (/\.css$/.test(filename) && !/\.min\.css$/.test(filename)) {
				const minified = filename.replace(/\.css$/, ".min.css");
				if (headOutput.has(minified)) {
					const minSize = headOutput.get(minified);
					if (minSize) return acc + minSize;
				} else {
					return acc + size;
				}
			}
			return acc + size;
		}, 0);

	const overallHeadSize = calculateMinifiedTotal(headOutput);
	const overallBaseSize = hasBase ? calculateMinifiedTotal(baseOutput) : 0;
	const hasChange = overallHeadSize !== overallBaseSize;

	const markdown = [];
	const summary = ["### Summary", `**Total size**: ${bytesToSize(overallHeadSize)}<sup>*</sup>`];

	let summaryTable = [];

	if (sections.length === 0) {
		summary.push("", " 🎉 No changes detected in any packages");
	} else {
		const tableHead = ["Filename", "Head", "Minified", "Gzipped", ...(hasBase ? ["Compared to base"] : [])];

		sections.map(({ name, hasChange: sectionChanged, mainFile, fileMap }) => {
			if (!sectionChanged) return;

			const tableRows = (table, [readableFilename, { headByteSize, baseByteSize }]) => {
				if (readableFilename.endsWith(".map") || /\.min\.css/.test(readableFilename)) return table;

				const isMainFile = readableFilename === mainFile;
				const gzipName = readableFilename.replace(/\.([a-z]+)$/, ".min.$1.gz");
				const gzipFileRef = fileMap.get(gzipName);
				const minName = readableFilename.replace(/\.([a-z]+)$/, ".min.$1");
				const minFileRef = fileMap.get(minName);
				const removedOnBranch = isRemoved(headByteSize, baseByteSize);
				const newOnBranch = isNew(headByteSize, baseByteSize);

				let size, gzipSize, minSize, change, diff;
				if (removedOnBranch) {
					size = "🚨 deleted/moved";
					change = `⬇ ${bytesToSize(baseByteSize)}`;
					if (difference(baseByteSize, headByteSize) !== 0 && !newOnBranch) {
						diff = ` (${printPercentChange(headByteSize, baseByteSize)})`;
					}
				} else {
					size = bytesToSize(headByteSize);
					if (gzipFileRef && gzipFileRef?.headByteSize) {
						if (isNew(gzipFileRef.headByteSize, gzipFileRef?.baseByteSize)) {
							gzipSize = `🆕 ${bytesToSize(gzipFileRef.headByteSize)}`;
						} else if (isRemoved(gzipFileRef.headByteSize, gzipFileRef?.baseByteSize)) {
							gzipSize = "🚨 deleted/moved";
						} else {
							gzipSize = bytesToSize(gzipFileRef.headByteSize);
						}
					}
					if (minFileRef && minFileRef?.headByteSize) {
						if (isNew(minFileRef.headByteSize, minFileRef?.baseByteSize)) {
							minSize = `🆕 ${bytesToSize(minFileRef.headByteSize)}`;
						} else if (isRemoved(minFileRef.headByteSize, minFileRef?.baseByteSize)) {
							minSize = "🚨 deleted/moved";
						} else {
							minSize = bytesToSize(minFileRef.headByteSize);
						}
					}
					if (newOnBranch) change = `🆕 ${bytesToSize(headByteSize)}`;
					else change = printChange(headByteSize, baseByteSize);
				}

				if (!minSize) minSize = " - ";
				if (!gzipSize) gzipSize = " - ";

				const delta = `${change}${diff ?? ""}`;
				if (isMainFile) summaryTable.push([name, size, minSize, gzipSize, delta]);

				table.push([isMainFile ? `**${readableFilename}**` : readableFilename, size, minSize, gzipSize, delta]);
				return table;
			};

			markdown.push(
				"",
				`#### ${name}`,
				"",
				...[tableHead, tableHead.map(() => "-")].map((row) => `| ${row.join(" | ")} |`),
				...[...fileMap.entries()].reduce(tableRows, []).map((row) => `| ${row.join(" | ")} |`),
			);
		});

		if (hasBase) {
			if (hasChange) {
				summary.push(
					`**Total change (Δ)**: ${printChange(overallHeadSize, overallBaseSize)} (${printPercentChange(overallHeadSize, overallBaseSize)})`,
					"",
					`<small><em>Table reports on changes to a package's main file.${sections.length > 1 ? ` Other changes can be found in the collapsed <a href="#details">Details</a> section below.` : ""}</em></small>`,
					"",
				);
			} else if (sections.length > 1) {
				summary.push("✅ **No change in file sizes**", "");
			}
		} else {
			summary.push("No base branch to compare against.", "");
		}

		if (sections.length > 1) {
			markdown.unshift('<a name="details"></a>', "<details>", "<summary><b>File change details</b></summary>", "");
			markdown.push("", `</details>`);
		}
	}

	if (summaryTable.length > 0) {
		const summaryTableHeader = ["Package", "Size", "Minified", "Gzipped"];
		if (hasBase && hasChange) summaryTableHeader.push("Δ");

		summaryTable.unshift(summaryTableHeader, summaryTableHeader.map(() => "-"));

		summary.push(
			...summaryTable.map((row) => {
				if (summaryTableHeader.length === row.length) return `| ${row.join(" | ")} |`;
				if (row.length > summaryTableHeader.length) return `| ${row.slice(0, summaryTableHeader.length).join(" | ")} |`;
				return `| ${row.concat(Array(summaryTableHeader.length - row.length).fill(" - ")).join(" | ")} |`;
			}),
		);
	}

	markdown.push("", "<small>", "* <em>Size is the sum of all main files for packages in the library.</em><br/>", "* <em>An ASCII character in UTF-8 is 8 bits or 1 byte.</em>", "</small>");

	if (shouldAddComment) {
		await addComment({
			search: new RegExp(`^${commentHeader}`),
			content: [commentHeader, summary.join("\n"), markdown.join("\n")].join("\n\n"),
			token,
		});
	}

	core.startGroup(commentHeader);
	core.info(summary.join("\n"));
	core.info(markdown.join("\n"));
	core.endGroup();

	core.summary = summary.join("\n");

	if (headOutput.size > 0) {
		const headMainSize = [...headOutput.entries()].reduce((acc, [, size]) => acc + size, 0);
		core.setOutput("total-size", headMainSize);

		if (hasBase) {
			const baseMainSize = [...baseOutput.entries()].reduce((acc, [, size]) => acc + size, 0);
			core.setOutput("has-changed", hasBase && headMainSize !== baseMainSize ? "true" : "false");
		}
	} else {
		core.setOutput("total-size", 0);
	}
}

// Entry: errors propagate to setFailed at the top level only.
run().catch((error) => {
	core.error(error.stack);
	core.setFailed(error.message);
});

const difference = (v1, v0) => v1 - v0;
const isRemoved = (v1, v0) => (!v1 || v1 === 0) && v0 && v0 > 0;
const isNew = (v1, v0) => v1 && v1 > 0 && (!v0 || v0 === 0);

const printChange = function (v1, v0) {
	const d = difference(v1, v0);
	return d === 0 ? "-" : `${d > 0 ? "🔴 ⬆" : "🟢 ⬇"} ${bytesToSize(Math.abs(d))}`;
};

const printPercentChange = function (v1, v0) {
	const delta = ((v1 - v0) / v0) * 100;
	if (delta === 0) return "no change";
	return `${delta.toFixed(2)}%`;
};

const makeTable = function (PACKAGES, filePath, rootPath) {
	const sections = [];
	PACKAGES.forEach((fileMap, packageName) => {
		const packagePath = join(rootPath, filePath, packageName, "package.json");
		let mainFile = "index.css";
		if (existsSync(packagePath)) {
			const { main } = require(packagePath) ?? {};
			if (typeof main === "string") mainFile = main.replace(new RegExp("^.*/?dist/"), "");
		}
		const hasChange = fileMap.size > 0 && [...fileMap.values()].some(({ headByteSize, baseByteSize }) => headByteSize !== baseByteSize);
		if (!hasChange) return;
		sections.push({ name: packageName, filePath, hasChange, mainFile, fileMap });
	});
	return sections;
};

const splitDataByPackage = function (dataMap, baseMap = new Map()) {
	let filePath;
	const PACKAGES = new Map();

	const getPathPart = (file, { part, offset, length, reverse = false } = {}) => {
		if (!file || typeof file !== "string") return file;
		const parts = file.split("/");
		let idx = 0;
		if (typeof part !== "undefined") {
			idx = parts.findIndex((p) => p === part);
			if (idx === -1) return file;
		}
		if (typeof offset !== "undefined") idx += offset;
		if (typeof length !== "undefined") {
			if (length < 0) return parts.slice(idx + length, idx).join(sep);
			return parts.slice(idx, idx + length).join(sep);
		}
		if (!reverse) return parts.slice(idx).join(sep);
		return parts.slice(0, idx).join(sep);
	};

	const pullDataIntoPackages = (filepath, size, isHead = true) => {
		const packageName = getPathPart(filepath, { part: "dist", offset: -1, length: 1 });
		if (!filePath) filePath = getPathPart(filepath, { part: "dist", reverse: true });
		const readableFilename = getPathPart(filepath, { part: "dist", offset: 1 });
		const fileMap = PACKAGES.has(packageName) ? PACKAGES.get(packageName) : new Map();
		if (!fileMap.has(readableFilename)) {
			fileMap.set(readableFilename, {
				headByteSize: isHead ? size : dataMap.get(filepath),
				baseByteSize: isHead ? baseMap.get(filepath) : size,
			});
		}
		PACKAGES.set(packageName, fileMap);
	};

	[...dataMap.entries()].forEach(([file, headByteSize]) => pullDataIntoPackages(file, headByteSize, true));
	[...baseMap.entries()].forEach(([file, baseByteSize]) => pullDataIntoPackages(file, baseByteSize, false));

	return { filePath, PACKAGES };
};
