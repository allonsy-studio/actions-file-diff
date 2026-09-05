/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import * as core from "@actions/core";

import { fetchFilesAndSizes, addComment } from "./utilities.js";
import { buildReport, commentMarker, DEFAULT_BUILD_DIR, DEFAULT_MAIN_FILE } from "./report.js";

/**
 * Reads a boolean input, falling back when the input is empty (local runs).
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
function getBooleanInput(name, fallback) {
	if (!core.getInput(name)) return fallback;
	return core.getBooleanInput(name);
}

async function run() {
	const token = core.getInput("token");
	const headPath = core.getInput("head-path");
	const basePath = core.getInput("base-path");
	const fileGlobPattern = core.getMultilineInput("file-glob-pattern", { trimWhitespace: true });
	const shouldAddComment = getBooleanInput("comment", true);
	const commentHeader = core.getInput("comment-header") || "## File metrics";
	const buildDir = core.getInput("build-dir") || DEFAULT_BUILD_DIR;
	const mainFile = core.getInput("main-file") || DEFAULT_MAIN_FILE;
	const readPackageJson = getBooleanInput("read-package-json", true);
	const extensions = core.getMultilineInput("extensions", { trimWhitespace: true });

	const headMap = await fetchFilesAndSizes(headPath, fileGlobPattern, { core, required: true });
	const baseMap = await fetchFilesAndSizes(basePath, fileGlobPattern, { core, required: false });

	const report = buildReport({
		headMap,
		baseMap,
		hasBase: baseMap.size > 0,
		rootPath: headPath,
		buildDir,
		mainFile,
		readPackageJson,
		extensions,
		core,
	});

	const marker = commentMarker(commentHeader);
	const content = `${marker}\n${commentHeader}\n\n${report.text}`;

	if (shouldAddComment) {
		await addComment({ marker, content, token, core });
	}

	core.startGroup(commentHeader);
	core.info(report.text);
	core.endGroup();

	// The step summary file only exists on a runner; skip silently elsewhere.
	if (process.env.GITHUB_STEP_SUMMARY) {
		await core.summary.addRaw(`${commentHeader}\n\n${report.text}`, true).write();
	}

	core.setOutput("total-size", String(report.headTotal));
	core.setOutput("has-changed", report.hasChanged ? "true" : "false");
}

// Entry: errors propagate to setFailed at the top level only.
run().catch((error) => {
	core.error(error.stack ?? String(error));
	core.setFailed(error.message);
});
