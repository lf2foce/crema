#!/usr/bin/env bash
# Creates the Lumen demo database and a read-only role for Creama.
# Uses your normal libpq environment (PGHOST, PGPORT, PGUSER) for the admin connection.
set -euo pipefail
DB="${CREAMA_DEMO_DB:-creama_demo}"
HERE="$(cd "$(dirname "$0")" && pwd)"

dropdb --if-exists "$DB"
createdb "$DB"
echo "→ seeding $DB (takes ~20s)"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/seed.sql"

psql -q -d "$DB" -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'creama_reader') THEN
    CREATE ROLE creama_reader LOGIN PASSWORD 'creama_readonly';
  END IF;
END \$\$;
GRANT CONNECT ON DATABASE "$DB" TO creama_reader;
GRANT USAGE ON SCHEMA public TO creama_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO creama_reader;
ALTER ROLE creama_reader SET default_transaction_read_only = on;
SQL

psql -d "$DB" -Atc "select 'accounts', count(*) from accounts union all select 'subscriptions', count(*) from subscriptions union all select 'invoices', count(*) from invoices union all select 'events', count(*) from events" | column -t -s '|'
echo "✓ demo ready: postgresql://creama_reader:creama_readonly@${PGHOST_DISPLAY:-localhost}:5432/$DB"
