#!/usr/bin/env bash
# Backs up the reels MongoDB to the PRIVATE bucket in the Kingdom, and prunes old backups.
#
# Run from cron on the server, from the directory that holds docker-compose.yml and .env:
#
#   17 2 * * *  cd /var/www/html/chinaparts-reels-backend && ./scripts/backup-mongo.sh >> /var/log/reels-backup.log 2>&1
#
# What it needs: the `aws` CLI (any S3-compatible bucket works through S3_ENDPOINT), and the same
# .env the stack uses. The dump streams from the container straight to the bucket: no copy of the
# data is written to the host's disk, and none leaves the Kingdom.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${MONGO_ROOT_USERNAME:?}" "${MONGO_ROOT_PASSWORD:?}" "${S3_PRIVATE_BUCKET:?}" "${S3_ACCESS_KEY_ID:?}" "${S3_SECRET_ACCESS_KEY:?}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DB="${MONGO_DB_NAME:-reels}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
KEY="backups/mongo-${DB}-${STAMP}.archive.gz"

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}"
AWS=(aws)
if [ -n "${S3_ENDPOINT:-}" ]; then AWS+=(--endpoint-url "$S3_ENDPOINT"); fi

echo "[$(date -u +%FT%TZ)] dumping ${DB} to s3://${S3_PRIVATE_BUCKET}/${KEY}"
docker compose exec -T mongo mongodump \
  --username "$MONGO_ROOT_USERNAME" --password "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin --db "$DB" --archive --gzip \
  | "${AWS[@]}" s3 cp - "s3://${S3_PRIVATE_BUCKET}/${KEY}"

echo "[$(date -u +%FT%TZ)] pruning backups older than ${RETENTION_DAYS} days"
CUTOFF="$(date -u -d "-${RETENTION_DAYS} days" +%s 2>/dev/null || date -u -v-"${RETENTION_DAYS}"d +%s)"
"${AWS[@]}" s3 ls "s3://${S3_PRIVATE_BUCKET}/backups/" | while read -r day time _ name; do
  [ -n "${name:-}" ] || continue
  taken="$(date -u -d "${day} ${time}" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' "${day} ${time}" +%s)"
  if [ "$taken" -lt "$CUTOFF" ]; then
    echo "removing backups/${name}"
    "${AWS[@]}" s3 rm "s3://${S3_PRIVATE_BUCKET}/backups/${name}"
  fi
done

echo "[$(date -u +%FT%TZ)] backup finished"
