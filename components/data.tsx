"use client";
// Shared by the SQL editor and the table browser: a result grid and a small SQL highlighter.
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Copy } from "./ui";

export type GridColumn = { name: string; type: string; badge?: "PK" | "FK" };

const NUMERIC = /^(int[248]|float[48]|numeric|oid)/;

const ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z$/;

function text(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string" && ISO.test(v)) return v.replace(ISO, (_, d, t) => (t === "00:00:00.000" || t === "00:00:00" ? d : `${d} ${t}`));
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Rows as a grid: sticky typed headers, NULLs marked, numbers right-aligned; click a cell to read all of it. */
export function DataGrid({ columns, rows, offset = 0, sort, onSort, empty = "No rows." }: {
  columns: GridColumn[]; rows: unknown[][]; offset?: number;
  sort?: { order: string | null; dir: "asc" | "desc" }; onSort?: (column: string) => void; empty?: ReactNode;
}) {
  const [cell, setCell] = useState<{ r: number; c: number } | null>(null);
  const picked = cell && rows[cell.r] ? { col: columns[cell.c], value: rows[cell.r][cell.c] } : null;
  return (
    <div className="grid-wrap">
      <div className="grid-scroll">
        <table className="dgrid">
          <thead>
            <tr>
              <th className="rn" aria-label="Row" />
              {columns.map((c) => {
                const on = sort?.order === c.name;
                return (
                  <th key={c.name} className={NUMERIC.test(c.type) ? "num" : ""} aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
                    <button className="th-btn" disabled={!onSort} onClick={() => onSort?.(c.name)} title={onSort ? "Sort" : undefined}>
                      {c.badge && <span className="th-badge">{c.badge}</span>}
                      <span className="th-name">{c.name}</span>
                      <span className="th-type">{c.type}</span>
                      {on && <span className="th-sort">{sort!.dir === "asc" ? "↑" : "↓"}</span>}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="rn">{offset + i + 1}</td>
                {r.map((v, j) => {
                  const t = text(v);
                  return (
                    <td key={j} className={`${v === null || v === undefined ? "null" : ""} ${NUMERIC.test(columns[j]?.type ?? "") ? "num" : ""} ${cell?.r === i && cell.c === j ? "on" : ""}`}
                      onClick={() => setCell({ r: i, c: j })} title={t.length > 60 ? t.slice(0, 400) : undefined}>
                      {t.length > 80 ? `${t.slice(0, 80)}…` : t}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="grid-empty">{empty}</div>}
      </div>
      {picked && (
        <div className="cell-view">
          <span className="mono faint">{picked.col?.name}</span>
          <pre>{typeof picked.value === "object" && picked.value !== null ? JSON.stringify(picked.value, null, 2) : text(picked.value)}</pre>
          <Copy text={typeof picked.value === "object" && picked.value !== null ? JSON.stringify(picked.value, null, 2) : text(picked.value)} />
          <button className="btn sm ghost" onClick={() => setCell(null)} aria-label="Close">✕</button>
        </div>
      )}
    </div>
  );
}

/** CSV of what's on screen, for a quick download. */
export function toCsv(columns: { name: string }[], rows: unknown[][]) {
  const q = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => q(c.name)).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n") + "\n";
}

export function download(name: string, body: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const KEYWORDS = new Set(("select from where and or not in is null as join left right inner outer full cross on group by order having limit offset " +
  "with distinct case when then else end union all except intersect exists between like ilike asc desc nulls first last " +
  "over partition filter lateral true false interval date timestamp coalesce count sum avg min max cast").split(" "));
const TOKEN = /(--[^\n]*)|('(?:[^']|'')*')|(\{\{\s*\w+\s*\}\})|("(?:[^"]|"")*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(::\w+)/g;

/** Lightweight SQL colouring for the editor overlay; whatever isn't a token passes through untouched. */
export function highlight(sql: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, k = 0;
  for (const m of sql.matchAll(TOKEN)) {
    if (m.index! > last) out.push(sql.slice(last, m.index));
    const [t, comment, str, ph, quoted, num, word, cast] = m;
    const cls = comment ? "tk-c" : str ? "tk-s" : ph ? "tk-p" : quoted ? "tk-i" : num ? "tk-n" : cast ? "tk-k" : word && KEYWORDS.has(word.toLowerCase()) ? "tk-k" : null;
    out.push(cls ? <span key={k++} className={cls}>{t}</span> : <Fragment key={k++}>{t}</Fragment>);
    last = m.index! + t.length;
  }
  out.push(sql.slice(last));
  return out;
}

export function useLines(sql: string) {
  return useMemo(() => Math.max(1, sql.split("\n").length), [sql]);
}
