import { jest } from "@jest/globals";

import { startFakeGitHub } from "../test/fake-github.js";
import { publishToBranch, reportDir, reportUrl } from "./publish.js";

const noDelay = async () => {};
const page = (content) => ({ path: "index.html", content });

describe("reportDir", () => {
	it("prefers the pull request number", () => {
		expect(reportDir({ pullNumber: 7, sha: "abc" })).toBe("pr-7");
		expect(reportDir({ sha: "0123456789abcdef" })).toBe("sha-0123456789ab");
		expect(reportDir({})).toBe("sha-unknown");
	});
});

describe("reportUrl", () => {
	const octokitWith = (getPages) => ({ rest: { repos: { getPages } } });
	const notFound = () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));

	it("uses an explicit base URL without asking the API", async () => {
		const getPages = jest.fn();
		await expect(reportUrl({ octokit: octokitWith(getPages), owner: "o", repo: "r", dir: "pr-1", pagesUrl: "https://docs.example/" })).resolves.toBe("https://docs.example/pr-1/");
		expect(getPages).not.toHaveBeenCalled();
	});

	it("uses the Pages API URL when available", async () => {
		const octokit = octokitWith(async () => ({ data: { html_url: "https://custom.dev/" } }));
		await expect(reportUrl({ octokit, owner: "o", repo: "r", dir: "pr-1" })).resolves.toBe("https://custom.dev/pr-1/");
	});

	it("falls back to the default Pages URL", async () => {
		await expect(reportUrl({ octokit: octokitWith(notFound), owner: "o", repo: "r", dir: "pr-1" })).resolves.toBe("https://o.github.io/r/pr-1/");
		await expect(reportUrl({ octokit: octokitWith(notFound), owner: "o", repo: "o.github.io", dir: "pr-1" })).resolves.toBe("https://o.github.io/pr-1/");
	});
});

describe("publishToBranch", () => {
	let fake;
	let octokit;
	const options = () => ({ octokit, owner: "o", repo: "r", branch: "reports", message: "msg", delay: noDelay });
	const publish = (dir, files) => publishToBranch({ ...options(), dir, files });

	let getOctokit;

	beforeAll(async () => {
		// @actions/github chooses its (proxy-aware) fetch when it first loads, from GITHUB_API_URL and the
		// proxy variables, so point both at the local fake before importing it.
		process.env.GITHUB_API_URL = "http://127.0.0.1";
		process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1";
		({ getOctokit } = await import("@actions/github"));
	});

	beforeEach(async () => {
		fake = await startFakeGitHub();
		octokit = getOctokit("token", { baseUrl: fake.url });
	});

	afterEach(() => fake.close());

	it("creates the branch with .nojekyll and the report", async () => {
		await expect(publish("pr-1", [page("<p>one</p>"), { path: "images/head/a.png", content: Buffer.from("png") }])).resolves.toEqual(expect.any(String));
		expect(fake.files("reports")).toEqual({ ".nojekyll": "", "pr-1/index.html": "<p>one</p>", "pr-1/images/head/a.png": "png" });
		expect(fake.commit("reports").parents).toEqual([]);
	});

	it("replaces its own directory, drops stale files and leaves other reports alone", async () => {
		await publish("pr-1", [page("v1"), { path: "images/head/old.png", content: "old" }]);
		await publish("pr-2", [page("two")]);
		await publish("pr-1", [page("v2"), { path: "images/head/new.png", content: "new" }]);
		expect(fake.files("reports")).toEqual({ ".nojekyll": "", "pr-1/index.html": "v2", "pr-1/images/head/new.png": "new", "pr-2/index.html": "two" });
	});

	it("keeps no history: every run is one parentless commit", async () => {
		await publish("pr-1", [page("v1")]);
		await publish("pr-1", [page("v2")]);
		await publish("pr-2", [page("v3")]);
		expect(fake.history("reports")).toBe(1);
		expect(fake.commit("reports").parents).toEqual([]);
	});

	it("removes a directory when given no files and does nothing when there is nothing to remove", async () => {
		await publish("pr-1", [page("one")]);
		await publish("pr-2", [page("two")]);
		const head = fake.head("reports");
		await expect(publish("pr-1", [])).resolves.toEqual(expect.any(String));
		expect(fake.files("reports")).toEqual({ ".nojekyll": "", "pr-2/index.html": "two" });

		const after = fake.head("reports");
		expect(after).not.toBe(head);
		await expect(publish("pr-1", [])).resolves.toBeUndefined();
		expect(fake.head("reports")).toBe(after);
		await expect(publishToBranch({ ...options(), branch: "missing", dir: "pr-1", files: [] })).resolves.toBeUndefined();
	});

	it("does not move the branch when the report is unchanged", async () => {
		await publish("pr-1", [page("same")]);
		const head = fake.head("reports");
		await expect(publish("pr-1", [page("same")])).resolves.toBeUndefined();
		expect(fake.head("reports")).toBe(head);
	});

	it("uploads blobs with bounded concurrency", async () => {
		const files = Array.from({ length: 24 }, (_, i) => ({ path: `images/${i}.png`, content: `image ${i}` }));
		await publish("pr-1", files);
		expect(fake.stats.blobUploads).toBe(25);
		expect(fake.stats.peakBlobUploads).toBeGreaterThan(1);
		expect(fake.stats.peakBlobUploads).toBeLessThanOrEqual(6);
	});

	it("lists only the report's own directory, not the whole branch", async () => {
		for (let i = 0; i < 5; i++) await publish(`pr-${i}`, [page(`page ${i}`), { path: "images/a.png", content: `img ${i}` }]);
		fake.calls.length = 0;
		await publish("pr-3", [page("changed")]);
		expect(fake.calls.filter((call) => call.startsWith("GET") && call.includes("/git/trees/"))).toHaveLength(2);
	});

	it("starts over from the new tree when another run moves the branch mid-publish", async () => {
		await publish("pr-1", [page("one")]);
		let reads = 0;
		// Reads inside a publish: 1 = current head, 2 = recheck just before moving the branch.
		fake.hooks.beforeGetRef = () => {
			if (++reads === 2) fake.commitDirect("reports", { "pr-9/index.html": "pushed by another run" });
		};
		await publish("pr-1", [page("two")]);
		expect(fake.files("reports")).toMatchObject({ "pr-1/index.html": "two", "pr-9/index.html": "pushed by another run" });
	});

	it("waits a moment before retrying when no delay is injected", async () => {
		await publish("pr-1", [page("one")]);
		let reads = 0;
		fake.hooks.beforeGetRef = () => {
			if (++reads === 2) fake.commitDirect("reports", { "pr-9/index.html": "other" });
		};
		const started = Date.now();
		await publishToBranch({ ...options(), delay: undefined, dir: "pr-1", files: [page("two")] });
		expect(Date.now() - started).toBeGreaterThanOrEqual(190);
		expect(fake.files("reports")).toMatchObject({ "pr-1/index.html": "two", "pr-9/index.html": "other" });
	});

	it("recovers when another run creates the branch first", async () => {
		let reads = 0;
		fake.hooks.beforeGetRef = () => {
			if (++reads === 2) fake.commitDirect("reports", { "pr-9/index.html": "first" });
		};
		await publish("pr-1", [page("mine")]);
		expect(fake.files("reports")).toMatchObject({ "pr-1/index.html": "mine", "pr-9/index.html": "first" });
	});

	it("gives up after repeated conflicts", async () => {
		await publish("pr-1", [page("one")]);
		let reads = 0;
		fake.hooks.beforeGetRef = () => {
			// Every recheck (even-numbered read) sees a new head.
			if (++reads % 2 === 0) fake.commitDirect("reports", { [`noise/${reads}`]: "x" });
		};
		await expect(publish("pr-1", [page("two")])).rejects.toThrow(/kept changing/);
	});

	it("refuses to publish when a listing is truncated, since stale files would be missed", async () => {
		await fake.close();
		fake = await startFakeGitHub({ truncateAt: 3 });
		octokit = getOctokit("token", { baseUrl: fake.url });
		await publish("pr-1", [page("a"), { path: "images/1.png", content: "1" }, { path: "images/2.png", content: "2" }, { path: "images/3.png", content: "3" }]);
		await expect(publish("pr-1", [page("b")])).rejects.toThrow(/too many files/);
	});

	it("surfaces unexpected API errors", async () => {
		const failing = { rest: { git: { createBlob: async () => ({ data: { sha: "x" } }), getRef: async () => Promise.reject(Object.assign(new Error("boom"), { status: 500 })) } } };
		await expect(publishToBranch({ ...options(), octokit: failing, dir: "pr-1", files: [page("x")] })).rejects.toThrow("boom");
	});
});
