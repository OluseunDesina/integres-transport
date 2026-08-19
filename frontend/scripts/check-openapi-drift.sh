#!/usr/bin/env bash
# Regenerates projects/api-client/src/lib/schema.ts from ../backend/openapi.yaml
# into a temp file and diffs it against the committed version. Exits
# non-zero on drift — mirrors backend/scripts/check_openapi_drift.sh so
# CI catches a frontend type/backend contract mismatch either direction.
set -euo pipefail

cd "$(dirname "$0")/.."

SCHEMA_FILE="projects/api-client/src/lib/schema.ts"
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

npx openapi-typescript ../backend/openapi.yaml -o "$TMP_FILE"

if ! diff -u "$SCHEMA_FILE" "$TMP_FILE" > /tmp/api-client-schema.diff; then
  echo "api-client's schema.ts has drifted from backend/openapi.yaml." >&2
  echo "Run: npm run openapi:generate" >&2
  echo "and commit the result." >&2
  cat /tmp/api-client-schema.diff >&2
  exit 1
fi

echo "api-client schema.ts matches backend/openapi.yaml."
