---
"@allons-y/actions-file-diff": minor
---

Add a visual diff linked from the pull request comment, with no workflow artifacts. The comment shows changed-file and line stats plus the link, and is shortened to fit GitHub's comment limit.

New `visual-diff` input: `summary` (default) writes a size chart, line diffs and an image list to the job summary; `branch` also publishes an interactive page (overview, code diffs with unified and split layouts, and image compare with side by side, overlay, swipe and difference modes) to `report-branch` for GitHub Pages. Each run keeps that branch at a single commit, and the report is removed when the pull request closes.

Line diffs use `git diff --no-index`, so `git` must be on the PATH (preinstalled on GitHub-hosted runners). Symbolic links are no longer followed, so a link in a pull request can't pull files from outside the checkout into a report. The sticky comment is now matched by bot author as well as marker, and a failed comment post warns instead of failing the run.

Also adds `report-branch`, `pages-url`, `max-diff-size` and `max-diff-lines` inputs and a `report-url` output.
