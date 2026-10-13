# Development and deployment

## One-terminal development

After installing dependencies and configuring `.env.local` (see `.env.example`), run:

```sh
pnpm dev
```

Crema applies state migrations, then starts Next dev and the discovery/drift worker
as separate child processes. If migration fails, neither starts. If either process
exits, the other is stopped and the command returns a failure. Ctrl+C stops both,
including Next's subprocesses on macOS/Linux, with a seven-second shutdown limit.
The URL is `http://localhost:3300`; override the port with `CREMA_DEV_PORT` and set
`APP_URL` to match. `pnpm dev:web` intentionally runs web only for debugging; it
needs a separately running worker for discovery.

The state Postgres must already be running. This command does not create a DB or
start Docker. Do not point development at production state: migrations and workers
write state, consume existing queued jobs and may perform model calls. Use a fresh
development database. Env precedence matches Next development: shell environment,
`.env.development.local`, `.env.local`, `.env.development`, `.env`.

## Docker Compose

Requires Docker with Compose v2. The common multi-stage image runs as non-root and
contains web, worker and migration runtime dependencies. Secrets and local env
files are excluded from its build context; supply keys only at runtime.

CI (`.github/workflows/release.yml`) publishes it to `ghcr.io/lf2foce/crema` for
amd64 and arm64 on every push to `main` (`:latest`, `:sha-<commit>`) and for each
`v*` tag (`:1.2.3`, `:1.2`), after the checks in `ci.yml` pass (typecheck, the whole
test suite against PostgreSQL 18 with nothing skipped, and the UI tests on
`next start`); pull requests run the same checks plus an image build. Each image
carries an SBOM and a signed build provenance:
`gh attestation verify oci://ghcr.io/lf2foce/crema:latest -R lf2foce/crema`.
Compose uses `:latest` unless `CREMA_IMAGE_TAG` says otherwise; `CREMA_IMAGE`
points it at a fork's registry. `--build` builds locally. Dependabot opens weekly
update PRs for actions, npm packages and base images.

```sh
cp .env.docker.example .env.docker.local
# Fill each secret separately; openssl rand -hex 32 produces a URL-safe value.
# Add the model provider key, or leave discovery unavailable until you supply it.
docker compose --env-file .env.docker.local up -d
docker compose --env-file .env.docker.local ps
docker compose --env-file .env.docker.local logs --tail=100 web worker migrate
```

Four long-lived services: `web`, `worker`, `postgres` (Crema's state) and `hosting`
(the databases Crema creates for apps). A fifth, `migrate`, is a
one-shot deployment step: Postgres health passes → migrations succeed → web and
worker start. Postgres 18 persists in a named volume mounted at `/var/lib/postgresql`;
the official image uses `PGDATA=/var/lib/postgresql/18/docker`.
See the [official image's PGDATA change](https://hub.docker.com/_/postgres).
The startup gate uses [Compose dependency conditions](https://docs.docker.com/compose/how-tos/startup-order/).
No DB host port is published. Web binds to host loopback, port 3300 by default, so
put a reverse proxy in front for public access. `APP_URL` must match the public
HTTPS URL. To create the first admin, open the one-time setup link the `web` service
prints in its log at startup (works once, for 24 hours; a restart or
`docker compose exec web node --import tsx bin/crema.ts setup-link` issues a new one).
`CREMA_SETUP_TOKEN`, if set, replaces the link with a fixed secret.

`POSTGRES_PASSWORD` is interpolated into a connection URL: use the hex generation
above, not punctuation requiring URL encoding. Rotating an env password does not
change an already initialized Postgres role; rotate it in Postgres separately.
Keep `BETTER_AUTH_SECRET` and `CREMA_ENCRYPTION_KEY` stable across restarts: changing
encryption keys can make stored source credentials unreadable. This bundled DB's
bootstrap role is an administrator; for hardened production use a dedicated
least-privilege state role. Hosted databases go on a separate Postgres server that an
admin adds in the app (Databases → Servers); the bundled state DB is never offered for it in production. This Compose bundle is
not an HA deployment or a backup policy.
Default runtime limits are 512 MB per service, 0.75 CPU for web/worker/migrate,
and 0.5 CPU for Postgres; override `CREMA_APP_MEMORY`, `CREMA_APP_CPUS`,
`CREMA_DB_MEMORY`, `CREMA_DB_CPUS` if the workload needs more. These runtime
limits do not constrain Docker image builds.

This is a fresh PostgreSQL 18 deployment, not an in-place major-version upgrade.
If you already have a PostgreSQL 17 data volume, migrate with dump/restore or a
proper `pg_upgrade` procedure; do not point the 18 image at the 17 data directory.

To upgrade, fetch the new image, migrate while the current version keeps serving
(migrations are expand-only, see below), then restart web and worker on it:

```sh
docker compose --env-file .env.docker.local pull migrate web worker
docker compose --env-file .env.docker.local run --rm -T migrate
# Only if migration succeeded:
docker compose --env-file .env.docker.local up -d web worker
```

Web is down for the few seconds it takes to start. Behind a proxy on the Compose
network, the rollout below avoids even that.

Back up the state DB before upgrading. Queue state is durable in Postgres; restarting
only worker does not lose queued jobs. An interrupted discovery may run again and
incur another model charge (not exactly-once external calls).

```sh
docker compose --env-file .env.docker.local restart worker
docker compose --env-file .env.docker.local stop
```

`stop` leaves the volume intact. Do not use `down -v` unless you intentionally want
to delete Crema's state. Do not paste `docker compose config` output into public
logs: it expands runtime secrets.

### The hosting server

`hosting` is a separate Postgres 18 with its own volume and superuser
(`HOSTING_SUPERUSER_PASSWORD`, which only that container sees). On first boot
`deploy/hosting/init.sh` turns on TLS with a self-signed certificate kept in its data
directory, makes every TCP connection use TLS and `scram-sha-256`, and creates
`crema_provisioner` (`CREATEDB CREATEROLE`, no superuser) with `HOSTING_PROVISIONER_PASSWORD`.
Crema only gets that login (`CREMA_BUNDLED_SERVER_URL`), and uses this server the first
time someone creates a database. Apps connect on `CREMA_HOSTING_PORT` (5433) at
`CREMA_HOSTING_PUBLIC_HOST` with `sslmode=require`. The init script runs only on an empty
volume: changing either password later means `ALTER ROLE` inside the container too.
Back the volume up at the cluster level; it holds your apps' data.

## Migrations: expand, then contract

A deploy runs migrations while the previous version is still serving, and during a
rollout the previous and the new web run side by side. So a migration may only add:
new tables, nullable columns or columns with a default, indexes. Dropping, renaming,
retyping or tightening (`SET NOT NULL`) something an earlier version uses is a later
migration, shipped once no running version needs it, with a `-- contract: <why>` line.
To rename a column: add the new one and write both (release 1), backfill and read the
new one (release 2), drop the old one marked as a contract (release 3).
`core/migrations/compat.ts` flags the breaking statements; the unit tests fail on an
unmarked one from migration 008 on.

## Zero-downtime rollout

With a reverse proxy that follows containers on the Compose network and routes
only to healthy ones (Traefik does, so Dokploy does), web can be replaced without a gap:

```sh
docker compose up -d --wait postgres hosting
docker compose pull migrate web worker
docker compose run --rm -T migrate                  # the current web keeps serving
docker compose up -d --no-deps --no-recreate --scale web=2 --wait --wait-timeout 180 web
docker compose up -d --no-deps --scale web=1 web    # removes the outdated container first
docker compose up -d --no-deps worker               # its queue is durable; jobs resume
```

Two web containers can't bind the same host port: set `CREMA_HTTP_PORT` to empty.
If migration fails, nothing after it runs and the current version stays up. If the
new web never becomes healthy, `--wait` fails and the proxy keeps routing to the
current one; remove the unhealthy container after reading its logs. Postgres is
never run twice: it is only started when it isn't running.

## Dokploy

Deployment target: a **new Dokploy project named `Crema`**, separate from `EXP` and
Phê Nâu production. Use a new state database and volume, not `phenau-pg` or its data.
Use Dokploy's **Docker Compose** mode with this file; route the domain to `web`,
port 3300. Provide all envs at runtime.

### Crema test on the existing VPS

Dokploy project **Crema**, Compose service **Crema test** (`phenau-crema-test-f9n3je`),
tracks `https://github.com/lf2foce/crema.git`, branch `main`, file `./compose.yaml`.
It has separate state and volume. All services detach from `dokploy-network`;
only the private Compose network connects them.
Runtime secrets are stored through Dokploy's Environment API, never in Git.

Deploys are automatic: after CI publishes `:latest`, its `deploy` job calls the
service's Dokploy deploy hook (GitHub secret `DOKPLOY_DEPLOY_HOOK`, environment
`test`), then waits until `/api/version` reports the new commit. Dokploy has no
GitHub webhook of its own, so it never deploys a commit whose image isn't built yet.
Its env sets `CREMA_HTTP_PORT=` (empty) and its command is the rollout above, each
step as `docker compose -p phenau-crema-test-f9n3je --env-file .env -f ./compose.yaml …`
joined with `&&` (Dokploy's command field accepts only chained `docker compose` calls,
and prefixes the first with `docker`).

Nothing is built on the VPS. To roll back, set `CREMA_IMAGE_TAG=sha-<commit>` in
Dokploy's environment and redeploy; set it back to `latest` afterwards.

Open `https://crema.phenau.com`. The first admin is created from the one-time setup
link in the `web` service's log (Dokploy → Logs). This is a test instance:
there is no HA or scheduled state backup yet. Do not store irreplaceable state.
Dokploy API requests can run inside its container over SSH; the public control
domain has Cloudflare Access in addition to Dokploy's API-key authentication.
