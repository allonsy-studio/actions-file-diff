/** Jest transform that loads a file as a default-exported string, matching the esbuild text loader. */
export default {
	process(source, path) {
		// .js files are ESM here ("type": "module"); other extensions load as CommonJS.
		const value = JSON.stringify(source);
		return { code: path.endsWith(".js") ? `export default ${value};` : `module.exports = ${value};` };
	},
};
