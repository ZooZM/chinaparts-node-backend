#!/bin/bash
# Generates the replica-set keyfile once (kept in the config volume), then hands over to the
# stock mongo entrypoint. A keyfile is what lets a replica set run with authentication on.
set -euo pipefail

KEYFILE=/data/configdb/keyfile
if [ ! -s "$KEYFILE" ]; then
  openssl rand -base64 756 > "$KEYFILE"
fi
chmod 400 "$KEYFILE"
chown mongodb:mongodb "$KEYFILE"

exec docker-entrypoint.sh "$@"
