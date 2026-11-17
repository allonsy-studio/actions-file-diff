/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import { collectChanges } from "./changes.js";
import { COMMENT_LIMIT, upsertComment } from "./comment.js";
import { readInputs } from "./inputs.js";
import { reportFiles } from "./page.js";
import { publishToBranch, reportDir, reportUrl } from "./publish.js";
import { renderStats, renderSummaryMarkdown, sizeRows, SUMMARY_BUDGET } from "./render.js";
import { buildReport, commentMarker } from "./report.js";
import { fetchFilesAndSizes } from "./utilities.js";

/** Room kept in the comment for the marker, header, stats and links around the report. */
const COMMENT_RESERVE = 3000;

/**
 * Link to this workflow run's page, where the job summary is shown.
 * @param {Record<string, string|undefined>} env
 * @returns {string|undefined} Undefined outside a runner.
 */
export function runUrl(env) {
	const { GITHUB_SERVER_URL = "https://github.com", GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = env;
	if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
	const attempt = GITHUB_RUN_ATTEMPT && GITHUB_RUN_ATTEMPT !== "1" ? `/attempts/${GITHUB_RUN_ATTEMPT}` : "";
	return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}${attempt}`;
}

/**
 * Runs the action.
 * @param {object} deps
 * @param {object} deps.core `@actions/core`, or a stand-in.
 * @param {object} deps.context `@actions/github` context.
 * @param {(token: string) => object} deps.getOctokit
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<void>}
 */
export async function run({ core, context, getOctokit, env = process.env }) {
	const inputs = readInputs(core);
	const pullRequest = context.payload.pull_request;
	const dir = reportDir({ pullNumber: pullRequest?.number, sha: pullRequest?.head?.sha ?? context.sha });

	let client;
	/** One authenticated client, created only when something needs the API. */
	const octokit = () => (client ??= getOctokit(inputs.token));

	// A closed pull request only needs its published report removed.
	if (inputs.visualDiff === "branch" && pullRequest && context.payload.action === "closed") {
		const { owner, repo } = context.repo;
		const sha = await publishToBranch({ octokit: octokit(), owner, repo, branch: inputs.reportBranch, dir, files: [], message: `chore: remove file diff report for #${pullRequest.number}` });
		core.info(sha ? `Removed ${dir}/ from ${inputs.reportBranch}.` : `Nothing to remove for ${dir}/ on ${inputs.reportBranch}.`);
		return;
	}

	const [headMap, baseMap] = await Promise.all([fetchFilesAndSizes(inputs.headPath, inputs.fileGlobPattern, { core, required: true }), fetchFilesAndSizes(inputs.basePath, inputs.fileGlobPattern, { core, required: false })]);
	const hasBase = baseMap.size > 0;

	const reportOptions = { headMap, baseMap, hasBase, rootPath: inputs.headPath, buildDir: inputs.buildDir, mainFile: inputs.mainFile, readPackageJson: inputs.readPackageJson, extensions: inputs.extensions, core };
	const report = buildReport(reportOptions);
	/** The report, shortened to `limit` characters when it would be longer. */
	const reportWithin = (limit) => (report.text.length <= limit ? report : buildReport({ ...reportOptions, maxLength: limit }));

	let changes;
	let link;
	let summaryMarkdown = "";

	if (inputs.visualDiff !== "none") {
		changes = await collectChanges({ headMap, baseMap, headRoot: inputs.headPath, baseRoot: inputs.basePath, extensions: inputs.extensions, maxDiffSize: inputs.maxDiffSize, maxDiffLines: inputs.maxDiffLines, core });
		const rows = sizeRows(report.sections);
		const totals = { headTotal: report.headTotal, baseTotal: report.baseTotal };

		if (inputs.visualDiff === "branch") {
			try {
				const { owner, repo } = context.repo;
				const where = pullRequest ? `${owner}/${repo}#${pullRequest.number}` : `${owner}/${repo}`;
				const files = reportFiles({ title: inputs.commentHeader.replace(/^#+\s*/, "") || "File metrics", rows, hasBase, changes, totals, context: `${where} @ ${(pullRequest?.head?.sha ?? context.sha ?? "").slice(0, 7)}` });
				await publishToBranch({ octokit: octokit(), owner, repo, branch: inputs.reportBranch, dir, files, message: `chore: file diff report for ${pullRequest ? `#${pullRequest.number}` : dir}` });
				link = await reportUrl({ octokit: octokit(), owner, repo, dir, pagesUrl: inputs.pagesUrl });
				core.info(`Published the visual diff to ${inputs.reportBranch}/${dir}/ (${link}).`);
			} catch (error) {
				// Fork PRs get a read-only token; fall back to the job summary.
				core.warning(`Unable to publish the visual diff to "${inputs.reportBranch}" (${error.message}). Falling back to the job summary; the token needs contents: write.`);
			}
		}

		// GitHub caps a job summary at 1 MiB, so shorten the size tables first and give the diffs what's left.
		const summaryReport = reportWithin(SUMMARY_BUDGET / 2);
		summaryMarkdown = renderSummaryMarkdown({ rows, hasBase, changes, budget: Math.max(0, SUMMARY_BUDGET - Buffer.byteLength(summaryReport.text)), reportUrl: link });
		link ??= runUrl(env);
	}

	const marker = commentMarker(inputs.commentHeader);
	const stats = changes ? renderStats({ stats: changes.stats, imageCount: changes.images.length }) : "";
	const commentReport = reportWithin(COMMENT_LIMIT - COMMENT_RESERVE);
	const omittedNote = commentReport.omitted.files > 0 ? `<em>Some rows were left out to fit GitHub's comment limit.${link ? ` See the [full report](${link}).` : ""}</em>` : "";
	const commentStats = [stats, link ? `📊 [View the visual diff](${link})` : ""].filter(Boolean).join("<br/>\n");
	const content = [marker, inputs.commentHeader, "", ...(commentStats ? [commentStats, ""] : []), commentReport.text, ...(omittedNote ? ["", omittedNote] : [])].join("\n");

	if (inputs.comment) {
		if (!pullRequest) core.info("Not running on a pull request; skipping the comment.");
		else {
			try {
				const { owner, repo } = context.repo;
				const { action, id } = await upsertComment({ octokit: octokit(), owner, repo, issueNumber: pullRequest.number, marker, content });
				core.info(`${action === "created" ? "Posted" : "Updated"} the pull request comment (${id}).`);
			} catch (error) {
				// Fork PRs get a read-only token. The numbers are still in the log, the summary and the outputs.
				core.warning(`Unable to post the pull request comment (${error.message}). The report is in the job summary; grant pull-requests: write to post it.`);
			}
		}
	}

	core.startGroup(inputs.commentHeader);
	core.info(report.text);
	core.endGroup();

	// The step summary file only exists on a runner; skip silently elsewhere.
	if (env.GITHUB_STEP_SUMMARY) {
		const summaryReport = reportWithin(SUMMARY_BUDGET / 2);
		await core.summary.addRaw([inputs.commentHeader, "", ...(stats ? [stats, ""] : []), summaryReport.text, "", summaryMarkdown].join("\n"), true).write();
	}

	core.setOutput("total-size", String(report.headTotal));
	core.setOutput("has-changed", report.hasChanged ? "true" : "false");
	core.setOutput("report-url", link ?? "");
}
