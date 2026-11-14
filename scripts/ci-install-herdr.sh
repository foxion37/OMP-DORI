#!/usr/bin/env bash
# Linux CI only. Never execute an unverified or partially downloaded asset.
set -euo pipefail
bin_dir="${1:?usage: ci-install-herdr.sh BIN_DIR}"
mkdir -p "$bin_dir"
asset="$(mktemp "$bin_dir/.herdr-download.XXXXXX")"
trap 'rm -f "$asset"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for attempt in 1 2 3; do
  # The REST asset path avoids the historical web-download 504s. Bound each
  # attempt as well as the retry count; do not allow a stalled gh to hold CI.
  if timeout --kill-after=5s 60s gh release download v0.9.5 -R herdrdev/herdr \
    -p herdr-linux-x86_64 -O "$asset" --clobber; then
    break
  else
    status=$?
    echo "herdr download attempt $attempt failed (exit $status)" >&2
    if [ "$attempt" = 3 ]; then exit 22; fi
    sleep $((attempt * 20))
  fi
done
printf '%s  %s\n' '14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d' "$asset" | sha256sum -c -
chmod +x "$asset"
# Same directory/filesystem: expose the final binary only after verification.
mv -f "$asset" "$bin_dir/herdr"
