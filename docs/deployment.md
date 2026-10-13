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
`v*` tag (`:1.2.3`, `:1.2`). Compose uses `:latest` unless `CREMA_IMAGE_TAG` says
otherwise; `CREMA_IMAGE` points it at a fork's registry. `--build` builds locally.

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

For an upgrade, stop web and worker first, migrate explicitly, then start them:

```sh
docker compose --env-file .env.docker.local pull web
docker compose --env-file .env.docker.local stop web worker
docker compose --env-file .env.docker.local run --rm migrate
# Only if migration succeeded:
docker compose --env-file .env.docker.local up -d web worker
```

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

## Dokploy / Docker Swarm

Deployment target: a **new Dokploy project named `Crema`**, separate from `EXP` and
Phê Nâu production. Use a new state database and volume, not `phenau-pg` or its data.

Dokploy has both **Docker Compose** and **Stack (Swarm)** deployment modes.
Running Dokploy itself on Swarm does not mean every Compose app runs as a stack.
The supplied file targets Compose mode and does not implement a start-first rollout.
See [Dokploy Compose modes](https://docs.dokploy.com/docs/core/docker-compose).

For a future Swarm rollout, web can use `update_config.order: start-first`, through
a reverse proxy with no conflicting host-mode port, after compatible migrations
have succeeded. New and old tasks overlap; this does not by itself guarantee
zero downtime or application readiness. Add a real readiness gate and verify
routing before retiring the old task. Use **stop-first** for the single Postgres
instance: two processes must not mount the same data directory concurrently.
Keep worker stop-first initially; its durable queue survives replacement, but
active model requests are not resumable checkpoints or exactly-once operations.
An incompatible schema migration still requires a maintenance window, or an
expand/contract migration spanning multiple releases. Do not apply rolling update
settings to all three services indiscriminately.

This file is for ordinary Docker Compose. Swarm stack deployment does not provide
the same migration dependency gate; do not paste it unchanged into a Swarm stack
and assume migrations completed. Build/publish the common image, run migrations
as an explicit deployment step with the state URL, and only then deploy separate
web and worker services. In Dokploy, route the domain to web's internal port 3300;
worker has no HTTP port. Provide all envs at runtime. If a migration fails, stop
the deployment and retain the previous image/database backup for recovery.

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
The service's env sets `CREMA_PULL_POLICY=always` and its command is:

```sh
compose -p phenau-crema-test-f9n3je --env-file .env -f ./compose.yaml up -d --no-build
```

Nothing is built on the VPS. To roll back, set `CREMA_IMAGE_TAG=sha-<commit>` in
Dokploy's environment and redeploy; set it back to `latest` afterwards. For schema
upgrades, follow the stop/migrate/start procedure above rather than relying on this command.

Access from the Mac without publishing an Internet port:

```sh
ssh -N -L 127.0.0.1:13300:127.0.0.1:3300 phenau-vps
```

Open `https://crema.phenau.com`. The first admin is created from the one-time setup
link in the `web` service's log (Dokploy → Logs). This is a test instance:
there is no HA or scheduled state backup yet. Do not store irreplaceable state.
Dokploy API requests can run inside its container over SSH; the public control
domain has Cloudflare Access in addition to Dokploy's API-key authentication.
