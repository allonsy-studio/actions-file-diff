import { jest } from "@jest/globals";

import { isStickyComment, upsertComment } from "./comment.js";

const MARKER = "<!-- actions-file-diff:file-metrics -->";
const bot = (id, body) => ({ id, body, user: { type: "Bot" } });
const person = (id, body) => ({ id, body, user: { type: "User" } });

/** Octokit stub whose iterator yields the given pages. */
function octokitWith(pages) {
	const seen = [];
	return {
		seen,
		paginate: {
			iterator: jest.fn(() =>
				(async function* () {
					for (const data of pages) {
						seen.push(data);
						yield { data };
					}
				})(),
			),
		},
		rest: {
			issues: {
				listComments: jest.fn(),
				updateComment: jest.fn(async () => ({})),
				createComment: jest.fn(async () => ({ data: { id: 99 } })),
			},
		},
	};
}

const args = { owner: "o", repo: "r", issueNumber: 7, marker: MARKER, content: `${MARKER}\nbody` };

describe("isStickyComment", () => {
	it("requires a bot author and the marker prefix", () => {
		expect(isStickyComment(bot(1, `${MARKER}\nx`), MARKER)).toBe(true);
		expect(isStickyComment(person(1, `${MARKER}\nx`), MARKER)).toBe(false);
		expect(isStickyComment(bot(1, `text ${MARKER}`), MARKER)).toBe(false);
		expect(isStickyComment({ id: 1, body: null, user: { type: "Bot" } }, MARKER)).toBe(false);
		expect(isStickyComment({ id: 1, body: MARKER }, MARKER)).toBe(false);
	});
});

describe("upsertComment", () => {
	it("updates the bot's comment and stops reading further pages", async () => {
		const octokit = octokitWith([[person(1, "hi"), bot(2, `${MARKER}\nold`)], [bot(3, "later page")]]);
		await expect(upsertComment({ octokit, ...args })).resolves.toEqual({ action: "updated", id: 2 });
		expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({ owner: "o", repo: "r", comment_id: 2, body: args.content });
		expect(octokit.seen).toHaveLength(1);
		expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
	});

	it("ignores someone else's comment that starts with the marker", async () => {
		const octokit = octokitWith([[person(1, `${MARKER}\nspoof`)]]);
		await expect(upsertComment({ octokit, ...args })).resolves.toEqual({ action: "created", id: 99 });
		expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
	});

	it("creates the comment when none exists", async () => {
		const octokit = octokitWith([[], []]);
		await expect(upsertComment({ octokit, ...args })).resolves.toEqual({ action: "created", id: 99 });
		expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 7, body: args.content });
		expect(octokit.paginate.iterator).toHaveBeenCalledWith(octokit.rest.issues.listComments, expect.objectContaining({ per_page: 100, issue_number: 7 }));
	});
});
