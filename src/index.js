/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { collectChanges, DEFAULT_MAX_DIFF_SIZE } from "./changes.js";
import { DEFAULT_REPORT_BRANCH, publishToBranch, reportDir, reportUrl } from "./publish.js";
import { renderStats, reportFiles, renderSummaryMarkdown, sizeRows, SUMMARY_BUDGET } from "./render.js";
import { buildReport, commentMarker, DEFAULT_BUILD_DIR, DEFAULT_MAIN_FILE } from "./report.js";
import { addComment, fetchFilesAndSizes } from "./utilities.js";

/** Accepted values for the `visual-diff` input. */
const VISUAL_DIFF_MODES = new Set(["summary", "branch", "none"]);

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

/**
 * Link to this workflow run's page, where the job summary is shown.
 * @returns {string|undefined} Undefined outside a runner.
 */
function runUrl() {
	const { GITHUB_SERVER_URL = "https://github.com", GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env;
	if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
	const attempt = GITHUB_RUN_ATTEMPT && GITHUB_RUN_ATTEMPT !== "1" ? `/attempts/${GITHUB_RUN_ATTEMPT}` : "";
	return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}${attempt}`;
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
	const visualDiff = (core.getInput("visual-diff") || "summary").trim().toLowerCase();
	const reportBranch = core.getInput("report-branch") || DEFAULT_REPORT_BRANCH;
	const pagesUrl = core.getInput("pages-url");
	const maxDiffSize = Number(core.getInput("max-diff-size") || DEFAULT_MAX_DIFF_SIZE);

	if (!VISUAL_DIFF_MODES.has(visualDiff)) throw new Error(`Invalid visual-diff "${visualDiff}"; expected one of: ${[...VISUAL_DIFF_MODES].join(", ")}.`);
	if (!Number.isFinite(maxDiffSize) || maxDiffSize < 0) throw new Error(`Invalid max-diff-size "${core.getInput("max-diff-size")}"; expected a byte count.`);

	const pullRequest = context.payload.pull_request;
	const dir = reportDir({ pullNumber: pullRequest?.number, sha: pullRequest?.head?.sha ?? context.sha });

	// A closed pull request only needs its published report removed.
	if (visualDiff === "branch" && pullRequest && context.payload.action === "closed") {
		const { owner, repo } = context.repo;
		const sha = await publishToBranch({ octokit: getOctokit(token), owner, repo, branch: reportBranch, dir, files: [], message: `chore: remove file diff report for #${pullRequest.number}` });
		core.info(sha ? `Removed ${dir}/ from ${reportBranch}.` : `Nothing to remove for ${dir}/ on ${reportBranch}.`);
		return;
	}

	const headMap = await fetchFilesAndSizes(headPath, fileGlobPattern, { core, required: true });
	const baseMap = await fetchFilesAndSizes(basePath, fileGlobPattern, { core, required: false });
	const hasBase = baseMap.size > 0;

	const report = buildReport({ headMap, baseMap, hasBase, rootPath: headPath, buildDir, mainFile, readPackageJson, extensions, core });

	let changes;
	let link;
	let summaryMarkdown = "";

	if (visualDiff !== "none") {
		changes = collectChanges({ headMap, baseMap, headRoot: headPath, baseRoot: basePath, extensions, maxDiffSize });
		const rows = sizeRows(report.sections);
		const totals = { headTotal: report.headTotal, baseTotal: report.baseTotal };

		if (visualDiff === "branch") {
			try {
				const octokit = getOctokit(token);
				const { owner, repo } = context.repo;
				const where = pullRequest ? `${owner}/${repo}#${pullRequest.number}` : `${owner}/${repo}`;
				const files = reportFiles({ title: commentHeader.replace(/^#+\s*/, "") || "File metrics", rows, hasBase, changes, totals, context: `${where} @ ${(pullRequest?.head?.sha ?? context.sha ?? "").slice(0, 7)}` });

				await publishToBranch({ octokit, owner, repo, branch: reportBranch, dir, files, message: `chore: file diff report for ${pullRequest ? `#${pullRequest.number}` : dir}` });
				link = await reportUrl({ octokit, owner, repo, dir, pagesUrl });
				core.info(`Published the visual diff to ${reportBranch}/${dir}/ (${link}).`);
			} catch (error) {
				// Fork PRs get a read-only token; fall back to the job summary.
				core.warning(`Unable to publish the visual diff to "${reportBranch}" (${error.message}). Falling back to the job summary; the token needs contents: write.`);
			}
		}

		const summaryLink = runUrl();
		summaryMarkdown = renderSummaryMarkdown({ rows, hasBase, changes, budget: Math.max(0, SUMMARY_BUDGET - Buffer.byteLength(report.text)), reportUrl: link });
		link ??= summaryLink;
	}

	const marker = commentMarker(commentHeader);
	const stats = changes ? renderStats({ stats: changes.stats, imageCount: changes.images.length }) : "";
	const commentStats = [stats, link ? `📊 [View the visual diff](${link})` : ""].filter(Boolean).join("<br/>\n");
	const content = [marker, commentHeader, "", ...(commentStats ? [commentStats, ""] : []), report.text].join("\n");

	if (shouldAddComment) {
		await addComment({ marker, content, token, core });
	}

	core.startGroup(commentHeader);
	core.info(report.text);
	core.endGroup();

	// The step summary file only exists on a runner; skip silently elsewhere.
	if (process.env.GITHUB_STEP_SUMMARY) {
		await core.summary.addRaw([commentHeader, "", ...(stats ? [stats, ""] : []), report.text, "", summaryMarkdown].join("\n"), true).write();
	}

	core.setOutput("total-size", String(report.headTotal));
	core.setOutput("has-changed", report.hasChanged ? "true" : "false");
	core.setOutput("report-url", link ?? "");
}

// Entry: errors propagate to setFailed at the top level only.
run().catch((error) => {
	core.error(error.stack ?? String(error));
	core.setFailed(error.message);
});
