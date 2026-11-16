import { jest } from "@jest/globals";

import { publishToBranch, reportDir, reportUrl } from "./publish.js";

/** HTTP-style error as thrown by Octokit. */
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

/** Mock Octokit whose git API records calls. */
function mockOctokit({ ref, tree = [], pages } = {}) {
	let blobs = 0;
	const git = {
		createBlob: jest.fn(async () => ({ data: { sha: `blob${++blobs}` } })),
		getRef: jest.fn(async () => {
			if (!ref) throw httpError(404);
			return { data: { object: { sha: ref } } };
		}),
		getCommit: jest.fn(async () => ({ data: { tree: { sha: "basetree" } } })),
		getTree: jest.fn(async () => ({ data: { tree } })),
		createTree: jest.fn(async () => ({ data: { sha: "newtree" } })),
		createCommit: jest.fn(async () => ({ data: { sha: "newcommit" } })),
		createRef: jest.fn(async () => ({})),
		updateRef: jest.fn(async () => ({})),
	};
	const repos = {
		getPages: jest.fn(async () => {
			if (!pages) throw httpError(404);
			return { data: { html_url: pages } };
		}),
	};
	return { rest: { git, repos } };
}

const options = { owner: "o", repo: "r", branch: "reports", dir: "pr-1", message: "msg" };

describe("reportDir", () => {
	it("prefers the pull request number", () => {
		expect(reportDir({ pullNumber: 7, sha: "abc" })).toBe("pr-7");
		expect(reportDir({ sha: "0123456789abcdef" })).toBe("sha-0123456789ab");
		expect(reportDir({})).toBe("sha-unknown");
	});
});

describe("reportUrl", () => {
	it("uses an explicit base URL", async () => {
		await expect(reportUrl({ octokit: mockOctokit(), owner: "o", repo: "r", dir: "pr-1", pagesUrl: "https://docs.example/" })).resolves.toBe("https://docs.example/pr-1/");
	});

	it("uses the Pages API URL when available", async () => {
		await expect(reportUrl({ octokit: mockOctokit({ pages: "https://custom.dev/" }), owner: "o", repo: "r", dir: "pr-1" })).resolves.toBe("https://custom.dev/pr-1/");
	});

	it("falls back to the default Pages URL", async () => {
		await expect(reportUrl({ octokit: mockOctokit(), owner: "o", repo: "r", dir: "pr-1" })).resolves.toBe("https://o.github.io/r/pr-1/");
		await expect(reportUrl({ octokit: mockOctokit(), owner: "o", repo: "o.github.io", dir: "pr-1" })).resolves.toBe("https://o.github.io/pr-1/");
	});
});

describe("publishToBranch", () => {
	it("creates an orphan branch with .nojekyll", async () => {
		const octokit = mockOctokit();
		await expect(publishToBranch({ octokit, ...options, files: [{ path: "index.html", content: "<p>" }] })).resolves.toBe("newcommit");

		const { git } = octokit.rest;
		const paths = git.createTree.mock.calls[0][0].tree.map(({ path }) => path);
		expect(paths).toEqual(["pr-1/index.html", ".nojekyll"]);
		expect(git.createCommit.mock.calls[0][0].parents).toEqual([]);
		expect(git.createRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "refs/heads/reports", sha: "newcommit" }));
	});

	it("replaces the directory and deletes stale files on update", async () => {
		const tree = [
			{ path: "pr-1/index.html", type: "blob" },
			{ path: "pr-1/images/head/old.png", type: "blob" },
			{ path: "pr-2/index.html", type: "blob" },
		];
		const octokit = mockOctokit({ ref: "parent", tree });
		await publishToBranch({ octokit, ...options, files: [{ path: "index.html", content: "<p>" }] });

		const { git } = octokit.rest;
		const call = git.createTree.mock.calls[0][0];
		expect(call.base_tree).toBe("basetree");
		expect(call.tree).toEqual([
			{ path: "pr-1/index.html", mode: "100644", type: "blob", sha: "blob1" },
			{ path: "pr-1/images/head/old.png", mode: "100644", type: "blob", sha: null },
		]);
		expect(git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/reports", sha: "newcommit", force: false }));
	});

	it("removes a directory when given no files", async () => {
		const octokit = mockOctokit({ ref: "parent", tree: [{ path: "pr-1/index.html", type: "blob" }] });
		await expect(publishToBranch({ octokit, ...options, files: [] })).resolves.toBe("newcommit");
		expect(octokit.rest.git.createTree.mock.calls[0][0].tree).toEqual([{ path: "pr-1/index.html", mode: "100644", type: "blob", sha: null }]);
	});

	it("does nothing when there is nothing to remove", async () => {
		await expect(publishToBranch({ octokit: mockOctokit({ ref: "parent" }), ...options, files: [] })).resolves.toBeUndefined();
		await expect(publishToBranch({ octokit: mockOctokit(), ...options, files: [] })).resolves.toBeUndefined();
	});

	it("retries when the branch moved", async () => {
		const octokit = mockOctokit({ ref: "parent" });
		octokit.rest.git.updateRef.mockRejectedValueOnce(httpError(422));
		await expect(publishToBranch({ octokit, ...options, files: [{ path: "index.html", content: "x" }] })).resolves.toBe("newcommit");
		expect(octokit.rest.git.updateRef).toHaveBeenCalledTimes(2);
	});

	it("rethrows other errors", async () => {
		const octokit = mockOctokit();
		octokit.rest.git.getRef.mockRejectedValueOnce(httpError(403));
		await expect(publishToBranch({ octokit, ...options, files: [{ path: "index.html", content: "x" }] })).rejects.toThrow("HTTP 403");
	});
});
