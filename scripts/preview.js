/**
 * Builds a local preview of the visual diff page from scripts/preview-fixture.js.
 *
 * Usage:
 *   yarn preview            # write preview/ once
 *   yarn preview --serve    # serve preview/ and re-render on src/ changes
 *   PORT=4000 yarn preview --serve
 * @module
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

import { makePreviewFixture } from "./preview-fixture.js";

const root = resolve(import.meta.dirname, "..");
const outDir = join(root, "preview");
const bundle = join(outDir, ".cache", "render.mjs");
const serve = process.argv.includes("--serve");
const port = Number(process.env.PORT ?? 4173);

// @actions/glob logs ::debug:: lines outside a runner; hide them here.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => (String(chunk).startsWith("::debug::") ? true : write(chunk, ...rest));

const fixture = makePreviewFixture(join(outDir, ".cache", "fixture"));
const clients = new Set();

/** Imports the fresh bundle and renders every variant. */
async function renderAll() {
	const { render } = await import(`${pathToFileURL(bundle)}?t=${Date.now()}`);
	await render({ outDir, ...fixture, live: serve });
	clients.forEach((res) => res.write("data: reload\n\n"));
	console.log(`[preview] rendered ${outDir}`);
}

const ctx = await esbuild.context({
	entryPoints: [join(root, "scripts/preview-render.js")],
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	loader: { ".css": "text" },
	logLevel: "warning",
	// CJS deps (@actions/*) call require(); give the ESM bundle one.
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
	plugins: [
		{
			name: "render-on-build",
			setup(build) {
				build.onEnd(async (result) => {
					if (result.errors.length === 0) await renderAll().catch((error) => console.error("[preview]", error));
				});
			},
		},
	],
});

if (!serve) {
	await ctx.rebuild();
	await ctx.dispose();
	console.log(`[preview] open ${join(outDir, "base", "index.html")}`);
} else {
	await ctx.watch();

	const types = { ".html": "text/html; charset=utf-8", ".md": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".css": "text/css" };
	createServer((req, res) => {
		const url = new URL(req.url, "http://localhost");
		if (url.pathname === "/__reload") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		let file = normalize(join(outDir, decodeURIComponent(url.pathname)));
		if (!file.startsWith(outDir)) return res.writeHead(403).end();
		if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
		if (!existsSync(file)) return res.writeHead(404).end("Not found");
		res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
		createReadStream(file).pipe(res);
	}).listen(port, () => console.log(`[preview] http://localhost:${port}/ (watching src/ for changes)`));
}
