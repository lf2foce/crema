"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { routes } from "@/lib/routes";
import { useSlug } from "./AppShell";
import { useEffect, useMemo, useState } from "react";
import { fmt } from "@/core/format";
import type { EntityReading, Table } from "@/core/types";
import { api } from "@/lib/client";
import { DataGrid, download, toCsv, type GridColumn } from "./data";
import { OPEN_IN_EDITOR } from "./SqlEditor";

type Page = { table: string; columns: { name: string; type: string }[]; rows: unknown[][]; total: number; exact: boolean; limit: number; offset: number; ms: number };
const short = (q: string) => q.replace(/^public\./, "");
const SIZES = [25, 50, 100, 200];

export function Tables({ table, notify }: { table: string | null; notify: (t: string, e?: boolean) => void }) {
  const slug = useSlug();
  const router = useRouter();
  const [tables, setTables] = useState<Table[]>([]);
  const [entities, setEntities] = useState<EntityReading[]>([]);
  const [q, setQ] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<{ order: string | null; dir: "asc" | "desc" }>({ order: null, dir: "asc" });
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(50);

  useEffect(() => {
    api<{ tables: Table[]; entities: EntityReading[] }>("/api/schema").then((s) => { setTables(s.tables); setEntities(s.entities); }).catch((e) => notify((e as Error).message, true));
  }, [notify]);

  const current = tables.find((t) => t.qualified === table) ?? (table ? null : tables[0] ?? null);
  useEffect(() => { setSort({ order: null, dir: "asc" }); setOffset(0); }, [current?.qualified]);
  useEffect(() => {
    if (!current) return;
    let alive = true;
    setLoading(true);
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset), ...(sort.order ? { order: sort.order, dir: sort.dir } : {}) });
    api<Page>(`/api/tables/${encodeURIComponent(current.qualified)}/rows?${qs}`)
      .then((p) => alive && setPage(p))
      .catch((e) => notify((e as Error).message, true))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [current, limit, offset, sort, notify]);

  const fks = useMemo(() => new Set(current?.foreignKeys.flatMap((f) => f.columns) ?? []), [current]);
  const columns: GridColumn[] = (page?.columns ?? []).map((c) => ({ ...c, badge: current?.primaryKey.includes(c.name) ? "PK" : fks.has(c.name) ? "FK" : undefined }));
  const shown = tables.filter((t) => !q.trim() || t.qualified.toLowerCase().includes(q.trim().toLowerCase()));
  const meaning = entities.find((e) => e.table === current?.qualified)?.meaning;
  const onSort = (c: string) => { setOffset(0); setSort((s) => (s.order === c ? (s.dir === "asc" ? { order: c, dir: "desc" } : { order: null, dir: "asc" }) : { order: c, dir: "asc" })); };
  const toEditor = () => {
    if (!current) return;
    const order = sort.order ? `\nORDER BY "${sort.order}" ${sort.dir.toUpperCase()}` : "";
    try { localStorage.setItem(OPEN_IN_EDITOR, JSON.stringify(`SELECT *\nFROM ${current.qualified}${order}\nLIMIT ${limit};`)); } catch { /* private mode */ }
    router.push(routes.sql(slug));
  };

  return (
    <div className="tablespage">
      <aside className="sql-side">
        <input className="input" placeholder="Find a table…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a table" />
        <h4>{tables.length} tables</h4>
        <ul className="sql-list">
          {shown.map((t) => (
            <li key={t.qualified} className={current?.qualified === t.qualified ? "on" : ""}>
              <Link className="sql-item" href={routes.tables(slug, t.qualified)}>
                <span className="mono ellipsis">{short(t.qualified)}</span><span className="faint">{fmt(t.estimatedRows)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </aside>

      <main className="sql-main">
        {current ? <>
          <div className="sql-bar">
            <div className="tbl-title">
              <h1 className="mono">{short(current.qualified)}</h1>
              {meaning && <span className="muted small ellipsis">{meaning}</span>}
            </div>
            <span className="grow" />
            <Link className="btn" href={routes.schema(slug)}>Schema map</Link>
            <button className="btn" onClick={toEditor}>Query in SQL editor</button>
          </div>
          <div className="sql-results tbl-results">
            <DataGrid columns={columns} rows={page?.rows ?? []} offset={page?.offset ?? 0} sort={sort} onSort={onSort}
              empty={loading ? <span className="spin" /> : "This table is empty."} />
            <div className="sql-status tbl-pager">
              {page && <span><b>{page.total ? `${(page.offset + 1).toLocaleString("en-US")}–${(page.offset + page.rows.length).toLocaleString("en-US")}` : "0"}</b> of {page.exact ? "" : "~"}{page.total.toLocaleString("en-US")} rows · {page.ms} ms{loading ? " · loading…" : ""}</span>}
              <span className="grow" />
              <label className="faint small">Rows per page{" "}
                <select className="select sm" value={limit} onChange={(e) => { setOffset(0); setLimit(Number(e.target.value)); }}>{SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select>
              </label>
              <button className="btn sm" disabled={!page || offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} aria-label="Previous page">‹</button>
              <button className="btn sm" disabled={!page || offset + limit >= page.total} onClick={() => setOffset(offset + limit)} aria-label="Next page">›</button>
              {page && page.rows.length > 0 && <button className="btn sm ghost" onClick={() => download(`${short(current.qualified)}.csv`, toCsv(page.columns, page.rows))}>CSV of this page</button>}
            </div>
          </div>
        </> : <div className="center"><p className="muted">{tables.length ? "No such table." : <span className="spin" />}</p></div>}
      </main>
    </div>
  );
}
