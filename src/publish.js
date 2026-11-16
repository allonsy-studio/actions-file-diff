/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

/** Default branch the HTML report is committed to. */
export const DEFAULT_REPORT_BRANCH = "file-diff-reports";

/** Attempts when the branch moves under a concurrent run. */
const MAX_ATTEMPTS = 3;

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

/**
 * Commits files under `dir` on `branch`, replacing whatever that directory held.
 * Creates the branch as an orphan (with `.nojekyll`) when missing. With no
 * files, the directory is removed. Retries when a concurrent run moved the branch.
 * @param {object} options
 * @param {object} options.octokit
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} options.branch
 * @param {string} options.dir
 * @param {ReportFile[]} options.files
 * @param {string} options.message
 * @returns {Promise<string|undefined>} New commit SHA, or undefined when nothing changed.
 */
export async function publishToBranch({ octokit, owner, repo, branch, dir, files, message }) {
	const { git } = octokit.rest;

	const blobs = await Promise.all(
		files.map(async ({ path, content }) => {
			const { data } = await git.createBlob({ owner, repo, content: Buffer.from(content).toString("base64"), encoding: "base64" });
			return { path: `${dir}/${path}`, mode: "100644", type: "blob", sha: data.sha };
		}),
	);

	for (let attempt = 1; ; attempt++) {
		let parent;
		try {
			parent = (await git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object.sha;
		} catch (error) {
			if (!isStatus(error, 404)) throw error;
		}

		if (!parent) {
			if (blobs.length === 0) return undefined;
			const nojekyll = (await git.createBlob({ owner, repo, content: "", encoding: "utf-8" })).data.sha;
			const tree = (await git.createTree({ owner, repo, tree: [...blobs, { path: ".nojekyll", mode: "100644", type: "blob", sha: nojekyll }] })).data.sha;
			const commit = (await git.createCommit({ owner, repo, message, tree, parents: [] })).data.sha;
			try {
				await git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit });
				return commit;
			} catch (error) {
				// Another run created the branch first; retry as an update.
				if (!isStatus(error, 422) || attempt >= MAX_ATTEMPTS) throw error;
				continue;
			}
		}

		const baseTree = (await git.getCommit({ owner, repo, commit_sha: parent })).data.tree.sha;
		const existing = (await git.getTree({ owner, repo, tree_sha: baseTree, recursive: "true" })).data.tree;
		const keep = new Set(blobs.map(({ path }) => path));
		const stale = existing.filter(({ path, type }) => type === "blob" && path.startsWith(`${dir}/`) && !keep.has(path)).map(({ path }) => ({ path, mode: "100644", type: "blob", sha: null }));

		const entries = [...blobs, ...stale];
		if (entries.length === 0) return undefined;

		const tree = (await git.createTree({ owner, repo, base_tree: baseTree, tree: entries })).data.sha;
		if (tree === baseTree) return undefined;
		const commit = (await git.createCommit({ owner, repo, message, tree, parents: [parent] })).data.sha;

		try {
			await git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit, force: false });
			return commit;
		} catch (error) {
			if (!isStatus(error, 422) || attempt >= MAX_ATTEMPTS) throw error;
		}
	}
}
