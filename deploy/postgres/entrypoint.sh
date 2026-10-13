#!/usr/bin/env bash
# With backups configured, the server archives each WAL segment as it fills (and at least every
# 5 minutes): that is what makes point-in-time restore possible. Settings only exist for this run.
set -euo pipefail
if [ "${1:-}" = postgres ] && [ -n "${PGBACKREST_REPO1_S3_BUCKET:-}" ]; then
  for v in PGBACKREST_STANZA PGBACKREST_REPO1_S3_ENDPOINT PGBACKREST_REPO1_S3_KEY PGBACKREST_REPO1_S3_KEY_SECRET PGBACKREST_REPO1_CIPHER_PASS PGBACKREST_REPO1_PATH; do
    [ -n "${!v:-}" ] || { echo "Backups: $v is not set (see CREMA_BACKUP_* in docs/deployment.md)" >&2; exit 1; }
  done
  set -- "$@" -c archive_mode=on -c archive_timeout=300 \
    -c "archive_command=pgbackrest --stanza=$PGBACKREST_STANZA archive-push %p"
fi
exec docker-entrypoint.sh "$@"
