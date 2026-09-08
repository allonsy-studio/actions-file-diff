const isCI = !!process.env.CI;

/** @type {import('jest').Config} */
export default {
	clearMocks: true,
	moduleFileExtensions: ["js"],
	testEnvironment: "node",
	testMatch: ["**/src/*.test.js"],
	transform: {},
	verbose: true,
	// Unit-test the pure logic in report.js and utilities.js. The action
	// entry shell (index.js) is exercised by the self-test workflow in
	// .github/workflows/self-test.yml.
	collectCoverageFrom: ["src/report.js", "src/utilities.js"],
	coverageDirectory: "./coverage",
	coverageReporters: isCI ? ["cobertura", "json"] : ["text", "text-summary"],
	// Regression ratchet set just under the current per-file coverage; jest
	// scopes a "global" threshold to files without their own entry, so each
	// file is pinned explicitly. Raise utilities.js as addComment gains tests.
	coverageThreshold: {
		"src/report.js": {
			branches: 80,
			functions: 95,
			lines: 95,
			statements: 95,
		},
		"src/utilities.js": {
			branches: 68,
			functions: 82,
			lines: 74,
			statements: 75,
		},
	},
};
