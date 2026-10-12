# Creama

**Connect Postgres. AI proposes your business metrics and shows its evidence. You certify what's true. Software and AI reuse only what you certified.**

Creama reads your schema, profiles it, and proposes the handful of metrics your business actually runs on: MRR, active customers, churn, and so on. Where a metric has more than one plausible definition, it computes all of them on your data, **traces the gap to individual rows, and explains it**:

> *61 subscriptions are counted only by "All active contracts including trials" ($8,764 of the gap). 100% of them have status = 'trialing', versus 0% of the rest.*

You pick the definition that's true, put your name on it, and it becomes a versioned metric served over HTTP, MCP and a CLI. AI output never becomes a metric without a person.

```
proposed by the model  →  checked against your data  →  certified by a person (v1, v2…)  →  API · MCP · CLI
     (meaning)                (code, not the model)            (accountability)              (reuse)
```

## Quickstart

Requirements: Node 22.13+, pnpm, PostgreSQL (for Creama's own state, and the demo), a Gemini API key.

```sh
pnpm install
cp .env.example .env.local        # GEMINI_API_KEY, BETTER_AUTH_SECRET, DATABASE_URL
createdb creama                   # Creama's state; tables are created on first start
pnpm demo:db                      # creates the "Lumen" demo SaaS database + a read-only role
pnpm build && pnpm start          # http://localhost:3300
# In a separate terminal/service (required for discovery):
pnpm worker
```

The first person to open it creates the admin account; after that Creama is invite-only (admins add people under their name in the status bar). Email + password, or Google for invited emails when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set.

Each database you connect (or create) is a **source** in the workspace: it has its own schema map, tables, SQL editor, proposals and certified metrics, at `/s/<source>`. A metric always runs on the source it was certified on. Add more from **databases** in the status bar.

Click **Try it on a demo SaaS database**. About a minute later you're reviewing proposals. To use your own database, paste a connection string (preferably a read-only role) or set `CREAMA_DATABASE_URL`.

The demo database is deliberately messy, like real ones: amounts in cents, tax on invoices, annual plans, trials, past-due subscriptions, internal accounts, soft-deleted rows, voided invoices, refunds and plan upgrades.

## Reuse certified metrics

Only certified metrics are visible to consumers. Every answer carries its provenance. Software authenticates with `CREAMA_API_TOKEN` (set it on the server); people use their session.

```sh
H="Authorization: Bearer $CREAMA_API_TOKEN"
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
{ "mcpServers": { "creama": { "command": "npx", "args": ["tsx", "/path/to/creama/bin/creama.ts", "mcp"] } } }
```

**CLI**

```sh
pnpm creama sources                       # databases in the workspace
pnpm creama discover --source demo        # same discovery, in the terminal
pnpm creama list
pnpm creama query demo/mrr --grain quarter --from 2025-10-01
pnpm creama audit
```

## Hosted databases

Admins can create Postgres databases for apps built elsewhere (Database → Hosted databases), Neon-style: pick a database, choose the login, copy the connection string or a ready snippet (`.env`, psql, Node.js, Drizzle, Python). Each database gets:

- an owner login for the app: read/write in its own database only (no superuser, can't create roles or databases, 20 connections)
- a read-only login Creama uses when you choose **Use in Creama**, so the app's data can be discovered and certified like any other source

Passwords are stored sealed with AES-256-GCM (key: `CREAMA_ENCRYPTION_KEY`, else derived from `BETTER_AUTH_SECRET` — changing it makes stored passwords unreadable; reset them). Hosted databases can't connect to each other (`CONNECT` is revoked from `PUBLIC`). Deleting asks for the database name and is refused while Creama is analysing it.

Where databases are created: `CREAMA_HOSTING_ADMIN_URL` if set, otherwise the Postgres server in `DATABASE_URL` (works out of the box in development). In production use a separate cluster: the hosting login can create roles, apps' load and disk use would hit Creama's own state, app databases must be reachable from the internet while Creama's state shouldn't be, and cluster-level restores would rewind both. Serve it over TLS with `scram-sha-256` in `pg_hba.conf`. Not yet: branching, per-database backups, size quotas, connection pooling.

## What Creama checks (without the model)

Each proposed definition is executed and inspected by code before you see it, and again at the moment you certify it:

- runs as a single read-only `SELECT`; reproducible for any period (no `now()`)
- user SQL is parsed into an AST; writes inside CTEs, row locks, unsafe functions and custom casts are rejected. Unsupported parser syntax fails closed. This supplements, not replaces, the database's read-only transaction and least-privilege role.
- a 12-month history, plus a check that it isn't flat for lack of history
- soft-deleted rows counted, internal/test accounts not excluded, cents not converted, currencies mixed
- the listed rows add up to the number (that's what makes disagreements traceable)
- after certification: the shape of every table the query plan touches is fingerprinted; when it changes, the metric becomes **needs attention** and is not served by any channel until a person re-certifies it

## Security and privacy

- Every query runs in `BEGIN READ ONLY` with a statement timeout and is always rolled back. Use a read-only role anyway; Creama tells you if yours can write.
- The model receives only schema, row counts, null rates, min/max, and the value distributions of low-cardinality columns. Columns whose names suggest personal data (email, phone, name, address…) are never value-profiled. The exact payload is stored and viewable in the app.
- Example rows (to explain disagreements) are shown only to you and never sent to the model.
- Creama's state lives in Postgres (`DATABASE_URL`), separate from the database it analyses. Certified versions are immutable and the audit log is append-only, enforced by triggers (no UPDATE or DELETE).
- Every route requires a signed-in person; the certifier is the signed-in account, not a typed name. Only admins change the analysed database or invite people. `/api/v1` also accepts `CREAMA_API_TOKEN` for software.
- The SQL editor and table browser show raw rows to signed-in people (one read-only `SELECT`/`WITH` at a time). MCP clients never see raw tables: only certified metrics.
- Each source's connection string is sealed with AES-256-GCM in the state database. Keep the encryption key backed up separately and restrict access to both.

### Upgrading a single-source installation

Back up Creama's state database and keep its encryption key before running `pnpm db:migrate`.
The legacy `001_base` schema is upgraded transactionally: its saved `database_url` becomes the
sealed `legacy` source, preserving metrics, certified version payloads and audit records. If old
metrics have no saved source URL, migration refuses to guess. Existing hosted records and passwords
are preserved but marked failed pending cluster verification; no hosted database is created or dropped
by migration. Do not retry those imported records blindly: their existing databases must be reconciled first.

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

```
core/warehouse.ts   read-only executor + the metric SQL contract ({{start}} {{end}} {{at}})
core/schema.ts      introspection + profiling (the privacy boundary)
core/propose.ts     Gemini: understanding + candidate definitions (+ one repair round)
core/verify.ts      execution, history, deterministic checks, fingerprints
core/compare.ts     row-level diffs between definitions and their explanations
core/db.ts          Postgres pool + append-only SQL migrations (no ORM)
core/registry.ts    runs, proposals, immutable versions, audit log, saved queries
core/explore.ts     SQL editor + table browser (read-only)
core/hosting.ts     hosted databases: create, isolate, rotate passwords, drop
core/sqlGuard.ts    fail-closed AST validation of user analytics SQL
core/jobs.ts        transactional pg-boss enqueue, recovery and discovery worker
core/mcpTools.ts    the MCP tools, shared by stdio and HTTP
lib/auth.ts         Better Auth: sign-in, invitations, OAuth server for MCP
core/service.ts     the application API
app/api/**          HTTP adapter (app/api/v1 = the consumer API)
bin/creama.ts       CLI + stdio MCP server
bin/import-sqlite.ts one-off import of a pre-Postgres .creama/creama.db
```

Why, and what was deliberately left out: [PRODUCT.md](PRODUCT.md).

## Tests

```sh
pnpm test          # unit + integration against the demo database; state in throwaway schemas of creama_test
pnpm test:e2e      # the full loop in a browser, with the real model: connect → discover → certify → API
```

## License

Apache-2.0
