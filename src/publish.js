/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import { mapLimit } from "./utilities.js";

/** Default branch the HTML report is committed to. */
export const DEFAULT_REPORT_BRANCH = "file-diff-reports";

/** Attempts when the branch moves under a concurrent run. */
const MAX_ATTEMPTS = 4;

/** Blob uploads in flight at once. GitHub asks clients not to hammer the API concurrently. */
const UPLOAD_CONCURRENCY = 6;

/**
 * @typedef {object} ReportFile
 * @property {string} path Path relative to the report directory.
 * @property {string|Buffer} content
 */

/**
 * Directory for a run's report: `pr-<n>` on pull requests, else `sha-<short>`.
 * @param {{ pullNumber?: number, sha?: string }} options
 * @returns {string}
 */
export function reportDir({ pullNumber, sha = "" }) {
	return pullNumber ? `pr-${pullNumber}` : `sha-${sha.slice(0, 12) || "unknown"}`;
}

/**
 * Public URL of a report directory. Uses the repository's Pages URL when the
 * API returns one, else the default `https://<owner>.github.io/<repo>/`.
 * @param {object} options
 * @param {object} options.octokit
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} options.dir
 * @param {string} [options.pagesUrl] Explicit base URL; skips the API lookup.
 * @returns {Promise<string>}
 */
export async function reportUrl({ octokit, owner, repo, dir, pagesUrl }) {
	let base = pagesUrl;
	if (!base) {
		try {
			base = (await octokit.rest.repos.getPages({ owner, repo })).data.html_url;
		} catch {
			base = repo.toLowerCase() === `${owner}.github.io`.toLowerCase() ? `https://${owner}.github.io/` : `https://${owner}.github.io/${repo}/`;
		}
	}
	return `${String(base).replace(/\/+$/, "")}/${dir}/`;
}

/**
 * Whether an Octokit error is an HTTP status.
 * @param {unknown} error
 * @param {number} status
 * @returns {boolean}
 */
const isStatus = (error, status) => error?.status === status;

/** Waits before a retry, with jitter so competing runs don't collide again. */
const defaultDelay = (attempt) => new Promise((resolve) => setTimeout(resolve, 200 * attempt + Math.random() * 300));

/**
 * Current commit of a branch, or undefined when it doesn't exist.
 * @returns {Promise<string|undefined>}
 */
async function branchHead({ git, owner, repo, branch }) {
	try {
		return (await git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object.sha;
	} catch (error) {
		if (isStatus(error, 404)) return undefined;
		throw error;
	}
}

/**
 * Deletion entries for files already under `dir` that the new report doesn't
 * contain. Reads only that directory's tree, never the whole branch.
 * @returns {Promise<Array<{ path: string, mode: string, type: string, sha: null }>>}
 * @throws {Error} When GitHub truncates a listing, since stale files would be missed.
 */
async function staleEntries({ git, owner, repo, baseTree, dir, keep }) {
	const root = (await git.getTree({ owner, repo, tree_sha: baseTree })).data;
	if (root.truncated) throw new Error("The report branch has too many top-level entries to list.");
	const entry = root.tree.find(({ path, type }) => path === dir && type === "tree");
	if (!entry) return [];

	const listing = (await git.getTree({ owner, repo, tree_sha: entry.sha, recursive: "true" })).data;
	if (listing.truncated) throw new Error(`${dir}/ has too many files to list on the report branch.`);
	return listing.tree
		.filter(({ type }) => type === "blob")
		.map(({ path }) => `${dir}/${path}`)
		.filter((path) => !keep.has(path))
		.map((path) => ({ path, mode: "100644", type: "blob", sha: null }));
}

/**
 * Commits files under `dir` on `branch`, replacing whatever that directory held
 * and leaving every other directory alone. With no files, the directory is removed.
 *
 * Each run writes a single parentless commit and moves the branch to it, so
 * older versions of a report become unreachable instead of piling up in history.
 * The branch is created (with `.nojekyll`) when missing.
 *
 * The branch is re-read just before it is moved, and the run starts over from
 * the new tree if another run moved it first. A run that lands inside the few
 * milliseconds between that check and the update can still overwrite the other
 * run's directory; that report returns on the pull request's next push.
 * @param {object} options
 * @param {object} options.octokit
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} options.branch
 * @param {string} options.dir
 * @param {ReportFile[]} options.files
 * @param {string} options.message
 * @param {(attempt: number) => Promise<void>} [options.delay] Wait before a retry.
 * @returns {Promise<string|undefined>} New commit SHA, or undefined when nothing changed.
 */
export async function publishToBranch({ octokit, owner, repo, branch, dir, files, message, delay = defaultDelay }) {
	const { git } = octokit.rest;
	const target = { git, owner, repo, branch };

	// Uploading blobs doesn't touch the branch, so do it once, before any retry.
	const blobs = await mapLimit(files, UPLOAD_CONCURRENCY, async ({ path, content }) => {
		const { data } = await git.createBlob({ owner, repo, content: Buffer.from(content).toString("base64"), encoding: "base64" });
		return { path: `${dir}/${path}`, mode: "100644", type: "blob", sha: data.sha };
	});
	const keep = new Set(blobs.map(({ path }) => path));

	for (let attempt = 1; ; attempt++) {
		const parent = await branchHead(target);

		let tree;
		if (parent) {
			const baseTree = (await git.getCommit({ owner, repo, commit_sha: parent })).data.tree.sha;
			const entries = [...blobs, ...(await staleEntries({ git, owner, repo, baseTree, dir, keep }))];
			if (entries.length === 0) return undefined;
			tree = (await git.createTree({ owner, repo, base_tree: baseTree, tree: entries })).data.sha;
			if (tree === baseTree) return undefined;
		} else {
			if (blobs.length === 0) return undefined;
			const nojekyll = (await git.createBlob({ owner, repo, content: "", encoding: "utf-8" })).data.sha;
			tree = (await git.createTree({ owner, repo, tree: [...blobs, { path: ".nojekyll", mode: "100644", type: "blob", sha: nojekyll }] })).data.sha;
		}

		const commit = (await git.createCommit({ owner, repo, message, tree, parents: [] })).data.sha;

		// Another run moved the branch while this one worked: rebuild from its tree.
		const moved = (await branchHead(target)) !== parent;
		if (!moved) {
			try {
				if (parent) await git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit, force: true });
				else await git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit });
				return commit;
			} catch (error) {
				// createRef fails with 422 when a concurrent run created the branch first.
				if (!isStatus(error, 422)) throw error;
			}
		}

		if (attempt >= MAX_ATTEMPTS) throw new Error(`The report branch "${branch}" kept changing underneath this run; gave up after ${MAX_ATTEMPTS} attempts.`);
		await delay(attempt);
	}
}
