---
"@allons-y/actions-file-diff": minor
---

Add a visual diff linked from the pull request comment, with no workflow artifacts. The comment now shows changed-file and line stats plus a link. New `visual-diff` input: `summary` (default) writes size chart, line diff and image sections to the job summary; `branch` also commits a tabbed HTML page (sizes, line diffs, and side-by-side images when any changed) to `report-branch` for GitHub Pages and removes it when the pull request closes. Also adds `report-branch`, `pages-url` and `max-diff-size` inputs and a `report-url` output.
