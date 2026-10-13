# PostgreSQL for Compose's `postgres` (Crema's state) and `hosting` (apps' databases): the official
# image plus pgBackRest. With CREMA_BACKUP_* set, every WAL segment is archived to S3-compatible
# storage (encrypted) and `crema-backup` takes base backups: restore to any moment, not just last night.
# Without them it is plain PostgreSQL. Bumping the version restarts the databases on the next deploy.
FROM postgres:18.6-bookworm

# pgBackRest from PGDG (already configured in the base image); ca-certificates to verify S3 over HTTPS
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres /var/log/pgbackrest /tmp/pgbackrest /var/spool/pgbackrest

# Static pgBackRest settings. Small files go into bundles (an empty cluster is ~1,500 files; one request
# each is minutes over a long link). No block incremental: it reads every block of a file in its own
# request, and restoring a 33 MB cluster from R2 took 137 s with it, 5 s without (measured 13/10/2026).
# WAL moves asynchronously and in parallel, both ways. The repository (endpoint, bucket, keys, passphrase, path) and the stanza
# come from the environment at runtime (compose.yaml maps CREMA_BACKUP_* onto them).
ENV PGBACKREST_PG1_PATH=/var/lib/postgresql/18/docker \
    PGBACKREST_REPO1_TYPE=s3 \
    PGBACKREST_REPO1_S3_REGION=auto \
    PGBACKREST_REPO1_S3_URI_STYLE=path \
    PGBACKREST_REPO1_CIPHER_TYPE=aes-256-cbc \
    PGBACKREST_REPO1_RETENTION_FULL=2 \
    PGBACKREST_REPO1_RETENTION_DIFF=7 \
    PGBACKREST_REPO1_BUNDLE=y \
    PGBACKREST_COMPRESS_TYPE=zst \
    PGBACKREST_PROCESS_MAX=4 \
    PGBACKREST_ARCHIVE_ASYNC=y \
    PGBACKREST_SPOOL_PATH=/var/spool/pgbackrest \
    PGBACKREST_START_FAST=y \
    PGBACKREST_LOG_LEVEL_CONSOLE=info \
    PGBACKREST_LOG_LEVEL_FILE=off

COPY --chmod=755 entrypoint.sh /usr/local/bin/crema-postgres-entrypoint.sh
COPY --chmod=755 crema-backup.sh /usr/local/bin/crema-backup
COPY --chmod=755 crema-restore-test.sh /usr/local/bin/crema-restore-test
ENTRYPOINT ["crema-postgres-entrypoint.sh"]
CMD ["postgres"]
