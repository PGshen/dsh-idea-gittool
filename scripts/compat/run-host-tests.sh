#!/bin/sh
# B4d T5: run the Host tests against one specific git (absolute path), e.g. an older release built
# into a temporary directory. Not part of `make check`; see docs/runbooks/verification.md L5.
set -eu
git_path=${1:?usage: scripts/compat/run-host-tests.sh /absolute/path/to/git}
"$git_path" --version
cd "$(dirname "$0")/../.."
DSH_GIT_TEST_BINARY="$git_path" pnpm_config_verify_deps_before_run=false exec pnpm exec vitest run test/host
