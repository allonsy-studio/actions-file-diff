import { readInputs, VISUAL_DIFF_MODES } from "./inputs.js";

/** A stand-in for `@actions/core` reading from a plain object. */
const coreWith = (values = {}) => ({
	getInput: (name) => values[name] ?? "",
	getMultilineInput: (name) =>
		(values[name] ?? "")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	getBooleanInput: (name) => {
		if (values[name] === "true") return true;
		if (values[name] === "false") return false;
		throw new TypeError(`Input does not meet YAML 1.2 "Core Schema" specification: ${name}`);
	},
});

describe("readInputs", () => {
	it("falls back to defaults for empty inputs", () => {
		expect(readInputs(coreWith())).toEqual({
			token: "",
			headPath: "",
			basePath: "",
			fileGlobPattern: [],
			comment: true,
			commentHeader: "## File metrics",
			buildDir: "dist",
			mainFile: "index.js",
			readPackageJson: true,
			extensions: [],
			visualDiff: "summary",
			reportBranch: "file-diff-reports",
			pagesUrl: "",
			maxDiffSize: 256 * 1024,
			maxDiffLines: 20000,
		});
	});

	it("reads and normalizes provided values", () => {
		const inputs = readInputs(coreWith({ "visual-diff": " Branch ", "report-branch": "reports/diffs", "pages-url": "https://example.com/docs/", "max-diff-size": "1024", "max-diff-lines": "0", comment: "false", "read-package-json": "false", extensions: "css\njs", "file-glob-pattern": "**/dist/**\n!**/*.map", "comment-header": "  ## CSS  " }));
		expect(inputs).toMatchObject({ visualDiff: "branch", reportBranch: "reports/diffs", pagesUrl: "https://example.com/docs/", maxDiffSize: 1024, maxDiffLines: 0, comment: false, readPackageJson: false, extensions: ["css", "js"], fileGlobPattern: ["**/dist/**", "!**/*.map"], commentHeader: "## CSS" });
	});

	it.each([
		[{ "visual-diff": "html" }, /Invalid visual-diff "html"/],
		[{ "max-diff-size": "-1" }, /Invalid max-diff-size "-1"/],
		[{ "max-diff-size": "1.5" }, /Invalid max-diff-size "1.5"/],
		[{ "max-diff-size": "lots" }, /Invalid max-diff-size "lots"/],
		[{ "max-diff-lines": "1e400" }, /Invalid max-diff-lines/],
		[{ "report-branch": "has space" }, /Invalid report-branch/],
		[{ "report-branch": "a..b" }, /Invalid report-branch/],
		[{ "report-branch": "/leading" }, /Invalid report-branch/],
		[{ "report-branch": "ends.lock" }, /Invalid report-branch/],
		[{ "pages-url": "not a url" }, /Invalid pages-url/],
		[{ "pages-url": "javascript:alert(1)" }, /Invalid pages-url/],
		[{ comment: "maybe" }, /YAML 1.2/],
	])("rejects %j", (values, message) => {
		expect(() => readInputs(coreWith(values))).toThrow(message);
	});

	it("lists the visual-diff modes", () => {
		expect(VISUAL_DIFF_MODES).toEqual(["summary", "branch", "none"]);
	});
});
