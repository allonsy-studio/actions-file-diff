// TODO: enable once index.js/utilities.js are converted from CJS require() to ESM import.
// @actions/github@9.x ships ESM-only — the current CJS source can't load it in jest or at runtime.
// Once migrated, remove `describe.skip` and the manual mocks (jest.mock entries below) are likely
// unnecessary because each utility can be imported in isolation.
jest.mock("@actions/github", () => ({ getOctokit: jest.fn(), context: { payload: {} } }));
jest.mock("@actions/glob", () => ({ create: jest.fn() }));

const { bytesToSize } = require("./utilities.js");

describe.skip("bytesToSize", () => {
	it("returns '-' for falsy input", () => {
		expect(bytesToSize(0)).toBe("0");
		expect(bytesToSize(undefined)).toBe("-");
		expect(bytesToSize(null)).toBe("-");
	});

	it("formats sub-KB values", () => {
		expect(bytesToSize(512)).toBe("0.51 KB");
	});

	it("formats KB values", () => {
		expect(bytesToSize(2048)).toBe("2.00 KB");
	});

	it("formats MB values", () => {
		expect(bytesToSize(5 * 1024 * 1024)).toBe("5.00 MB");
	});

	it("uses '< 0.01 KB' for very small values", () => {
		expect(bytesToSize(1)).toBe("< 0.01 KB");
	});
});
