#!/usr/bin/env bash
# Restores the latest backup plus all archived WAL into a scratch directory, starts it on a private
# socket, prints what it holds, and throws it away. Touches neither the running server nor its data:
# `docker compose run --rm --no-deps -u postgres postgres crema-restore-test`.
set -euo pipefail
[ -n "${PGBACKREST_REPO1_S3_BUCKET:-}" ] || { echo "Backups are not configured." >&2; exit 1; }
dir=$(mktemp -d /tmp/restore.XXXX); sock=$(mktemp -d /tmp/sock.XXXX)
trap 'pg_ctl -D "$dir" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$dir" "$sock"' EXIT
pgbackrest restore --pg1-path="$dir" --archive-mode=off # to the end of the archive
pg_ctl -D "$dir" -w -t 600 -l "$dir/restore.log" start \
  -o "-c listen_addresses='' -c unix_socket_directories=$sock -c archive_mode=off -c ssl=off"
q() { psql -h "$sock" -U "${POSTGRES_USER:-postgres}" -d "$1" -Atc "$2"; }
until [ "$(q postgres 'SELECT pg_is_in_recovery()')" = f ]; do sleep 1; done
echo "Restored to the last archived transaction: $(q postgres 'SELECT pg_last_xact_replay_timestamp()')"
q postgres "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1" | while read -r db; do
  echo "  $db: $(q "$db" "SELECT pg_size_pretty(pg_database_size(current_database())) || ', ' || count(*) || ' tables'
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')")"
done
