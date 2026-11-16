/**
 * Writes a head/base fixture that exercises every part of the visual diff:
 * modified, added and removed text files, a binary file, a file over
 * max-diff-size, and modified/added/removed PNG and SVG images.
 * @module
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync, gzipSync } from "node:zlib";

/**
 * Encodes an RGBA pixel function as a PNG.
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number, number]} pixel
 * @returns {Buffer}
 */
export function png(width, height, pixel) {
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0;
		for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
	}
	const chunk = (type, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 6, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Diagonal two-color gradient. */
const gradient = (from, to) => (x, y) => {
	const t = (x + y) / 254;
	return [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * t)).concat(255);
};

/** Circle on a transparent background. */
const circle = (color, r) => (x, y) => ((x - 48) ** 2 + (y - 48) ** 2 <= r * r ? [...color, 255] : [0, 0, 0, 0]);

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24">\n${body}\n</svg>\n`;

const buttonCss = (accent, extra = "") => `.button {
	display: inline-flex;
	align-items: center;
	gap: 0.5rem;
	padding: 0.5rem 1rem;
	border-radius: 6px;
	background: ${accent};
	color: #fff;
}

.button:hover {
	filter: brightness(1.1);
}

.button:focus-visible {
	outline: 2px solid ${accent};
	outline-offset: 2px;
}
${extra}`;

const minify = (css) => css.replace(/\s+/g, " ").replace(/\s*([{}:;,])\s*/g, "$1");

const coreJs = (version, body) => `/*! core v${version} */
export const VERSION = "${version}";

export function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}
${body}`;

/** @type {Record<string, Record<string, string|Buffer>>} */
function trees() {
	const baseCss = buttonCss("#8250df");
	const headCss = buttonCss(
		"#0969da",
		`
.button[disabled] {
	opacity: 0.5;
	pointer-events: none;
}

.button--small {
	padding: 0.25rem 0.5rem;
	font-size: 0.875rem;
}
`,
	);

	const shared = {
		"packages/button/package.json": JSON.stringify({ name: "button", main: "dist/index.css" }),
		"packages/core/package.json": JSON.stringify({ name: "core", main: "dist/index.js" }),
	};

	return {
		base: {
			...shared,
			"packages/button/dist/index.css": baseCss,
			"packages/button/dist/index.min.css": minify(baseCss),
			"packages/button/dist/index.min.css.gz": gzipSync(minify(baseCss)),
			"packages/button/dist/icon.svg": svg('<rect x="3" y="3" width="18" height="18" rx="2" fill="#8250df"/>'),
			"packages/button/dist/logo.png": png(96, 96, gradient([130, 80, 223], [250, 180, 60])),
			"packages/core/dist/index.js": coreJs(
				"1.4.0",
				`
export function debounce(fn, wait = 100) {
	let timer;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), wait);
	};
}
`,
			),
			"packages/core/dist/vendor.js": "export const data = [\n" + '\t"base-row",\n'.repeat(30000) + "];\n",
			"packages/core/dist/font.woff2": Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3, 4]),
			"packages/core/dist/rules.css": ".a{color:red}\n.b{color:blue}\n.shared{margin:0}\n",
			"packages/core/dist/medium.js": Array.from({ length: 450 }, (_, i) => `export const m${i} = "base-${i}";`).join("\n") + "\n",
			"packages/core/dist/zz-large.js": Array.from({ length: 1500 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n",
			"packages/legacy/package.json": JSON.stringify({ name: "legacy", main: "dist/old.js" }),
			"packages/legacy/dist/old.js": "export const legacy = true;\n",
			"packages/legacy/dist/badge.png": png(96, 96, circle([207, 34, 46], 30)),
		},
		head: {
			...shared,
			"packages/button/dist/index.css": headCss,
			"packages/button/dist/index.min.css": minify(headCss),
			"packages/button/dist/index.min.css.gz": gzipSync(minify(headCss)),
			"packages/button/dist/icon.svg": svg('<circle cx="12" cy="12" r="9" fill="#0969da"/>\n<path d="M8 12l3 3 5-6" stroke="#fff" stroke-width="2" fill="none"/>'),
			"packages/button/dist/logo.png": png(96, 96, gradient([9, 105, 218], [26, 127, 55])),
			"packages/core/dist/index.js": coreJs(
				"1.5.0",
				`
export function debounce(fn, wait = 150) {
	let timer;
	const debounced = (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), wait);
	};
	debounced.cancel = () => clearTimeout(timer);
	return debounced;
}

export const noop = () => {};
`,
			),
			"packages/core/dist/vendor.js": "export const data = [\n" + '\t"head-row",\n'.repeat(32000) + "];\n",
			"packages/core/dist/font.woff2": Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 9, 8, 7, 6, 5]),
			"packages/core/dist/hero.png": png(96, 96, circle([26, 127, 55], 40)),
			// `.b` was edited, `.a` removed and `.c` added: the split view pairs the two `.b` lines.
			"packages/core/dist/rules.css": ".b{color:green}\n.c{margin:0}\n.shared{margin:0}\n",
			// Long enough to start closed on the Code tab, yet inside the preview's diff budget.
			"packages/core/dist/medium.js": Array.from({ length: 450 }, (_, i) => `export const m${i} = "head-${i}";`).join("\n") + "\n",
			// Sorts last in the package and is long enough to use up the preview's diff budget.
			"packages/core/dist/zz-large.js": Array.from({ length: 1500 }, (_, i) => `export const v${i} = ${i * 2};`).join("\n") + "\n",
			"packages/tokens/package.json": JSON.stringify({ name: "tokens", main: "dist/tokens.css" }),
			"packages/tokens/dist/tokens.css": ":root {\n\t--accent: #0969da;\n\t--radius: 6px;\n\t--space-1: 0.25rem;\n\t--space-2: 0.5rem;\n}\n",
		},
	};
}

/**
 * Writes `<root>/head` and `<root>/base`.
 * @param {string} root
 * @returns {{ head: string, base: string }}
 */
export function makePreviewFixture(root) {
	const out = {};
	Object.entries(trees()).forEach(([side, files]) => {
		const dir = join(root, side);
		rmSync(dir, { recursive: true, force: true });
		Object.entries(files).forEach(([path, content]) => {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), content);
		});
		out[side] = dir;
	});
	return out;
}
