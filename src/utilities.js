/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import { statSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { getOctokit, context } from "@actions/github";
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

/**
 * Formats a byte count as a human readable size using 1024-based units.
 * @param {number|undefined|null} bytes
 * @returns {string}
 */
export function bytesToSize(bytes) {
	if (bytes === 0) return "0";
	if (!bytes) return "-";

	const sizes = ["bytes", "KB", "MB", "GB", "TB"];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);

	if (i === 0) {
		const value = (bytes / 1024).toFixed(2);
		if (value === "0.00") return "< 0.01 KB";
		return `${value} ${sizes[1]}`;
	}

	return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Creates or updates the sticky pull request comment. The existing comment is
 * found by the marker at the start of its body, regardless of author.
 * @param {object} options
 * @param {string} options.marker Hidden HTML marker the body starts with.
 * @param {string} options.content Full comment body (including the marker).
 * @param {string} options.token GitHub token.
 * @param {{ info?: Function }} [options.core]
 * @returns {Promise<object|undefined>} The API response, or undefined outside a pull request.
 */
export async function addComment({ marker, content, token, core }) {
	const pullRequest = context.payload.pull_request;
	if (!pullRequest) {
		core?.info?.("Not running on a pull request; skipping the comment.");
		return;
	}

	const octokit = getOctokit(token);
	const { owner, repo } = context.repo;
	const issue_number = pullRequest.number;

	const comments = (await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number })) ?? [];
	const existingComment = [...comments].reverse().find((comment) => typeof comment?.body === "string" && comment.body.startsWith(marker));

	if (existingComment) {
		return octokit.rest.issues.updateComment({ owner, repo, comment_id: existingComment.id, body: content });
	}

	return octokit.rest.issues.createComment({ owner, repo, issue_number, body: content });
}

/**
 * Globs a root path and returns a map of relative file path → size in bytes.
 * A required root must exist and match at least one file (otherwise throws);
 * an optional root that is missing or unmatched yields an empty map.
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

	const globber = await create(globPatterns(rootPath, patterns).join("\n"), { matchDirectories: false });
	const files = (await globber.glob()).filter((f) => {
		const stat = statSync(f, { throwIfNoEntry: false });
		return stat && stat.isFile();
	});

	if (files.length === 0) {
		if (required) debugEmptyDirectory(rootPath, patterns, { core });
		core.warning(`From ${rootPath}, no files matched the glob pattern ${patterns.join(", ")}; continuing without a base.`);
		return new Map();
	}

	core.info(`From ${rootPath}, found ${files.length} files matching the glob pattern ${patterns.join(", ")}.`);

	return new Map(files.map((f) => [relative(rootPath, f), statSync(f).size]));
}
