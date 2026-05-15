import { createConfig } from "@allons-y/toolkit/semantic-release";

// JS-only action: source files ship directly (no bundled bin/).
export default createConfig({
	gitAssets: ["index.js", "utilities.js", "CHANGELOG.md", "README.md", "package.json", "yarn.lock"],
});
