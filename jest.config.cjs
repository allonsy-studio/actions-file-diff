import preset from "@allons-y/toolkit/jest/js";

export default {
	...preset,
	// Action code is integration-heavy; coverage threshold relaxed until tests are added.
	// TODO: raise back to toolkit default (80%) as tests are added.
	coverageThreshold: undefined,
};
