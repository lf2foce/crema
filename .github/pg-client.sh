#!/usr/bin/env bash
# PostgreSQL 18 client tools (psql, createdb, pg_dump, pg_restore) from the PGDG repository,
# matching the server: branch copies refuse an older pg_dump.
set -euo pipefail
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends postgresql-client-18
pg_dump --version
