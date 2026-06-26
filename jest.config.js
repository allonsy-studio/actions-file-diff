const isCI = !!process.env.CI;

/** @type {import('jest').Config} */
export default {
	clearMocks: true,
	moduleFileExtensions: ["js"],
	testEnvironment: "node",
	testMatch: ["**/src/*.test.js"],
	transform: {},
	verbose: true,
	// Unit-test the pure logic in utilities.js. The action entry shell
	// (index.js) and the GitHub/glob integration paths are exercised in the
	// e2e CI run rather than unit-tested.
	collectCoverageFrom: ["src/utilities.js"],
	coverageDirectory: "./coverage",
	coverageReporters: isCI ? ["cobertura", "json"] : ["text", "text-summary"],
	// Regression ratchet pinned at the currently-tested surface (bytesToSize).
	// Raise these as addComment and fetchFilesAndSizes gain tests.
	coverageThreshold: {
		global: {
			branches: 17,
			functions: 10,
			lines: 18,
			statements: 17,
		},
	},
};
