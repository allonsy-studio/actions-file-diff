/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import { DEFAULT_MAX_DIFF_LINES, DEFAULT_MAX_DIFF_SIZE } from "./changes.js";
import { DEFAULT_REPORT_BRANCH } from "./publish.js";
import { DEFAULT_BUILD_DIR, DEFAULT_MAIN_FILE } from "./report.js";

/** Accepted values for the `visual-diff` input. */
export const VISUAL_DIFF_MODES = ["summary", "branch", "none"];

/** Characters a branch name may use here (a conservative subset of what git allows). */
const BRANCH_NAME = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * @typedef {object} Inputs
 * @property {string} token
 * @property {string} headPath
 * @property {string} basePath
 * @property {string[]} fileGlobPattern
 * @property {boolean} comment
 * @property {string} commentHeader
 * @property {string} buildDir
 * @property {string} mainFile
 * @property {boolean} readPackageJson
 * @property {string[]} extensions
 * @property {"summary"|"branch"|"none"} visualDiff
 * @property {string} reportBranch
 * @property {string} pagesUrl Empty, or a validated http(s) URL.
 * @property {number} maxDiffSize
 * @property {number} maxDiffLines
 */

/**
 * Reads and validates every action input in one place.
 * @param {{ getInput: Function, getMultilineInput: Function, getBooleanInput: Function }} core
 * @returns {Inputs}
 * @throws {Error} Naming the first input with an unusable value.
 */
export function readInputs(core) {
	const text = (name, fallback = "") => core.getInput(name).trim() || fallback;
	// An empty input falls back (local runs have no defaults from action.yml).
	const flag = (name, fallback) => (core.getInput(name) ? core.getBooleanInput(name) : fallback);
	const count = (name, fallback) => {
		const raw = text(name);
		if (!raw) return fallback;
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name} "${raw}"; expected a whole number of 0 or more.`);
		return value;
	};

	const visualDiff = text("visual-diff", "summary").toLowerCase();
	if (!VISUAL_DIFF_MODES.includes(visualDiff)) throw new Error(`Invalid visual-diff "${visualDiff}"; expected one of: ${VISUAL_DIFF_MODES.join(", ")}.`);

	const reportBranch = text("report-branch", DEFAULT_REPORT_BRANCH);
	if (!BRANCH_NAME.test(reportBranch) || reportBranch.includes("..") || reportBranch.endsWith(".lock") || reportBranch.endsWith(".")) throw new Error(`Invalid report-branch "${reportBranch}"; use letters, digits, ".", "_", "-" and "/" in a valid git branch name.`);

	const pagesUrl = text("pages-url");
	if (pagesUrl) {
		let url;
		try {
			url = new URL(pagesUrl);
		} catch {
			throw new Error(`Invalid pages-url "${pagesUrl}"; expected an http(s) URL.`);
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Invalid pages-url "${pagesUrl}"; expected an http(s) URL.`);
	}

	return {
		token: core.getInput("token"),
		headPath: core.getInput("head-path"),
		basePath: core.getInput("base-path"),
		fileGlobPattern: core.getMultilineInput("file-glob-pattern", { trimWhitespace: true }),
		comment: flag("comment", true),
		commentHeader: text("comment-header", "## File metrics"),
		buildDir: text("build-dir", DEFAULT_BUILD_DIR),
		mainFile: text("main-file", DEFAULT_MAIN_FILE),
		readPackageJson: flag("read-package-json", true),
		extensions: core.getMultilineInput("extensions", { trimWhitespace: true }),
		visualDiff,
		reportBranch,
		pagesUrl,
		maxDiffSize: count("max-diff-size", DEFAULT_MAX_DIFF_SIZE),
		maxDiffLines: count("max-diff-lines", DEFAULT_MAX_DIFF_LINES),
	};
}
