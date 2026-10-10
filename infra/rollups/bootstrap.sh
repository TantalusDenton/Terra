#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERSION=1.20.0
COMMIT=84cd0961fcce613558d7b260d8751a3ace533d31
mkdir -p "$TASK_ROOT/bin" "$TASK_ROOT/downloads" "$TASK_ROOT/vendor" "$TASK_ROOT/runtime"
if [ ! -x "$TASK_ROOT/bin/kurtosis" ]; then
  ARCHIVE="kurtosis-cli_${VERSION}_linux_amd64.tar.gz"
  BASE="https://github.com/kurtosis-tech/kurtosis-cli-release-artifacts/releases/download/$VERSION"
  curl -fsSL "$BASE/$ARCHIVE" -o "$TASK_ROOT/downloads/$ARCHIVE"
  curl -fsSL "$BASE/checksums.txt" -o "$TASK_ROOT/downloads/checksums.txt"
  (cd "$TASK_ROOT/downloads" && grep " $ARCHIVE$" checksums.txt | sha256sum --check)
  tar -xzf "$TASK_ROOT/downloads/$ARCHIVE" -C "$TASK_ROOT/bin" kurtosis
fi
if [ ! -d "$TASK_ROOT/vendor/optimism-package/.git" ]; then
  git -c core.autocrlf=false clone --filter=blob:none https://github.com/ethpandaops/optimism-package.git "$TASK_ROOT/vendor/optimism-package"
  git -C "$TASK_ROOT/vendor/optimism-package" checkout --detach "$COMMIT"
fi
CURRENT="$(git -C "$TASK_ROOT/vendor/optimism-package" rev-parse HEAD)"
if [ "$CURRENT" != "$COMMIT" ]; then
  echo 'Existing vendor checkout differs from the supported commit; no files were reset.' >&2
  exit 1
fi
"$TASK_ROOT/bin/kurtosis" version
docker info --format '{{.ServerVersion}}'
