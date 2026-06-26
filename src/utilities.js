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

function debugEmptyDirectory(path, pattern, { core }) {
	if (!existsSync(path)) {
		throw new Error(`The provided path does not exist in the workspace`);
	}

	function reportOnDirectoryFiles(p, { core, rootDir = p }) {
		readdirSync(p, { withFileTypes: true }).forEach((dirent) => {
			if (dirent.isFile()) {
				const file = join(p, dirent.name);
				if (dirent.name.startsWith(".")) return;
				core.info(`- ${relative(p, file)}  |  ${bytesToSize(statSync(file).size)}`);
			} else if (dirent.isDirectory()) {
				const dir = join(p, dirent.name);
				if (dirent.name.startsWith(".") || dirent.name === "node_modules") return;
				core.info(`${relative(rootDir, dir)}/`);
				reportOnDirectoryFiles(dir, { core, rootDir });
			}
		});
	}

	core.startGroup(`All files in ${path}`);
	reportOnDirectoryFiles(path, { core });
	core.endGroup();

	throw new Error(`No files found matching the glob pattern: ${pattern.map((p) => join(path, p)).join(", ")}`);
}

export function bytesToSize(bytes) {
	if (bytes === 0) return "0";
	if (!bytes) return "-";

	const sizes = ["bytes", "KB", "MB", "GB", "TB"];
	const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));

	if (i === 0) {
		const value = (bytes / 1000).toFixed(2);
		if (value === "0.00") return "< 0.01 KB";
		return value + " " + sizes[1];
	}

	return (bytes / Math.pow(1024, i)).toFixed(2) + " " + sizes[i];
}

export async function addComment({ search, content, token }) {
	const octokit = new getOctokit(token);

	const pullRequest = context.payload.pull_request;
	const owner = context.payload.repository.owner.login;
	const repo = context.payload.repository.name;

	if (!pullRequest) return;

	const commentData = { owner, repo };
	const comments = (await octokit.paginate(octokit.rest.issues.listComments, { ...commentData, issue_number: pullRequest.number })) ?? [];

	commentData.body = content;

	const existingComment = comments.reverse().find((comment) => comment?.user?.login === "github-actions[bot]" && comment?.user?.type === "Bot" && search.test(comment?.body));

	const action = existingComment ? "updateComment" : "createComment";

	if (existingComment) commentData.comment_id = existingComment.id;
	else commentData.issue_number = pullRequest.number;

	return octokit.rest.issues[action](commentData);
}

export async function fetchFilesAndSizes(rootPath, patterns = [], { core }) {
	if (!existsSync(rootPath)) return new Map();

	const globber = await create(patterns.map((f) => join(rootPath, f)).join("\n"));
	const files = await globber.glob();

	if (files.length === 0) {
		debugEmptyDirectory(rootPath, patterns, { core });
		return new Map();
	}

	core.info(`From ${rootPath}, found ${files.length} files matching the glob pattern ${patterns.join(", ")}.`);

	return new Map(
		files
			.map((f) => {
				const relativePath = relative(rootPath, f);
				const stat = statSync(f);
				if (!stat || stat.isDirectory()) return;
				return [relativePath, stat.size];
			})
			.filter(Boolean),
	);
}
