import { bytesToSize } from "./utilities.js";

describe("bytesToSize", () => {
	it("returns '-' for falsy input", () => {
		// NB: 0 also hits the `!bytes` guard and returns "-", so the
		// `bytes === 0` branch in the source is currently unreachable.
		expect(bytesToSize(0)).toBe("-");
		expect(bytesToSize(undefined)).toBe("-");
		expect(bytesToSize(null)).toBe("-");
	});

	it("uses '< 0.01 KB' for values that round to zero", () => {
		expect(bytesToSize(1)).toBe("< 0.01 KB");
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

	it("formats GB values", () => {
		expect(bytesToSize(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
	});
});
