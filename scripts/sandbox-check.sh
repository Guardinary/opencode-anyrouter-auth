#!/usr/bin/env bash
# One offline implementation: tests verify storage ownership and the actual Bun
# fetch fence before any credential-bearing CLI step. No separate live probes.
set -euo pipefail

: "${MAGPIE_TEST_BUN:?Set MAGPIE_TEST_BUN to an installed absolute native Bun path}"
if [[ -z "${MAGPIE_TEST_HOST:-}" && -z "${MAGPIE_TEST_BINARY:-}" ]]; then
  printf '%s\n' 'Set MAGPIE_TEST_HOST and/or MAGPIE_TEST_BINARY to installed absolute native paths.' >&2
  exit 2
fi
SCRIPT_DIR=$(dirname "$(realpath "${BASH_SOURCE[0]}")")
exec node --test --test-concurrency=1 "$SCRIPT_DIR/../test/host.integration.test.mjs"
