#!/usr/bin/env bash
# Regenerates the OpenAPI schema into a temp file and diffs it against the
# committed openapi.yaml. Exits non-zero on drift — wired into CI so an
# undocumented API change fails the build, per the brief's requirement.
set -euo pipefail

cd "$(dirname "$0")/.."

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

uv run python manage.py spectacular --file "$TMP_FILE" --validate

if ! diff -u openapi.yaml "$TMP_FILE" > /tmp/openapi.diff; then
  echo "OpenAPI schema has drifted from the committed openapi.yaml." >&2
  echo "Run: uv run python manage.py spectacular --file openapi.yaml --validate" >&2
  echo "and commit the result." >&2
  cat /tmp/openapi.diff >&2
  exit 1
fi

echo "OpenAPI schema matches committed openapi.yaml."
