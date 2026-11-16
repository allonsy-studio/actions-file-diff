const isCI = !!process.env.CI;

/** @type {import('jest').Config} */
export default {
	clearMocks: true,
	moduleFileExtensions: ["js", "css"],
	testEnvironment: "node",
	testMatch: ["**/src/*.test.js"],
	// Mirror the esbuild text loader for the report stylesheet.
	transform: { "\\.css$|\\.client\\.js$": "<rootDir>/scripts/jest-text-transform.js" },
	verbose: true,
	// Unit-test the logic modules. The action
	// entry shell (index.js) is exercised by the self-test workflow in
	// .github/workflows/self-test.yml.
	collectCoverageFrom: ["src/changes.js", "src/page.js", "src/publish.js", "src/render.js", "src/report.js", "src/utilities.js"],
	coverageDirectory: "./coverage",
	coverageReporters: isCI ? ["cobertura", "json"] : ["text", "text-summary"],
	// Regression ratchet set just under the current per-file coverage; jest
	// scopes a "global" threshold to files without their own entry, so each
	// file is pinned explicitly. Raise utilities.js as addComment gains tests.
	coverageThreshold: {
		"src/changes.js": {
			branches: 90,
			functions: 100,
			lines: 92,
			statements: 90,
		},
		"src/page.js": {
			branches: 80,
			functions: 95,
			lines: 95,
			statements: 95,
		},
		"src/publish.js": {
			branches: 75,
			functions: 100,
			lines: 92,
			statements: 88,
		},
		"src/render.js": {
			branches: 80,
			functions: 100,
			lines: 95,
			statements: 94,
		},
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
