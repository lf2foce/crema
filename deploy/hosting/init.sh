#!/usr/bin/env bash
# First boot of the bundled hosting server (compose service `hosting`); runs once, on an empty volume.
# - TLS on, with a self-signed certificate kept in PGDATA (apps use sslmode=require)
# - every TCP connection must use TLS and scram-sha-256; only the container's own socket is trusted
# - Creama's login: creama_provisioner, CREATEDB CREATEROLE and nothing more. The superuser
#   password stays in this container; Creama never sees it.
set -euo pipefail
: "${CREAMA_PROVISIONER_PASSWORD:?set HOSTING_PROVISIONER_PASSWORD}"

openssl req -new -x509 -days 3650 -nodes -subj "/CN=creama-hosting" \
  -keyout "$PGDATA/server.key" -out "$PGDATA/server.crt" 2>/dev/null
chmod 600 "$PGDATA/server.key"

cat > "$PGDATA/pg_hba.conf" <<HBA
# TYPE   DATABASE  USER  ADDRESS  METHOD
local    all       all            trust
hostssl  all       all   all      scram-sha-256
HBA

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v pw="$CREAMA_PROVISIONER_PASSWORD" <<'SQL'
ALTER SYSTEM SET ssl = on;
ALTER SYSTEM SET password_encryption = 'scram-sha-256';
CREATE ROLE creama_provisioner LOGIN PASSWORD :'pw' CREATEDB CREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10;
SQL
