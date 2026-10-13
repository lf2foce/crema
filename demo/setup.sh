#!/usr/bin/env bash
# Creates the Lumen demo database and a read-only role for Crema.
# Uses your normal libpq environment (PGHOST, PGPORT, PGUSER) for the admin connection.
set -euo pipefail
DB="${CREMA_DEMO_DB:-crema_demo}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# No password ships with the repo: generate one per machine (or pass CREMA_DEMO_PASSWORD).
PW="${CREMA_DEMO_PASSWORD:-$(openssl rand -hex 16)}"
[[ "$PW" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "CREMA_DEMO_PASSWORD: letters, digits, - and _ only" >&2; exit 1; }

dropdb --if-exists "$DB"
createdb "$DB"
echo "→ seeding $DB (takes ~20s)"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/seed.sql"

psql -q -d "$DB" -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crema_reader') THEN
    CREATE ROLE crema_reader LOGIN;
  END IF;
  ALTER ROLE crema_reader PASSWORD '$PW';
END \$\$;
GRANT CONNECT ON DATABASE "$DB" TO crema_reader;
GRANT USAGE ON SCHEMA public TO crema_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO crema_reader;
ALTER ROLE crema_reader SET default_transaction_read_only = on;
SQL

psql -d "$DB" -Atc "select 'accounts', count(*) from accounts union all select 'subscriptions', count(*) from subscriptions union all select 'invoices', count(*) from invoices union all select 'events', count(*) from events" | column -t -s '|'
URL="postgresql://crema_reader:$PW@${PGHOST_DISPLAY:-localhost}:5432/$DB"
# Record the URL in .env.local (the app and the tests read CREMA_DEMO_URL from there).
ENV_FILE="$HERE/../.env.local"
touch "$ENV_FILE"
grep -v '^CREMA_DEMO_URL=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
echo "CREMA_DEMO_URL=$URL" >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
echo "✓ demo ready: $DB, role crema_reader (read-only). CREMA_DEMO_URL saved to .env.local"
