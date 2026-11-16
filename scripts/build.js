/**
 * Bundles the action (src/index.js → dist/index.js, ESM). Stylesheets and
 * `*.client.js` browser scripts are inlined as text for the report page.
 *
 * Usage: node scripts/build.js
 * @module
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
	format: "esm",
	// Bundled CommonJS deps (@actions/*) call require() for Node built-ins; ESM has none.
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
	loader: { ".css": "text" },
	legalComments: "none",
	logLevel: "warning",
	plugins: [clientTextPlugin],
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	await esbuild.build({ ...sharedOptions, entryPoints: [resolve(root, "src/index.js")], outfile: resolve(root, "dist/index.js") });
}
