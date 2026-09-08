#!/usr/bin/env bash
# Builds the fixture tree used by the self-test workflow (.github/workflows/self-test.yml).
#
# Usage: scripts/make-fixture.sh <output-dir>
#
# Creates <output-dir>/head and <output-dir>/base, two small monorepo-style
# trees whose only differences are file sizes and one file that exists in the
# base but not the head. Expected head total: foo 50 (index.min.css) + bar 5000
# (index.js) = 5050 bytes.
set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo "usage: $0 <output-dir>" >&2
	exit 1
fi

root="$1"

# make_file <path> <byte-count>
make_file() {
	mkdir -p "$(dirname "$1")"
	head -c "$2" /dev/zero > "$1"
}

# write_text <path> <content>
write_text() {
	mkdir -p "$(dirname "$1")"
	printf '%s\n' "$2" > "$1"
}

rm -rf "${root}/head" "${root}/base"

# --- head -------------------------------------------------------------------
make_file "${root}/head/packages/foo/dist/index.css" 100
make_file "${root}/head/packages/foo/dist/index.min.css" 50
make_file "${root}/head/packages/foo/dist/index.min.css.gz" 20
write_text "${root}/head/packages/foo/package.json" '{"name":"foo","main":"dist/index.css"}'
make_file "${root}/head/packages/bar/dist/index.js" 5000
write_text "${root}/head/packages/bar/package.json" '{"name":"bar","main":"dist/index.js"}'

# --- base -------------------------------------------------------------------
make_file "${root}/base/packages/foo/dist/index.css" 80
make_file "${root}/base/packages/foo/dist/index.min.css" 40
write_text "${root}/base/packages/foo/package.json" '{"name":"foo","main":"dist/index.css"}'
make_file "${root}/base/packages/bar/dist/index.js" 3000
make_file "${root}/base/packages/bar/dist/removed.js" 10
write_text "${root}/base/packages/bar/package.json" '{"name":"bar","main":"dist/index.js"}'

echo "Fixture written to ${root}"
