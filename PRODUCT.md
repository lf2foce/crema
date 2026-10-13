# Crema — product thinking

> AI proposes business meaning. Data checks it. A human certifies it.
> Everything downstream consumes only what was certified.

## Phase 1 — First principles

### The exact user

Not "a data team". The first person in a 10–300 person company who gets asked
"what's our MRR?" and has to answer from Postgres: a **technical founder, the
first data/analytics engineer, or a backend engineer who became the de-facto
data person**. They can write SQL. What they lack is the time to do *archaeology*:
which status means paying, whether trials count, whether `amount` is in cents,
which accounts are internal, which rows are soft-deleted.

Right now this person is also being asked to "plug the data into AI", and they
know that an LLM writing fresh SQL per question will produce a different "revenue"
every time.

### The painful job

The painful part is **not** writing SQL and **not** drawing charts. It is:

1. *Finding the ambiguity.* Most metric disagreements come from 3–4 hidden decisions
   (include trials? subtract refunds? exclude internal accounts? normalise annual
   plans?). Nobody knows which decisions exist until two dashboards disagree.
2. *Settling it once.* The decision lives in someone's head or a Slack thread, then
   gets re-implemented in the BI tool, the app, the AI prompt.

So the job is: **surface the decisions hidden in my schema, show me what each choice
does to the number, let me pick once, and make that pick the only answer anything
else can get.**

### Challenging the brief

- *"Discover metrics" is not the magic.* Any LLM can list "Revenue, MRR, Active
  users". That is a parlour trick and users will discount it in seconds. The magic is
  **showing where plausible definitions disagree, by how much, and exactly which rows
  cause it** — on the user's real data. "Your two definitions of active customer
  differ by 61 accounts; all 61 are on a trial" is something no BI tool tells
  you and no human finds without an afternoon of SQL.
- *Metric "discovery" should be a review queue, not a catalog.* The output of the
  first run is a short inbox of decisions, like PR review — not a data catalog to
  browse.
- *A semantic layer is the wrong mental model for v1.* Dimensions, joins, measures,
  YAML — that is the configuration the user should never see. A certified metric in
  v1 is: **one question, one SQL definition, the evidence, who certified it, which
  version.** Slicing by dimensions can come later; trust cannot.
- *"Human approval" alone isn't trust.* A human clicking approve on SQL they didn't
  read is rubber-stamping. Trust needs three independent layers: the model's
  proposal (meaning), deterministic checks against the actual data (verification),
  and a human decision made **on evidence** (certification).

### Smallest compelling unit

**A certified metric**: a named business question bound to an executable definition,
its evidence, its certifier, an immutable version, and a schema fingerprint so it
knows when the world changed under it. Everything else (UI, API, MCP, CLI) is a view
of that unit.

### The magic moment

> Connect → ~60 seconds → "We found 7 metrics in your business. 3 have competing definitions.
> Start there." → MRR: two definitions side by side on your data, $172,244 vs $181,008 →
> *"61 subscriptions are counted only by 'All active contracts including trials' ($8,764 of the
> gap). 100% of them have status = 'trialing'"* → pick one → Crema.
> → `curl /api/v1/metrics/mrr/values` and Claude via MCP now return the same number, with
> "v1, certified by Anh".

### What explicitly does NOT exist in v1

- Dashboards, chart builders, drag-and-drop anything (it is not a BI tool)
- A free-form "ask your data" chatbot (no fresh SQL per question)
- A semantic modelling language / YAML editor
- Dimensions & slicing (v1 metrics are a time series, not a cube)
- Multiple databases / warehouses / connectors (Postgres only, one per instance)
- User accounts, roles, SSO (v1 records a self-declared certifier in an audit log;
  put it behind your own proxy for teams)
- Scheduling, alerting, caching layers, background workers, Redis

### Where existing tools are unnecessarily complex

- **Semantic layers (dbt SL, Cube, LookML):** ask you to *author* meaning up front in a
  modelling language before you get any value. The authoring is the hard part they
  leave to you.
- **BI tools:** bury the definition inside a chart; two charts = two definitions.
- **Data catalogs:** describe tables, not decisions; nobody is accountable for a
  number.
- **Text-to-SQL:** generates a new definition per question — the opposite of trust.

### What could make it feel genuinely new

1. **Disagreement as the primary UI.** Competing definitions are diffed on real rows,
   and the difference is explained deterministically ("100% of the 61 have a
   subscription with status = 'trialing'"). The product finds the arguments before people
   have them.
2. **A visible trust ladder.** Every number carries its provenance: *proposed by
   model* → *checked against data* → *certified by a person, vN*. Consumers can only
   read the last rung.
3. **The certified registry is an interface, not a UI.** It's an MCP server and a
   versioned HTTP API first. The web app is just the review client.
4. **Drift awareness.** A certified metric knows the schema it was certified against and
   says so when that changes, rather than silently returning a different number.

### Product shapes considered

| Shape | What it is | Verdict |
|---|---|---|
| A. **Review inbox + certified API** | Web review queue of AI proposals with evidence; certified metrics served over REST/MCP/CLI | ✅ chosen |
| B. Metrics-as-code CLI | `npx certify init` writes `metrics.yaml` into your repo; certification = merged PR | Great OSS story, weak magic moment (evidence in a terminal/PR diff is hard to read); good *later* as an export |
| C. MCP trust proxy | Sits between AI tools and Postgres; only lets AI answer via certified metrics | Strongest future platform, but nothing to certify on day one — it needs A to exist |

**Why A:** it is the only shape where the magic moment (seeing disagreements on your
own data) is visual and immediate, it creates the asset that B and C need, and it is
small enough to self-host as one process. C is delivered as a feature of A (the MCP
server only exposes certified metrics); B can be an export later.

## Phase 2 — Product design

**One page, three states.** No settings screen, no catalog, no modelling screen.

1. **Connect** — a single field (or "use the demo database"). Under it, the trust
   contract in one line: read-only transactions, 8s timeout, no rows leave your server;
   only schema statistics go to the model — with a link to the exact payload. If the
   role can write, Crema says so and gives the SQL for a read-only role.
2. **Understanding** — a live log of what it's doing, with real numbers as they arrive
   ("public.invoices · 6,224 rows · status: paid 94%, void 2%…"; "Monthly Recurring
   Revenue · $172.2k · 2 definitions disagree by 5%"). The wait is the product showing its work.
3. **Review** — Linear-style list on the left (*Needs a decision* / *Certified*), detail on
   the right:
   - one-sentence read of the business and the entities it inferred (with confidence)
   - for each metric: the question it answers, the candidate definitions **side by
     side with their values on your data**, the size of the disagreement, the rows
     that cause it and the deterministic explanation, overlaid 12-month series
   - the chosen candidate's **assumptions as falsifiable statements**, each with the
     column distribution that supports or contradicts it
   - **checks** run by code, not the model (soft-deletes ignored? internal accounts?
     cents? mixed currency? `now()` making it non-reproducible?)
   - SQL is visible but folded; editing it re-runs every check before you can certify
   - one primary action: **Crema "<definition>" as <Metric>**

**Uncertainty** is communicated as words + reasons, never fake percentages:
*High / Medium / Low — because …*, and contradicted by red checks when the data
disagrees with the model.

**Reuse** is shown on the certified metric itself: the live value, the version history,
and copy-paste snippets for `curl`, the CLI and an MCP client config.

## Phase 3 — Technical design

```
Postgres (customer, read-only) ──► core/warehouse  (READ ONLY txn, timeout, single SELECT)
                                     │
   core/introspect ─► core/profile ─► core/propose (Gemini, schema stats only)
                                     │
                       core/verify ─► core/compare ─► core/checks      (deterministic)
                                     │
                       core/registry (SQLite: proposals, versions, audit log)
                                     │
                       core/service  ◄── the only API the outside world uses
              ┌──────────────┬──────────────┬──────────────┐
          Next.js UI     /api/v1 REST     CLI          MCP (stdio)
```

- **One process, one file of state.** Next.js app (UI + route handlers) and a SQLite
  file (`node:sqlite`, no native deps) under `.crema/`. No queue, no Redis, no
  second database. Discovery runs in-process and persists its progress, so the UI
  just polls.
- **The core knows nothing about Next.** `core/service.ts` is the application API; the
  route handlers, CLI and MCP server are thin adapters over it.
- **Read-only by construction.** Every customer query runs inside `BEGIN READ ONLY`
  with `statement_timeout`, is a single `SELECT/WITH`, and always ends in `ROLLBACK`.
- **Privacy boundary.** The model receives schema, row counts, null rates, min/max, and
  value distributions only for low-cardinality, non-identifying columns. No rows. The
  exact payload is stored and viewable.
- **Metric contract.** A definition is one SELECT returning one row with `value`,
  parameterised by `{{start}}`/`{{end}}` (flow metrics) or `{{at}}` (snapshot metrics).
  That single contract gives "current value", any time series (via one
  `generate_series … CROSS JOIN LATERAL` query), and comparisons. Count metrics may add a
  `members_sql` returning ids, which powers row-level disagreement diffs.
- **Immutable versions + audit log.** Certifying creates version *n*; editing never
  mutates — it proposes *n+1*. Every state change is an event.
- **Drift.** At certification we fingerprint every relation the plan touches (via
  `EXPLAIN`); queries report `drifted` when those relations change shape.

## Phase 5 — Critique (written after building it)

**What is genuinely differentiated.** Disagreement as the interface. Every tool can list "Revenue,
MRR, Active users". Crema computes competing definitions on the user's data, splits the gap into
rows only A counts, rows only B counts and rows both count but value differently, and explains each
part deterministically: "61 subscriptions … ($8,764 of the gap), 100% have status = 'trialing'".
The second differentiator is that trust is enforced in code, not described in docs: consumers
cannot read a proposal, certification re-runs the definition, versions are immutable, and answers
carry provenance and drift.

**What still feels like an existing BI product.** The metric list with sparklines, the KPI number
and the 12-month line chart. They earn their place as evidence (definitions diverging over time),
but a first-time viewer still pattern-matches "dashboard". The "Use it anywhere" tab is where it
stops looking like BI.

**Weakest part of the magic moment.**
1. *The wait.* 40–70 seconds, almost all of it model latency. The live log helps, but the first
   proposal could appear after ~10 s if understanding and proposing were streamed per metric.
2. *Alternatives of uneven quality.* Sometimes the model offers a genuinely different definition
   (trials in or out) and sometimes a different *metric* ("high-priority backlog" vs "all
   backlog"). The prompt asks for consequential ambiguity only; it isn't always obeyed.
3. *Amount metrics were untraceable.* Fixed during this critique, see below.
4. *Entities can't be corrected directly.* Saying "a customer is an account with a paid invoice"
   means re-running discovery with a hint, not editing one fact.

**What users would pay for.** Not the discovery. They would pay for the *governance loop around
certified metrics* once more than one person depends on them: SSO and roles (who can certify finance
metrics), scheduled re-verification with alerts when a certified number moves for a non-business
reason (backfill, schema change, a new status value), and an MCP/API gateway for company-wide AI
with per-question audit. Hosted Crema = that loop, managed.

**Why someone would install the OSS version.** Because in ten minutes it turns an unfamiliar
Postgres into a short list of reviewed, versioned metrics without writing YAML, and it makes
Claude/Cursor/ChatGPT give the *same* number every time via MCP. Self-hosted, read-only, and the
model never sees a row.

**What should be removed.** Done in this pass: the top-bar "Re-discover" (an action with
consequences belongs where its context is, under "Something wrong?"), and the always-visible key
field in the decision bar (now one click away). Next candidates: the confidence chip on candidate
cards (the checks list is the more honest signal), and single-definition proposals that the
checks pass trivially; they could be batch-certified from the list.

**The single best next feature.** *Certified metrics that guard themselves*: a nightly
re-verification of every certified version that compares the new history with the certified one
and opens a "this number changed for a reason other than new data" review (an old month moved, a
new status value appeared, drift). It extends the core promise (no silent changes to truth) from
definitions to numbers, and it is the hook for the paid tier.

**Improvements made because of this critique.**
- Row-level traces for *amounts*, not just counts. A definition now lists `(id, contribution)`;
  diffs separate rows only one side counts from rows both count but value differently, and
  explanations follow foreign keys to parents and children (`plans.billing_interval = 'year'`,
  `accounts.is_internal`, `a subscription with status = 'trialing'`). This made MRR and revenue,
  the metrics people actually argue about, traceable.
- The in-progress period is marked `partial` in the API and drawn dashed, instead of looking like
  a drop.
- Snapshot metrics are never evaluated in the future (the current bucket ends at "now").
- Soft-delete warnings only when the soft-deleted table is the thing being counted; elsewhere it's
  informational ("usually right for historical totals"). Unit checks ignore ratios.
