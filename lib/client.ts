"use client";
// Browser-side client for the Creama HTTP API.
import type { AuditEvent, Concept, EntityReading, Metric, Run, Server, Source, Verification } from "@/core/types";

/** A database in the workspace, with counts (from /api/state and /api/sources). */
export type SourceInfo = Source & { metrics: number; proposals: number; attention: number; sizeBytes: number | null; connections: number | null; missing: boolean };
/** A Postgres server Creama creates databases on, with how many it holds. */
export type ServerInfo = Server & { databases: number };

export type AppState = {
  workspace: string;
  sources: SourceInfo[];
  /** the database this page is about (/s/<slug>), or null on workspace pages */
  source: Source | null;
  servers: ServerInfo[];
  /** a server this installation offers in one click (bundled hosting server, or this machine in development) */
  suggestedServer: { name: string; publicHost: string | null } | null;
  model: { name: string; configured: boolean };
  run: { id: number; status: Run["status"]; startedAt: string; finishedAt: string | null; error: string | null } | null;
  understanding: { runId: number; summary: string | null; entities: EntityReading[]; model: string; at: string } | null;
  proposals: Concept[];
  rejected: Concept[];
  metrics: Metric[];
  demoAvailable: boolean;
  tokenRequired: boolean;
  cwd: string;
  currency: string;
  me: Me | null;
};

export type { AuditEvent, Concept, Metric, Run, Server, Source, Verification };

// The source this page works in: sent with every API call so the server scopes the request to it.
let currentSource: string | null = null;
export const setCurrentSource = (slug: string | null) => { currentSource = slug; };
export const sourceHref = (slug: string, hash = "") => `/s/${encodeURIComponent(slug)}${hash ? `#${hash.replace(/^#/, "")}` : ""}`;

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export type Me = { id: string; name: string; email: string; role: string };
let me: Me | null = null;
/** The signed-in person (set by the app shell from /api/state). The server never trusts the client for this. */
export const session = { me: () => me, set: (m: Me | null) => { me = m; } };
export const actor = { get: () => me?.name || me?.email || "" };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; source?: string | null } = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const source = opts.source === undefined ? currentSource : opts.source;
  if (source) headers["x-creama-source"] = source;
  const res = await fetch(path, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  // signed out (or the session expired): go sign in and come back here
  if (res.status === 401 && typeof window !== "undefined" && !retried) {
    window.location.href = `/sign-in?next=${encodeURIComponent(window.location.pathname + window.location.hash)}`;
    return new Promise<T>(() => {});
  }
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

export function spreadOf(c: Concept): number {
  return c.candidates.length > 1 ? c.comparison?.spread ?? 0 : 0;
}

export function contested(c: Concept): boolean {
  return c.candidates.length > 1 && spreadOf(c) > 0.005;
}

export function windowLabel(kind: "flow" | "snapshot") {
  return kind === "flow" ? "last 30 days" : "right now";
}

export function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const actorLabel = (who: string) => who || "someone";
