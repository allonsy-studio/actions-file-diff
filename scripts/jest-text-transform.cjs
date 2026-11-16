/** Jest transform that loads a file as a default-exported string, matching esbuild's text loader. */
module.exports = {
	process(source) {
		return { code: `module.exports = ${JSON.stringify(source)};` };
	},
};
