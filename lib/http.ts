// HTTP adapter over core/service. Route handlers stay one-liners.
// Every route needs a signed-in person; /api/v1 (read-only, for software) also accepts CREAMA_API_TOKEN.
import { timingSafeEqual } from "node:crypto";
import { CreamaError, creama, type Creama } from "@/core/service";
import { sessionUser, type SessionUser } from "@/lib/auth";

type Ctx = { req: Request; r: Creama; actor: string; user: SessionUser | null; body: any; url: URL };

function apiToken(req: Request, url: URL): boolean {
  const token = process.env.CREAMA_API_TOKEN;
  if (!token) return false;
  // a header for software; ?token= only for CSV, because spreadsheet IMPORTDATA can't send headers
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || (url.searchParams.get("format") === "csv" ? url.searchParams.get("token") ?? "" : "");
  const a = Buffer.from(got), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function handle(fn: (ctx: Ctx) => Promise<unknown> | unknown, opts: { admin?: boolean } = {}) {
  return async (req: Request, route?: { params?: Promise<Record<string, string>> }) => {
    try {
      const url = new URL(req.url);
      const user = await sessionUser(req.headers);
      const machine = !user && url.pathname.startsWith("/api/v1/") && req.method === "GET" && apiToken(req, url);
      if (!user && !machine) return Response.json({ error: "Sign in to use Creama." }, { status: 401 });
      if (opts.admin && user?.role !== "admin") return Response.json({ error: "Only an admin can do this." }, { status: 403 });
      const body = req.method === "GET" || req.method === "DELETE" ? {} : await req.json().catch(() => ({}));
      const actor = user ? user.name || user.email : "api-token";
      const params = (await route?.params) ?? {};
      const out = await fn({ req, r: creama(), actor, user, body: { ...body, ...params }, url });
      if (out instanceof Response) return out; // non-JSON formats (CSV) build their own response
      // a promise nested in the response would serialise as {} without any error: fail loudly instead
      if (out && typeof out === "object" && Object.values(out).some((v) => v instanceof Promise)) throw new Error("Route returned an unresolved promise inside its response.");
      return Response.json(out ?? { ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      if (e instanceof CreamaError) return Response.json({ error: e.message }, { status: e.status });
      console.error(e);
      return Response.json({ error: (e as Error).message ?? "Internal error" }, { status: 500 });
    }
  };
}
