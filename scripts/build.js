/**
 * Bundles the action (src/index.js → dist/index.cjs). Stylesheets and
 * `*.client.js` browser scripts are inlined as text for the report page.
 *
 * Usage: node scripts/build.js
 * @module
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import * as esbuild from "esbuild";

const root = resolve(import.meta.dirname, "..");

/** Loads browser scripts as strings instead of bundling them. */
export const clientTextPlugin = {
	name: "client-text",
	setup(build) {
		build.onLoad({ filter: /\.client\.js$/ }, async ({ path }) => ({ contents: await readFile(path, "utf8"), loader: "text" }));
	},
};

/** Options shared with scripts/preview.js. */
export const sharedOptions = {
	bundle: true,
	platform: "node",
	target: "node24",
	loader: { ".css": "text" },
	legalComments: "none",
	logLevel: "warning",
	plugins: [clientTextPlugin],
};

if (import.meta.url === `file://${process.argv[1]}`) {
	await esbuild.build({ ...sharedOptions, entryPoints: [resolve(root, "src/index.js")], outfile: resolve(root, "dist/index.cjs"), format: "cjs" });
}
