"use client";
import { useConfirm } from "./ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SavedQuery, Table } from "@/core/types";
import { actor, ago, api, type AppState } from "@/lib/client";
import { DataGrid, download, highlight, toCsv, useLines, type GridColumn } from "./data";

type Result = { columns: GridColumn[]; rows: unknown[][]; rowCount: number; truncated: boolean; ms: number; bound: Record<string, string> | null };
type Doc = { id: number | null; name: string; sql: string };

const DRAFT = "crema.sql.draft";
export const OPEN_IN_EDITOR = "crema.sql.open"; // the table browser hands a query over through this key
const store = {
  get<T>(k: string): T | null { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } },
  set(k: string, v: unknown) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const BLANK: Doc = { id: null, name: "Untitled query", sql: "SELECT *\nFROM public.accounts\nLIMIT 100;" };
const short = (q: string) => q.replace(/^public\./, "");

export function SqlEditor({ state, notify }: { state: AppState; notify: (t: string, e?: boolean) => void }) {
  const [ask, confirmDialog] = useConfirm();
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [doc, setDoc] = useState<Doc>(BLANK);
  const [base, setBase] = useState<Doc | null>(null); // last saved version of doc, to show unsaved changes
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = useLines(doc.sql);
  const dirty = !base || base.sql !== doc.sql || base.name !== doc.name;

  const loadSaved = useCallback(() => api<SavedQuery[]>("/api/queries").then(setSaved).catch(() => {}), []);
  useEffect(() => {
    loadSaved();
    api<{ tables: Table[] }>("/api/schema").then((s) => setTables(s.tables)).catch(() => {});
    const handed = store.get<string>(OPEN_IN_EDITOR);
    if (handed) { store.set(OPEN_IN_EDITOR, null); setDoc({ id: null, name: "Untitled query", sql: handed }); setBase(null); runSql(handed); return; }
    const draft = store.get<{ doc: Doc; base: Doc | null }>(DRAFT);
    if (draft) { setDoc(draft.doc); setBase(draft.base); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSaved]);
  useEffect(() => { store.set(DRAFT, { doc, base }); }, [doc, base]);

  const runSql = async (sql: string) => {
    setRunning(true); setError(null);
    try { setResult(await api<Result>("/api/sql", { body: { sql } })); }
    catch (e) { setError((e as Error).message); setResult(null); }
    finally { setRunning(false); }
  };
  const run = () => {
    const el = area.current;
    const sel = el && el.selectionEnd > el.selectionStart ? doc.sql.slice(el.selectionStart, el.selectionEnd) : "";
    runSql(sel.trim() ? sel : doc.sql);
  };
  const save = async () => {
    try {
      const q = await api<SavedQuery>("/api/queries", { body: { id: doc.id, name: doc.name, sql: doc.sql } });
      const next = { id: q.id, name: q.name, sql: q.sql };
      setDoc(next); setBase(next); loadSaved();
      notify(`Saved “${q.name}”.`);
    } catch (e) { notify((e as Error).message, true); }
  };
  const open = async (d: Doc, saved = true) => {
    if (dirty && doc.sql.trim() && !(await ask({ title: "Discard unsaved changes?", body: "The query you’re editing hasn’t been saved.", confirmLabel: "Discard", danger: true })).ok) return;
    setDoc(d); setBase(saved ? d : null); setResult(null); setError(null);
    requestAnimationFrame(() => area.current?.focus());
  };
  const remove = async (q: SavedQuery) => {
    if (!(await ask({ title: `Delete “${q.name}”?`, body: "This saved query is removed for everyone.", confirmLabel: "Delete query", danger: true })).ok) return;
    try { await api(`/api/queries/${q.id}`, { method: "DELETE" }); if (doc.id === q.id) { setDoc({ ...doc, id: null }); setBase(null); } loadSaved(); }
    catch (e) { notify((e as Error).message, true); }
  };
  const insert = (text: string) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    const sql = doc.sql.slice(0, a) + text + doc.sql.slice(b);
    setDoc({ ...doc, sql });
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = a + text.length; });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); insert("  "); }
  };
  // ⌘↵ and ⌘S work anywhere on the page, not only inside the editor
  const keys = useRef({ run, save });
  keys.current = { run, save };
  useEffect(() => {
    const onWin = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "Enter") { e.preventDefault(); keys.current.run(); }
      else if (e.key.toLowerCase() === "s") { e.preventDefault(); keys.current.save(); }
    };
    window.addEventListener("keydown", onWin);
    return () => window.removeEventListener("keydown", onWin);
  }, []);
  const sync = () => {
    const el = area.current;
    if (!el) return;
    if (pre.current) { pre.current.scrollTop = el.scrollTop; pre.current.scrollLeft = el.scrollLeft; }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  };
  const me = actor.get();

  return (
    <div className="sqlpage">
      <aside className="sql-side">
        <button className="btn sm" onClick={() => open({ ...BLANK, sql: "" }, false)}>+ New query</button>
        <h4>Saved</h4>
        {saved.length ? (
          <ul className="sql-list">
            {saved.map((q) => (
              <li key={q.id} className={`saved ${doc.id === q.id ? "on" : ""}`}>
                <button className="sql-item" onClick={() => open({ id: q.id, name: q.name, sql: q.sql })}>
                  <span className="ellipsis">{q.name}</span>
                  <span className="faint">{q.createdBy === me ? "you" : q.createdBy} · {ago(q.updatedAt)}</span>
                </button>
                <button className="sql-del" onClick={() => remove(q)} aria-label={`Delete ${q.name}`}>✕</button>
              </li>
            ))}
          </ul>
        ) : <p className="use-note">Save a query with ⌘S to keep it here for everyone on this server.</p>}

        {state.metrics.length > 0 && <>
          <h4>Certified metrics</h4>
          <ul className="sql-list">
            {state.metrics.map((m) => (
              <li key={m.key}><button className="sql-item" onClick={() => open({ id: null, name: `${m.name} (v${m.currentVersion})`, sql: m.current.sql }, false)}>
                <span className="ellipsis">{m.name}</span><span className="faint">v{m.currentVersion} · definition</span>
              </button></li>
            ))}
          </ul>
        </>}

        <h4>Tables</h4>
        <ul className="sql-list">
          {tables.map((t) => (
            <li key={t.qualified}><button className="sql-item" title="Insert the table name" onClick={() => insert(t.qualified)}>
              <span className="mono ellipsis">{short(t.qualified)}</span><span className="faint">{t.columns.length} cols</span>
            </button></li>
          ))}
        </ul>
      </aside>

      <main className="sql-main">
        <div className="sql-bar">
          <input className="sql-name" value={doc.name} onChange={(e) => setDoc({ ...doc, name: e.target.value })} aria-label="Query name" spellCheck={false} />
          {dirty && <span className="faint small">{doc.id ? "unsaved changes" : "not saved"}</span>}
          <span className="grow" />
          <span className="faint small hide-sm">read-only · ⌘↵ run · ⌘S save</span>
          <button className="btn" onClick={save} disabled={!doc.sql.trim()}>Save</button>
          <button className="btn primary" onClick={run} disabled={running || !doc.sql.trim()}>{running ? <span className="spin" /> : "Run"}</button>
        </div>

        <div className="sql-editor">
          <div className="sql-gutter" ref={gutter} aria-hidden>{Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}</div>
          <div className="sql-code">
            <pre ref={pre} aria-hidden>{highlight(doc.sql)}{"\n"}</pre>
            <textarea ref={area} value={doc.sql} onChange={(e) => setDoc({ ...doc, sql: e.target.value })} onKeyDown={onKey} onScroll={sync}
              spellCheck={false} autoCapitalize="off" autoComplete="off" aria-label="SQL" />
          </div>
        </div>

        <div className="sql-results">
          <div className="sql-status">
            {running ? <span className="row"><span className="spin" /> Running…</span>
              : error ? <span className="text-fail">Query failed</span>
              : result ? <span><b>{result.rowCount.toLocaleString("en-US")}</b> row{result.rowCount === 1 ? "" : "s"}{result.truncated ? " (first 500 shown)" : ""} · {result.ms} ms</span>
              : <span className="faint">Run a query to see rows here. One SELECT or WITH at a time; nothing can be written.</span>}
            {result?.bound && <span className="faint">· {"{{…}}"} bound to the last 30 days</span>}
            <span className="grow" />
            {result && result.rows.length > 0 && <button className="btn sm ghost" onClick={() => download(`${doc.name.replace(/[^\w-]+/g, "_") || "query"}.csv`, toCsv(result.columns, result.rows))}>Download CSV</button>}
          </div>
          {error ? <pre className="sql-error">{error}</pre> : result ? <DataGrid columns={result.columns} rows={result.rows} empty="The query returned no rows." /> : null}
        </div>
      </main>
      {confirmDialog}
    </div>
  );
}
