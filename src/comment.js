/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

/** Longest comment body GitHub accepts, in characters. */
export const COMMENT_LIMIT = 65536;

/**
 * Whether a comment is this action's sticky comment: written by a bot and
 * starting with the marker. Requiring a bot stops anyone else from posting the
 * marker to make the action try to edit their comment.
 * @param {{ body?: string|null, user?: { type?: string }|null }} comment
 * @param {string} marker
 * @returns {boolean}
 */
export function isStickyComment(comment, marker) {
	return comment?.user?.type === "Bot" && typeof comment.body === "string" && comment.body.startsWith(marker);
}

/**
 * Creates or updates the sticky pull request comment. Comment pages are read
 * one at a time and the search stops at the first match.
 * @param {object} options
 * @param {object} options.octokit
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {number} options.issueNumber Pull request number.
 * @param {string} options.marker Hidden HTML marker the body starts with.
 * @param {string} options.content Full comment body (including the marker).
 * @returns {Promise<{ action: "created"|"updated", id: number }>}
 */
export async function upsertComment({ octokit, owner, repo, issueNumber, marker, content }) {
	const pages = octokit.paginate.iterator(octokit.rest.issues.listComments, { owner, repo, issue_number: issueNumber, per_page: 100 });

	for await (const { data } of pages) {
		const existing = data.find((comment) => isStickyComment(comment, marker));
		if (existing) {
			await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: content });
			return { action: "updated", id: existing.id };
		}
	}

	const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: content });
	return { action: "created", id: data?.id };
}
