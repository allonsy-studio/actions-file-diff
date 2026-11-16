import { jest } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { startFakeGitHub } from "../test/fake-github.js";
import { run, runUrl } from "./run.js";

/** A stand-in for `@actions/core` that records what the action does. */
function makeCore(values) {
	const state = { outputs: {}, info: [], warnings: [], summary: undefined };
	return {
		state,
		getInput: (name) => values[name] ?? "",
		getMultilineInput: (name) =>
			(values[name] ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		getBooleanInput: (name) => values[name] === "true",
		info: (message) => state.info.push(message),
		warning: (message) => state.warnings.push(message),
		startGroup: () => {},
		endGroup: () => {},
		setOutput: (name, value) => (state.outputs[name] = value),
		summary: {
			addRaw(text) {
				state.summary = text;
				return this;
			},
			write: async () => {},
		},
	};
}

const put = (root, files) =>
	Object.entries(files).forEach(([path, content]) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	});

const prContext = (extra = {}) => ({ payload: { pull_request: { number: 7, head: { sha: "abcdef1234567890" } }, ...extra }, sha: "deadbeef", repo: { owner: "o", repo: "r" } });

describe("runUrl", () => {
	it("links the run, with the attempt on re-runs", () => {
		expect(runUrl({ GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "5" })).toBe("https://github.com/o/r/actions/runs/5");
		expect(runUrl({ GITHUB_SERVER_URL: "https://ghe.example", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "5", GITHUB_RUN_ATTEMPT: "2" })).toBe("https://ghe.example/o/r/actions/runs/5/attempts/2");
		expect(runUrl({ GITHUB_RUN_ATTEMPT: "1" })).toBeUndefined();
	});
});

describe("run", () => {
	let dir;
	let head;
	let base;
	let fake;
	let octokit;
	let getOctokit;

	/** Common inputs; override per test. */
	const inputs = (extra = {}) => ({ "head-path": head, "base-path": base, "file-glob-pattern": "**/dist/**", token: "t", ...extra });
	const go = (values, { context = prContext(), env = {} } = {}) => {
		const core = makeCore(values);
		return run({ core, context, getOctokit: () => octokit, env }).then(() => core.state);
	};

	beforeAll(async () => {
		// @actions/github chooses its (proxy-aware) fetch when it first loads; aim it at the local fake.
		process.env.GITHUB_API_URL = "http://127.0.0.1";
		process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1";
		({ getOctokit } = await import("@actions/github"));
	});

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "run-"));
		head = join(dir, "head");
		base = join(dir, "base");
		put(head, { "packages/foo/package.json": '{"main":"dist/index.css"}', "packages/foo/dist/index.css": "a\nb\nc\n" });
		put(base, { "packages/foo/package.json": '{"main":"dist/index.css"}', "packages/foo/dist/index.css": "a\n" });
		fake = await startFakeGitHub();
		octokit = getOctokit("t", { baseUrl: fake.url });
	});

	afterEach(async () => {
		await fake.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("measures, writes outputs and the summary, and skips the comment outside a pull request", async () => {
		const state = await go(inputs(), { context: { payload: {}, sha: "deadbeef", repo: { owner: "o", repo: "r" } }, env: { GITHUB_STEP_SUMMARY: "set", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "9" } });
		expect(state.outputs).toEqual({ "total-size": "6", "has-changed": "true", "report-url": "https://github.com/o/r/actions/runs/9" });
		expect(state.info).toContain("Not running on a pull request; skipping the comment.");
		expect(state.summary).toContain("Line diffs (1)");
		expect(fake.comments).toEqual([]);
	});

	it("publishes the page, links it in one sticky comment, and updates that comment on the next run", async () => {
		const values = inputs({ "visual-diff": "branch", "pages-url": "https://o.github.io/r/" });
		const first = await go(values);
		expect(first.outputs["report-url"]).toBe("https://o.github.io/r/pr-7/");
		expect(Object.keys(fake.files("file-diff-reports")).sort()).toEqual([".nojekyll", "pr-7/index.html"]);
		expect(fake.comments).toHaveLength(1);
		expect(fake.comments[0].body).toContain("[View the visual diff](https://o.github.io/r/pr-7/)");
		expect(fake.comments[0].body).toContain("**Changed files**: 1");

		put(head, { "packages/foo/dist/index.css": "a\nb\nc\nd\n" });
		const second = await go(values);
		expect(second.info.some((line) => line.startsWith("Updated the pull request comment"))).toBe(true);
		expect(fake.comments).toHaveLength(1);
		expect(fake.history("file-diff-reports")).toBe(1);
	});

	it("removes the report when the pull request closes and posts nothing", async () => {
		const values = inputs({ "visual-diff": "branch", "pages-url": "https://o.github.io/r/" });
		await go(values);
		const state = await go(values, { context: prContext({ action: "closed" }) });
		expect(state.info.some((line) => line.startsWith("Removed pr-7/"))).toBe(true);
		expect(fake.files("file-diff-reports")).toEqual({ ".nojekyll": "" });
		expect(state.outputs).toEqual({});
		expect(fake.comments).toHaveLength(1);
	});

	it("falls back to the job summary link when publishing fails", async () => {
		octokit = { rest: { git: { createBlob: async () => Promise.reject(Object.assign(new Error("Resource not accessible by integration"), { status: 403 })) } }, paginate: { iterator: () => (async function* () {})() } };
		octokit.rest.issues = { listComments: () => {}, createComment: async () => ({ data: { id: 1 } }) };
		const state = await go(inputs({ "visual-diff": "branch" }), { env: { GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "9" } });
		expect(state.warnings.join("\n")).toMatch(/Unable to publish the visual diff.*Resource not accessible/);
		expect(state.outputs["report-url"]).toBe("https://github.com/o/r/actions/runs/9");
	});

	it("warns, not fails, when the comment can't be posted", async () => {
		octokit = {
			paginate: {
				iterator: () => ({
					[Symbol.asyncIterator]: () => ({
						next: async () => {
							throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
						},
					}),
				}),
			},
			rest: { issues: { listComments: () => {} } },
		};
		const state = await go(inputs());
		expect(state.warnings.join("\n")).toMatch(/Unable to post the pull request comment \(Resource not accessible/);
		expect(state.outputs["total-size"]).toBe("6");
	});

	it("keeps the comment under GitHub's limit and says what was left out", async () => {
		const many = (size) => Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`packages/big/dist/file${i}.js`, "x".repeat((i % 50) + size)]));
		put(head, { "packages/big/package.json": '{"main":"dist/file0.js"}', ...many(2) });
		put(base, { "packages/big/package.json": '{"main":"dist/file0.js"}', ...many(1) });
		const state = await go(inputs({ "visual-diff": "none" }), { env: { GITHUB_RUN_ID: "1" } });
		expect(fake.comments[0].body.length).toBeLessThanOrEqual(65536);
		expect(fake.comments[0].body).toMatch(/more files not shown/);
		expect(fake.comments[0].body).toContain("Some rows were left out to fit GitHub's comment limit.");
		expect(state.outputs["report-url"]).toBe("");
	});

	it("turns the visual diff off", async () => {
		const state = await go(inputs({ "visual-diff": "none" }));
		expect(fake.comments[0].body).not.toContain("View the visual diff");
		expect(fake.comments[0].body).not.toContain("**Changed files**");
		expect(state.outputs["report-url"]).toBe("");
	});

	it("rejects invalid inputs before doing any work", async () => {
		await expect(go(inputs({ "visual-diff": "pdf" }))).rejects.toThrow(/Invalid visual-diff/);
		expect(fake.calls).toEqual([]);
	});

	it("fails with a clear message when the head path is missing", async () => {
		await expect(go(inputs({ "head-path": join(dir, "nope") }))).rejects.toThrow(/does not exist/);
	});

	it("doesn't touch the API when there is nothing to send", async () => {
		const spy = jest.fn(() => octokit);
		const core = makeCore(inputs({ comment: "false", "visual-diff": "summary" }));
		await run({ core, context: prContext(), getOctokit: spy, env: {} });
		expect(spy).not.toHaveBeenCalled();
	});
});
