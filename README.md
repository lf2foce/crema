# Crema

**Connect Postgres. AI proposes your business metrics and shows its evidence. You certify what's true. Software and AI reuse only what you certified.**

Crema reads your schema, profiles it, and proposes the handful of metrics your business actually runs on: MRR, active customers, churn, and so on. Where a metric has more than one plausible definition, it computes all of them on your data, **traces the gap to individual rows, and explains it**:

> *61 subscriptions are counted only by "All active contracts including trials" ($8,764 of the gap). 100% of them have status = 'trialing', versus 0% of the rest.*

You pick the definition that's true, put your name on it, and it becomes a versioned metric served over HTTP, MCP and a CLI. AI output never becomes a metric without a person.

```
proposed by the model  →  checked against your data  →  certified by a person (v1, v2…)  →  API · MCP · CLI
     (meaning)                (code, not the model)            (accountability)              (reuse)
```

## Quickstart

Requirements: Node 22.13+, pnpm, PostgreSQL (for Crema's own state, and the demo), an API key for an approved schema-output model (Google by default).

```sh
pnpm install
cp .env.example .env.local        # GEMINI_API_KEY, BETTER_AUTH_SECRET, DATABASE_URL
createdb crema                   # Crema's state; tables are created on first start
pnpm demo:db                      # creates the "Lumen" demo SaaS database + a read-only role
pnpm dev                         # migrate, then web + worker; http://localhost:3300
# Ctrl+C stops both. Production: migrate first, then run web and worker independently.
```

The first person to open it creates the admin account; after that Crema is invite-only (admins add people under their name in the status bar). Email + password, or Google for invited emails when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set.

Docker: copy `.env.docker.example` to `.env.docker.local`, fill the secrets, then
`docker compose --env-file .env.docker.local up --build -d`.
See [deployment instructions](docs/deployment.md) for lifecycle, migrations and Dokploy.

Each database you connect (or create) is a **source** in the workspace: it has its own schema map, tables, SQL editor, proposals and certified metrics, at `/projects/<source>/…` (`/metrics`, `/schema`, `/tables`, `/sql`). A metric always runs on the source it was certified on. Add more from **databases** in the status bar.

Click **Try it on a demo SaaS database**. About a minute later you're reviewing proposals. To use your own database, paste a connection string (preferably a read-only role) or set `CREMA_DATABASE_URL`.

The demo database is deliberately messy, like real ones: amounts in cents, tax on invoices, annual plans, trials, past-due subscriptions, internal accounts, soft-deleted rows, voided invoices, refunds and plan upgrades.

## Reuse certified metrics

Only certified metrics are visible to consumers. Every answer carries its provenance. Software authenticates with `CREMA_API_TOKEN` (set it on the server); people use their session.

```sh
H="Authorization: Bearer $CREMA_API_TOKEN"
curl -H "$H" "localhost:3300/api/v1/metrics"                                        # every certified metric, with its ref
curl -H "$H" "localhost:3300/api/v1/metrics/demo/mrr/values?grain=month&from=2026-01-01"   # <source>/<key>
curl -H "$H" "localhost:3300/api/v1/metrics/demo/mrr/values?version=1"                    # pin a version
curl "localhost:3300/api/v1/metrics/demo/mrr/values?grain=month&format=csv&token=…"       # CSV, for spreadsheet IMPORTDATA
```

```json
{ "metric": "mrr", "version": 1, "certifiedBy": "Anh", "trust": "certified", "drift": null,
  "grain": "month", "points": [ …, { "start": "2026-10-01T00:00:00.000Z", "value": 172244.33, "partial": true }] }
```

**MCP** (Claude, ChatGPT, Cursor, …): add `https://<your-host>/api/mcp` as a connector. The assistant sends you to sign in and approve, then gets `list_metrics`, `get_metric_values` and `explain_metric`, and is told to say a metric isn't certified instead of inventing SQL.

- MCP protocol 2026-07-28 only (2025-era requests are refused), OAuth 2.1 with PKCE via Better Auth.
- Clients identify themselves with Client ID Metadata Documents (CIMD); there is no dynamic client registration.
- Tokens are bound to the `/api/mcp` resource and the `metrics:read` scope, and carry the person who approved them.
- `test/mcp-oauth.e2e.mjs` runs the whole flow against a running server with the official v2 client.

Locally, the same tools over stdio:

```json
{ "mcpServers": { "crema": { "command": "npx", "args": ["tsx", "/path/to/crema/bin/crema.ts", "mcp"] } } }
```

**CLI**

```sh
pnpm crema sources                       # databases in the workspace
pnpm crema discover --source demo        # same discovery, in the terminal
pnpm crema list
pnpm crema query demo/mrr --grain quarter --from 2025-10-01
pnpm crema audit
```

## Hosted databases

Admins can create Postgres databases for apps built elsewhere (Databases → New database), Neon-style: pick a database, choose the login, copy the connection string or a ready snippet (`.env`, psql, Node.js, Drizzle, Python). Give it a display name; the database gets a natural random name, Neon-style (`young_art_a7k2`; ↻ for another), which can be edited before creating (`comicai`), and is checked as you type against reserved names and everything already on the server. It never changes afterwards; the display name can. Each database gets:

- an owner login for the app: read/write in its own database only (no superuser, can't create roles or databases, 20 connections)
- a read-only login Crema uses when you choose **Use in Crema**, so the app's data can be discovered and certified like any other source

Passwords are stored sealed with AES-256-GCM (key: `CREMA_ENCRYPTION_KEY`, else derived from `BETTER_AUTH_SECRET` — changing it makes stored passwords unreadable; reset them). Hosted databases can't connect to each other (`CONNECT` is revoked from `PUBLIC`). Deleting asks for the database name and is refused while Crema is analysing it.

Where databases are created: on a **server** an admin adds (Databases → Servers → Add), PostgreSQL 16 or newer. Give it an admin login once:

- a superuser login is used for one statement, to create Crema's own `crema_provisioner_…` role with only `CREATEDB CREATEROLE`; the superuser password is not stored
- or create such a role yourself and give Crema that login

On PostgreSQL 16+ a role with `CREATEROLE` can only change or drop roles it created, so Crema can't touch other roles or databases on the server. A server can be removed once it holds no databases; its provisioner role stays there for you to drop.

Use a server of its own, not the one in `DATABASE_URL`: apps' load and disk use would hit Crema's state, app databases must be reachable from the internet while Crema's state shouldn't be, and cluster-level restores would rewind both. Serve it over TLS with `scram-sha-256` in `pg_hba.conf`, and back it up at the cluster level (e.g. pgBackRest). **New database** needs no setup when the installation has its own server: the Compose bundle's `hosting` service (`CREMA_BUNDLED_SERVER_URL`, a provisioner login), or in development the server in `DATABASE_URL`; it's added the first time a database is created. Production never uses Crema's state server. Not yet: branching, per-database backups, size quotas, connection pooling.

### Branches

### Projects and branches

What you create is a **project** (`ComicAI`). Its **production** branch is the hosted database; **+ Branch** adds **development** or **staging**, each its own database on the same server (`<production>_<branch>`, its own logins, fewer connections). Connected databases are projects of one branch, labelled production, staging or development by you, or not at all: Crema never assumes a database is production. The label is for people and policy (a PROD badge everywhere you can do harm); what you may do to a database (clone, reset, delete) depends on how it was made, never on its name. Renaming a project changes what people see; database names never change.

Environment policy: development isn't discovered or drift-checked on a schedule, and consumers (API, MCP, agents) are offered production's metrics by default, plus those of databases nobody labelled: staging and development metrics need `/api/v1/metrics?all=1` (the metric's own ref always works); open it to look around or analyse on demand. Metrics belong to the branch they were certified on.

From a project's page (`/projects/comic`), one click goes to its Tables, SQL editor, Schema and Metrics (`/projects/comic/tables`…), and every database page has a branch switcher. URLs are real paths, one route file per page under `app/(app)/`; no `#` navigation.

The worker fills a branch with a consistent snapshot of production: `pg_dump` (one repeatable-read transaction, main keeps serving) piped into `pg_restore` as the branch's owner, so every table belongs to the branch. Choose **schema + data** or **schema only** (no customer rows in development). **Reset from main** drops the branch's database and copies again; its connection string doesn't change.

It's a copy, not Neon's copy-on-write: time and disk grow with main's size. Main is never reset, and can't be deleted while it has branches. A separate database doesn't stop a development app from messaging real customers: turn off outbound messages, webhooks, payments and cron there.

Copies are operations, safe across restarts: queue insertion, the operation ID, status and audit event commit
together. Completed or superseded operation deliveries are no-ops. Copy, reset and
delete coordinate through a state-DB advisory lock. If initial branch creation is
interrupted before enqueue, its failed source remains retryable (it is not reported
as a running copy). Failed/expired queue operations can be reset again.

When upgrading to migration `006_branch_operations`, stop the previous worker first,
apply migrations, then start the updated web and worker. Do not run the old branch
worker alongside this version: it does not understand operation IDs.

## What Crema checks (without the model)

Each proposed definition is executed and inspected by code before you see it, and again at the moment you certify it:

- runs as a single read-only `SELECT`; reproducible for any period (no `now()`)
- user SQL is parsed into an AST; writes inside CTEs, row locks, unsafe functions and custom casts are rejected. Unsupported parser syntax fails closed. This supplements, not replaces, the database's read-only transaction and least-privilege role.
- a 12-month history, plus a check that it isn't flat for lack of history
- soft-deleted rows counted, internal/test accounts not excluded, cents not converted, currencies mixed
- the listed rows add up to the number (that's what makes disagreements traceable)
- after certification: the shape of every table the query plan touches is fingerprinted; when it changes, the metric becomes **needs attention** and is not served by any channel until a person re-certifies it

## Security and privacy

- Every query runs in `BEGIN READ ONLY` with a statement timeout and is always rolled back. Use a read-only role anyway; Crema tells you if yours can write.
- The model receives only schema, row counts, null rates, min/max, and the value distributions of low-cardinality columns. Columns whose names suggest personal data (email, phone, name, address…) are never value-profiled. The exact payload is stored and viewable in the app.
- Example rows (to explain disagreements) are shown only to you and never sent to the model.
- Crema's state lives in Postgres (`DATABASE_URL`), separate from the database it analyses. Certified versions are immutable and the audit log is append-only, enforced by triggers (no UPDATE or DELETE).
- Every route requires a signed-in person; the certifier is the signed-in account, not a typed name. Only admins change the analysed database or invite people. `/api/v1` also accepts `CREMA_API_TOKEN` for software.
- The SQL editor and table browser show raw rows to signed-in people (one read-only `SELECT`/`WITH` at a time). MCP clients never see raw tables: only certified metrics.
- Each source's connection string, each server's provisioner login and each hosted database's passwords are sealed with AES-256-GCM in the state database. Keep the encryption key backed up separately and restrict access to both.

## Architecture

One Next.js web process, one independently supervised discovery worker and one Postgres database for state.
Run `pnpm db:migrate` before production web/worker startup. Discovery jobs and run records are committed
together; deploy/restart of the web does not discard them. The worker uses pg-boss with two retries,
backoff, a 60-second heartbeat and a 30-minute attempt expiration. A crashed attempt restarts discovery,
not the interrupted Gemini request; it may incur another model charge. A completed run is not executed again
if the worker dies before acknowledging the queue job. Reviewable open proposals from a rerun supersede
the earlier proposals; certified versions remain immutable. Deploy the worker as a supervised service,
not a request handler. Without it jobs remain queued. This does not provide exactly-once external model calls.
The domain lives in `core/` and knows nothing about Next; adapters stay thin.

The same worker runs a persistent hourly schema-drift schedule (`CREMA_DRIFT_CRON`, UTC cron;
`off` disables it). It inspects source schemas without calling Gemini or calculating metric values.
Changed metrics become `needs_attention`; alerts are recorded in the audit log and visible in the app.
This is schema drift, not business-semantic drift or data-freshness monitoring. No email/Telegram
notification channel is configured. Source connection failures also appear in audit.

```
core/warehouse.ts   read-only executor + the metric SQL contract ({{start}} {{end}} {{at}})
core/schema.ts      introspection + profiling (the privacy boundary)
core/propose.ts     Gemini: understanding + candidate definitions (+ one repair round)
core/verify.ts      execution, history, deterministic checks, fingerprints
core/compare.ts     row-level diffs between definitions and their explanations
core/db.ts          Postgres pool + append-only SQL migrations (no ORM)
core/registry.ts    runs, proposals, immutable versions, audit log, saved queries
core/explore.ts     SQL editor + table browser (read-only)
core/hosting.ts     servers and hosted databases: limited provisioner, create, isolate, rotate passwords, drop
core/sqlGuard.ts    fail-closed AST validation of user analytics SQL
core/jobs.ts        transactional pg-boss enqueue, recovery and discovery worker
core/mcpTools.ts    the MCP tools, shared by stdio and HTTP
lib/auth.ts         Better Auth: sign-in, invitations, OAuth server for MCP
core/service.ts     the application API
app/api/**          HTTP adapter (app/api/v1 = the consumer API)
bin/crema.ts       CLI + stdio MCP server
bin/import-sqlite.ts one-off import of a pre-Postgres .crema/crema.db
```

Why, and what was deliberately left out: [PRODUCT.md](PRODUCT.md).

## Tests

```sh
pnpm test          # unit + integration against the demo database; state in throwaway schemas of crema_test
pnpm test:db       # also the suites that need a real cluster (hosting, safety, queue); run before deploying
pnpm test:e2e      # the full loop in a browser, with the real model: connect → discover → certify → API
```

## License

[MIT](LICENSE)
