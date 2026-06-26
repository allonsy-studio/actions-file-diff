# actions-file-diff

> Compare file sizes between branches and report the diff back on the pull request.

Originally lived inline at `vague-ds/.github/actions/file-diff`. Lifted into a standalone repo as a JavaScript-only GitHub Action (no TS, no bundling).

## Usage

```yaml
- uses: castastrophe/actions-file-diff@v1
  with:
      head-path: ${{ github.workspace }}/packages
      base-path: /tmp/main-checkout/packages
      file-glob-pattern: "**/dist/**"
      comment-header: "## File metrics"
```

## Inputs

| Name                | Required | Default                   | Description                                                            |
| ------------------- | -------- | ------------------------- | ---------------------------------------------------------------------- |
| `head-path`         | no       | `${{ github.workspace }}` | Path to the head branch's files.                                       |
| `base-path`         | no       | —                         | Path to the base branch's files. If omitted, only reports head totals. |
| `token`             | no       | `${{ github.token }}`     | GitHub token used to post the PR comment.                              |
| `file-glob-pattern` | no       | `**/dist/**`              | Glob pattern (newline-separated for multiple) used to select files.    |
| `comment`           | no       | `"true"`                  | Whether to post/update a PR comment.                                   |
| `comment-header`    | no       | `## File metrics`         | Header line used to identify the sticky comment.                       |

## Outputs

| Name          | Description                                 |
| ------------- | ------------------------------------------- |
| `has-changed` | `"true"` if overall size differs from base. |
| `total-size`  | Total head-branch size in bytes.            |

## Development

This repo deliberately stays simple — no TypeScript, no bundling. Tooling is configured locally with standard presets:

```sh
yarn lint      # eslint (flat config, @eslint/js recommended + prettier)
yarn format    # prettier --write, then eslint --fix
yarn test      # jest, JS-only
```
