#!/bin/bash
# Healthy once this node is the replica-set primary. Initiates the set on the first run.
set -uo pipefail

mongosh --quiet \
  -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
  --authenticationDatabase admin \
  --eval "
    try {
      if (rs.status().myState !== 1) { quit(1); }
    } catch (e) {
      rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] });
      quit(1);
    }
  " >/dev/null
