---
"@allons-y/actions-file-diff": minor
---

Fix startup crashes (ESM import of `@actions/core`, `require` inside an ES module, read-only `core.summary`, `new getOctokit`) and correct the report: totals and `has-changed` now share one formula (sum of reported files, using the minified size where one exists), deleted files no longer print `NaN%`, and tables without a base have matching header and row columns. Add the `build-dir`, `main-file` (default `index.js`), `read-package-json` and `extensions` inputs, identify the sticky comment by an HTML marker so multiple instances can coexist, and ship a bundled `dist/index.cjs` entry.
