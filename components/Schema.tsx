"use client";
import Link from "next/link";
import { routes } from "@/lib/routes";
import { useSlug } from "./AppShell";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { fmt } from "@/core/format";
import type { EntityReading, Table, TableProfile } from "@/core/types";
import { api } from "@/lib/client";
import { autoLayout, bounds, cardHeight, CARD_W, columnY, edgePath, keyColumns, visibleColumns, type Pos } from "@/lib/schemaLayout";
import { ConfidenceChip, Distribution } from "./ui";

type Use = { kind: "metric" | "proposal"; ref: string; name: string; contested: boolean };
type SchemaMap = { database: string | null; scannedAt: string | null; tables: Table[]; profiles: TableProfile[]; entities: EntityReading[]; usage: Record<string, Use[]> };
type View = { x: number; y: number; k: number };

const short = (q: string) => q.replace(/^public\./, "");
const compactRows = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k` : String(n));
const store = {
  get<T>(k: string): T | null { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

export function Schema({ notify }: { notify: (t: string, e?: boolean) => void }) {
  const [data, setData] = useState<SchemaMap | null>(null);
  const [pos, setPos] = useState<Record<string, Pos>>({});
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [onlyUsed, setOnlyUsed] = useState(false);
  const [q, setQ] = useState("");
  const canvas = useRef<HTMLDivElement>(null);
  const storeKey = `crema.schema.${data?.database ?? "db"}`;

  useEffect(() => { api<SchemaMap>("/api/schema").then(setData).catch((e) => notify((e as Error).message, true)); }, [notify]);

  const all = data?.tables ?? [];
  const usage = data?.usage ?? {};
  const shown = useMemo(() => all.filter((t) => !onlyUsed || usage[t.qualified]?.length), [all, onlyUsed, usage]);
  const byName = useMemo(() => new Map(all.map((t) => [t.qualified, t])), [all]);
  const h = useCallback((t: Table) => cardHeight(t, all, expanded.has(t.qualified)), [all, expanded]);

  // positions: saved per database, auto layout for anything new
  useEffect(() => {
    if (!data) return;
    const saved = store.get<Record<string, Pos>>(storeKey) ?? {};
    const auto = autoLayout(data.tables, (t) => cardHeight(t, data.tables, false));
    setPos(Object.fromEntries(data.tables.map((t) => [t.qualified, saved[t.qualified] ?? auto[t.qualified]])));
  }, [data, storeKey]);

  const fit = useCallback((only?: string[]) => {
    const el = canvas.current;
    if (!el) return;
    const subset = Object.fromEntries(Object.entries(pos).filter(([k]) => (only ?? shown.map((t) => t.qualified)).includes(k)));
    const b = bounds(subset, (k) => h(byName.get(k)!));
    const r = el.getBoundingClientRect(), pad = 48;
    const k = Math.min(1.25, Math.max(0.3, Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h)));
    setView({ k, x: (r.width - b.w * k) / 2 - b.x * k, y: (r.height - b.h * k) / 2 - b.y * k });
  }, [pos, shown, h, byName]);

  const fitted = useRef(false);
  useEffect(() => { if (!fitted.current && Object.keys(pos).length) { fitted.current = true; requestAnimationFrame(() => fit()); } }, [pos, fit]);

  const save = (p: Record<string, Pos>) => store.set(storeKey, p);
  const arrange = () => {
    const auto = autoLayout(shown, h);
    const next = { ...pos, ...auto };
    setPos(next); save(next);
    requestAnimationFrame(() => fit());
  };

  // pan with the background, zoom with ctrl/⌘ + wheel (pinch on a trackpad), pan with a plain wheel
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => {
        if (!e.ctrlKey && !e.metaKey) return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
        const k = Math.min(2, Math.max(0.25, v.k * Math.exp(-e.deltaY * 0.01)));
        const px = e.clientX - r.left, py = e.clientY - r.top;
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [data]);

  const drag = useRef<{ kind: "pan" | "card"; id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const onCanvasDown = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest(".tcard, .schema-tools")) return;
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onCardDown = (e: RPointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.stopPropagation();
    drag.current = { kind: "card", id, sx: e.clientX, sy: e.clientY, ox: pos[id].x, oy: pos[id].y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.kind === "pan") setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    else setPos((p) => ({ ...p, [d.id!]: { x: Math.round(d.ox + dx / view.k), y: Math.round(d.oy + dy / view.k) } }));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "card") { if (d.moved) save(pos); else setSelected(d.id!); }
    else if (!d.moved) setSelected(null);
  };

  const centreOn = (id: string) => {
    const el = canvas.current, p = pos[id], t = byName.get(id);
    if (!el || !p || !t) return;
    const r = el.getBoundingClientRect();
    setView((v) => ({ ...v, x: r.width / 2 - (p.x + CARD_W / 2) * v.k, y: r.height / 2 - (p.y + h(t) / 2) * v.k }));
    setSelected(id);
  };
  const nudge = (id: string, dx: number, dy: number) => {
    const next = { ...pos, [id]: { x: pos[id].x + dx, y: pos[id].y + dy } };
    setPos(next); save(next);
  };

  if (!data) return <div className="center"><span className="spin" /></div>;
  if (!all.length) return <div className="center"><p className="muted">No tables yet. Connect a database and run discovery first.</p></div>;

  const focus = hovered ?? selected;
  const visible = new Set(shown.map((t) => t.qualified));
  const edges = shown.flatMap((t) => t.foreignKeys.filter((f) => visible.has(f.refTable) && pos[t.qualified] && pos[f.refTable]).map((f, i) => {
    const ref = byName.get(f.refTable)!;
    const e = edgePath(pos[t.qualified], columnY(t, all, expanded.has(t.qualified), f.columns[0]), pos[f.refTable], columnY(ref, all, expanded.has(ref.qualified), f.refColumns[0]));
    const lit = focus != null && (focus === t.qualified || focus === f.refTable);
    return { id: `${t.qualified}.${f.columns.join("_")}.${i}`, ...e, lit, from: t.qualified, to: f.refTable };
  }));
  const neighbours = new Set(focus ? [focus, ...edges.filter((e) => e.lit).flatMap((e) => [e.from, e.to])] : []);
  const match = q.trim() ? shown.find((t) => short(t.qualified).toLowerCase().includes(q.trim().toLowerCase())) : null;
  const sel = selected ? byName.get(selected) : null;

  return (
    <div className="schema">
      <div className="schema-canvas" ref={canvas} onPointerDown={onCanvasDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${20 * view.k}px ${20 * view.k}px` }}>
        <div className="schema-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="schema-edges" aria-hidden>
            {edges.map((e) => (
              <g key={e.id} className={e.lit ? "lit" : focus ? "dim" : ""}>
                <path d={e.d} />
                {/* many side: crow's foot at the referencing column; one side: a bar at the key */}
                <path className="mark" d={`M ${e.start.x + e.start.dir * 12} ${e.start.y} L ${e.start.x} ${e.start.y - 6} M ${e.start.x + e.start.dir * 12} ${e.start.y} L ${e.start.x} ${e.start.y + 6} M ${e.start.x + e.start.dir * 12} ${e.start.y} L ${e.start.x} ${e.start.y}`} />
                <path className="mark" d={`M ${e.end.x + e.end.dir * 8} ${e.end.y - 6} L ${e.end.x + e.end.dir * 8} ${e.end.y + 6}`} />
              </g>
            ))}
          </svg>
          {shown.map((t) => pos[t.qualified] && (
            <TableCard key={t.qualified} t={t} all={all} p={pos[t.qualified]} expanded={expanded.has(t.qualified)}
              meaning={data.entities.find((e) => e.table === t.qualified)?.meaning}
              uses={usage[t.qualified] ?? []}
              state={selected === t.qualified ? "selected" : focus && !neighbours.has(t.qualified) ? "dim" : match?.qualified === t.qualified ? "match" : ""}
              onDown={(e) => onCardDown(e, t.qualified)}
              onHover={(on) => setHovered(on ? t.qualified : null)}
              onKey={(e) => {
                const step = e.shiftKey ? 48 : 12;
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(t.qualified); }
                else if (e.key === "ArrowLeft") { e.preventDefault(); nudge(t.qualified, -step, 0); }
                else if (e.key === "ArrowRight") { e.preventDefault(); nudge(t.qualified, step, 0); }
                else if (e.key === "ArrowUp") { e.preventDefault(); nudge(t.qualified, 0, -step); }
                else if (e.key === "ArrowDown") { e.preventDefault(); nudge(t.qualified, 0, step); }
              }}
              onToggle={() => setExpanded((s) => { const n = new Set(s); n.has(t.qualified) ? n.delete(t.qualified) : n.add(t.qualified); return n; })} />
          ))}
        </div>

        <div className="schema-tools">
          <input className="input" placeholder="Find a table…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a table"
            onKeyDown={(e) => { if (e.key === "Enter" && match) centreOn(match.qualified); }} />
          <label className="schema-toggle"><input type="checkbox" checked={onlyUsed} onChange={(e) => setOnlyUsed(e.target.checked)} /> Only tables metrics read</label>
          <span className="grow" />
          <div className="seg">
            <button onClick={() => setView((v) => ({ ...v, k: Math.max(0.25, v.k / 1.2) }))} aria-label="Zoom out">−</button>
            <button onClick={() => fit()} title="Fit to screen">{Math.round(view.k * 100)}%</button>
            <button onClick={() => setView((v) => ({ ...v, k: Math.min(2, v.k * 1.2) }))} aria-label="Zoom in">+</button>
          </div>
          <button className="btn sm" onClick={arrange} title="Lay tables out again along their foreign keys">Arrange</button>
        </div>
        <div className="schema-legend">
          <span><i className="lg-ok" /><em className="ok">●</em> certified metrics reading it</span>
          <span><i className="lg-warn" /><em className="warn">◐</em> open proposals reading it</span>
          <span><b>PK</b> primary key</span><span><b>FK</b> foreign key</span>
          <span className="hide-sm">drag tables · drag the background to pan · ⌘/Ctrl + scroll to zoom</span>
        </div>
      </div>

      <aside className="schema-inspector">
        {sel ? <Inspector t={sel} data={data} centreOn={centreOn} /> : (
          <div className="stack">
            <div className="eyebrow">Schema map</div>
            <h2 className="schema-h">{data.database}</h2>
            <p className="use-note">{all.length} tables · {all.reduce((n, t) => n + t.foreignKeys.length, 0)} foreign keys · {Object.keys(usage).length} read by metrics or proposals{data.scannedAt ? ` · scanned ${new Date(data.scannedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}</p>
            <p className="use-lead">Select a table to see what it means, which metrics read it, how it links to the rest, and what its columns hold.</p>
            <ul className="schema-list">
              {[...all].sort((a, b) => (usage[b.qualified]?.length ?? 0) - (usage[a.qualified]?.length ?? 0) || a.qualified.localeCompare(b.qualified)).map((t) => (
                <li key={t.qualified}><button className="linkish plain" onClick={() => centreOn(t.qualified)}><span className="mono">{short(t.qualified)}</span><span className="faint">{usage[t.qualified]?.length ? `${usage[t.qualified].length} reading` : "unused"}</span></button></li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

function TableCard({ t, all, p, expanded, meaning, uses, state, onDown, onHover, onKey, onToggle }: {
  t: Table; all: Table[]; p: Pos; expanded: boolean; meaning?: string; uses: Use[]; state: string;
  onDown: (e: RPointerEvent) => void; onHover: (on: boolean) => void; onKey: (e: React.KeyboardEvent) => void; onToggle: () => void;
}) {
  const { shown, hidden } = visibleColumns(t, all, expanded);
  const keys = keyColumns(t, all);
  const fks = new Set(t.foreignKeys.flatMap((f) => f.columns));
  const certified = uses.filter((u) => u.kind === "metric").length, proposed = uses.length - certified;
  const tone = certified ? "ok" : proposed ? "warn" : "";
  return (
    <div className={`tcard ${tone} ${state}`} style={{ left: p.x, top: p.y, width: CARD_W }} tabIndex={0} role="button"
      aria-label={`${short(t.qualified)} table`} onPointerDown={onDown} onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)} onKeyDown={onKey}>
      <div className="tcard-head">
        <div className="tcard-title">
          <span className="mono">{short(t.qualified)}</span>
          <span className="tcard-rows" title={`${fmt(t.estimatedRows)} rows (estimate)`}>{compactRows(t.estimatedRows)}</span>
          <span className="tcard-uses">
            {certified > 0 && <span className="ok" title={`${certified} certified metric${certified > 1 ? "s" : ""} read this table`}>● {certified}</span>}
            {proposed > 0 && <span className="warn" title={`${proposed} open proposal${proposed > 1 ? "s" : ""} read this table`}>◐ {proposed}</span>}
          </span>
        </div>
        <div className="tcard-meaning" title={meaning}>{meaning ?? (t.kind === "view" ? "view" : "no reading yet")}</div>
      </div>
      <ul className="tcard-cols">
        {shown.map((c) => (
          <li key={c.name} className={keys.has(c.name) ? "key" : ""}>
            <span className="tcard-badge">{t.primaryKey.includes(c.name) ? "PK" : fks.has(c.name) ? "FK" : ""}</span>
            <span className="tcard-name">{c.name}</span>
            <span className="tcard-type">{c.type.replace("timestamp with time zone", "timestamptz").replace("character varying", "varchar")}</span>
          </li>
        ))}
      </ul>
      {(hidden > 0 || expanded) && <button className="tcard-more" onClick={onToggle}>{expanded ? "show fewer" : `+ ${hidden} more`}</button>}
    </div>
  );
}

function Inspector({ t, data, centreOn }: { t: Table; data: SchemaMap; centreOn: (id: string) => void }) {
  const slug = useSlug();
  const entity = data.entities.find((e) => e.table === t.qualified);
  const profile = data.profiles.find((p) => p.table === t.qualified);
  const uses = data.usage[t.qualified] ?? [];
  const incoming = data.tables.flatMap((o) => o.foreignKeys.filter((f) => f.refTable === t.qualified).map((f) => ({ from: o.qualified, f })));
  return (
    <div className="stack">
      <div className="eyebrow">{t.kind} · {fmt(t.estimatedRows)} rows</div>
      <h2 className="schema-h mono">{short(t.qualified)}</h2>
      {entity && <p className="use-lead">{entity.meaning} <ConfidenceChip c={entity.confidence} /></p>}

      <section>
        <h4 className="schema-sub">Read by</h4>
        {uses.length ? (
          <ul className="schema-list">
            {uses.map((u) => (
              <li key={u.kind + u.ref}><Link href={u.kind === "metric" ? routes.metric(slug, u.ref) : routes.proposal(slug, Number(u.ref))}>{u.name}</Link>
                <span className={u.kind === "metric" ? "ok" : "warn"}>{u.kind === "metric" ? "certified" : u.contested ? "needs you" : "proposal"}</span></li>
            ))}
          </ul>
        ) : <p className="use-note">No metric or proposal reads this table.</p>}
      </section>

      <section>
        <h4 className="schema-sub">Links</h4>
        {t.foreignKeys.length + incoming.length ? (
          <ul className="schema-list">
            {t.foreignKeys.map((f, i) => <li key={"o" + i}><span className="mono">{f.columns.join(", ")} →</span><button className="linkish" onClick={() => centreOn(f.refTable)}>{short(f.refTable)}</button></li>)}
            {incoming.map(({ from, f }, i) => <li key={"i" + i}><button className="linkish" onClick={() => centreOn(from)}>{short(from)}</button><span className="mono">.{f.columns.join(", ")} → {f.refColumns.join(", ")}</span></li>)}
          </ul>
        ) : <p className="use-note">No foreign keys in or out.</p>}
      </section>

      <section>
        <h4 className="schema-sub">Columns</h4>
        <div className="ev-cols schema-cols">
          {t.columns.map((c) => {
            const pc = profile?.columns.find((x) => x.column === c.name);
            const top = pc?.topValues?.length ? Object.fromEntries(pc.topValues.map((v) => [v.value ?? "null", v.count])) : null;
            return (
              <div key={c.name}>
                <div className="row"><span className="mono">{c.name}</span><span className="grow" /><span className="ev-stat">{c.type}</span></div>
                {top ? <Distribution values={top} /> : pc && (
                  <div className="ev-stat">{pc.nullFraction ? `${Math.round(pc.nullFraction * 1000) / 10}% null` : "never null"}{pc.distinct != null ? ` · ${fmt(pc.distinct)} distinct` : ""}{pc.min ? <> · <span className="nowrap">{String(pc.min).slice(0, 10)} → {String(pc.max).slice(0, 10)}</span></> : ""}{pc.withheld ? ` · values withheld (${pc.withheld.replace("_", " ")})` : ""}</div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
