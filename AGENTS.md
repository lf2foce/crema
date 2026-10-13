<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Migrations: expand, then contract

A migration runs while the previous version still serves (and next to the new one during a
rollout), so it may only add. Dropping, renaming, retyping or `SET NOT NULL` on something an
earlier version uses goes in a later release, marked `-- contract: <why>`. The unit tests enforce
it (`core/migrations/compat.ts`); never edit a migration that has run. See docs/deployment.md.
