#!/usr/bin/env bash
# A base backup of this server to the repository: crema-backup [full|diff|incr] (default diff).
# Run as postgres, e.g. `docker compose exec -u postgres postgres crema-backup full`; schedule it
# (a full weekly, a diff daily). The first run creates the stanza; `check` proves WAL archiving works.
set -euo pipefail
[ -n "${PGBACKREST_REPO1_S3_BUCKET:-}" ] || { echo "Backups are not configured (CREMA_BACKUP_S3_BUCKET is empty)." >&2; exit 1; }
pgbackrest stanza-create
pgbackrest check
pgbackrest backup --type="${1:-diff}"
pgbackrest info
