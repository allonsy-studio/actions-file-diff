#!/usr/bin/env bash
# Builds the fixture tree used by the self-test workflow (.github/workflows/self-test.yml).
#
# Usage: scripts/make-fixture.sh <output-dir>
#
# Creates <output-dir>/head and <output-dir>/base, two small monorepo-style
# trees whose only differences are file sizes and one file that exists in the
# base but not the head. Files hold printable text so the line-diff report has
# something to show. Expected head total: foo 50 (index.min.css) + 200
# (icon.svg) + bar 5000 (index.js) = 5250 bytes.
set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo "usage: $0 <output-dir>" >&2
	exit 1
fi

root="$1"

# make_file <path> <byte-count> — numbered text lines, cut to an exact size.
make_file() {
	mkdir -p "$(dirname "$1")"
	awk -v n="$2" 'BEGIN { s = ""; i = 1; while (length(s) < n) s = s ".rule-" i++ " { color: red; }\n"; printf "%s", substr(s, 1, n) }' > "$1"
}

# make_svg <path> <byte-count> <fill> — a square SVG padded to an exact size.
make_svg() {
	mkdir -p "$(dirname "$1")"
	local svg="<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"><rect width=\"64\" height=\"64\" fill=\"$3\"/></svg>"
	{ printf '%s<!--' "${svg}"; printf '%*s' "$(($2 - ${#svg} - 7))" ''; printf -- '-->'; } > "$1"
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
make_svg "${root}/head/packages/foo/dist/icon.svg" 200 "#0969da"
write_text "${root}/head/packages/foo/package.json" '{"name":"foo","main":"dist/index.css"}'
make_file "${root}/head/packages/bar/dist/index.js" 5000
write_text "${root}/head/packages/bar/package.json" '{"name":"bar","main":"dist/index.js"}'

# --- base -------------------------------------------------------------------
make_file "${root}/base/packages/foo/dist/index.css" 80
make_file "${root}/base/packages/foo/dist/index.min.css" 40
make_svg "${root}/base/packages/foo/dist/icon.svg" 150 "#8c959f"
write_text "${root}/base/packages/foo/package.json" '{"name":"foo","main":"dist/index.css"}'
make_file "${root}/base/packages/bar/dist/index.js" 3000
make_file "${root}/base/packages/bar/dist/removed.js" 10
write_text "${root}/base/packages/bar/package.json" '{"name":"bar","main":"dist/index.js"}'

echo "Fixture written to ${root}"
