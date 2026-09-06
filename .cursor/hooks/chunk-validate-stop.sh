#!/usr/bin/env bash
set -euo pipefail

# Cursor stop hooks pass JSON on stdin; drain it so chunk validate does not hang.
cat > /dev/null

export PATH="${HOME}/.local/bin:${PATH}"

IDENTITY_FILE="${HOME}/.ssh/chunk_ai"
if [ ! -f "$IDENTITY_FILE" ]; then
  if [ -x ".cursor/setup-chunk.sh" ]; then
    bash .cursor/setup-chunk.sh
  fi
fi

if [ ! -f "$IDENTITY_FILE" ]; then
  echo "SSH key not found: ${IDENTITY_FILE}" >&2
  exit 2
fi

if ! chunk validate --remote --identity-file "$IDENTITY_FILE" --workdir /home/user; then
  exit 2
fi

exit 0
