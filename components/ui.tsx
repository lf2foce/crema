"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Check, Confidence, Environment, MetricUnit, SeriesPoint } from "@/core/types";
import { display } from "@/core/format";

export const SERIES = ["var(--s0)", "var(--s1)", "var(--s2)"];

export function ConfidenceChip({ c, why }: { c: Confidence; why?: string }) {
  const cls = c === "high" ? "ok" : c === "medium" ? "warn" : "fail";
  const label = c === "high" ? "High confidence" : c === "medium" ? "Medium confidence" : "Low confidence";
  return <span className={`chip ${cls}`} title={why}>{label}</span>;
}

export function CheckIcon({ level }: { level: Check["level"] }) {
  const color = { pass: "var(--ok)", warn: "var(--warn)", fail: "var(--fail)", info: "var(--info)" }[level];
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-label={level}>
      {level === "pass" && <path d="M3.5 8.5l3 3 6-7" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
      {level === "warn" && <><path d="M8 2l6.5 11.5h-13z" fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" /><path d="M8 6.5v3M8 11.5v.2" stroke={color} strokeWidth="1.6" strokeLinecap="round" /></>}
      {level === "fail" && <><circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="1.5" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke={color} strokeWidth="1.5" strokeLinecap="round" /></>}
      {level === "info" && <><circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="1.5" /><path d="M8 7.5v3.5M8 5v.2" stroke={color} strokeWidth="1.6" strokeLinecap="round" /></>}
    </svg>
  );
}

const ORDER = { fail: 0, warn: 1, info: 2, pass: 3 };
export function Checks({ checks }: { checks: Check[] }) {
  const sorted = [...checks].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  return (
    <ul className="checks">
      {sorted.map((c, i) => (
        <li key={c.id + i}><CheckIcon level={c.level} /><span>{c.message}</span></li>
      ))}
    </ul>
  );
}

export function checkSummary(checks: Check[]) {
  const n = (l: Check["level"]) => checks.filter((c) => c.level === l).length;
  return { pass: n("pass"), warn: n("warn"), fail: n("fail"), info: n("info") };
}

export function CheckSummary({ checks }: { checks: Check[] }) {
  const s = checkSummary(checks);
  return (
    <span className="row small gap-3">
      {s.pass > 0 && <span className="row gap-1"><CheckIcon level="pass" />{s.pass}</span>}
      {s.warn > 0 && <span className="row gap-1"><CheckIcon level="warn" />{s.warn}</span>}
      {s.fail > 0 && <span className="row gap-1"><CheckIcon level="fail" />{s.fail}</span>}
    </span>
  );
}

/** Value distribution of a column — what the model saw, shown as evidence. */
export function Distribution({ values }: { values: Record<string, number> }) {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, v]) => n + v, 0) || 1;
  const palette = ["var(--s0)", "var(--s1)", "var(--s2)", "var(--faint)", "var(--border-strong)"];
  return (
    <div>
      <div className="dist">
        {entries.map(([k, v], i) => <span key={k} style={{ width: `${(v / total) * 100}%`, background: palette[Math.min(i, palette.length - 1)] }} />)}
      </div>
      <div className="legend">
        {entries.slice(0, 6).map(([k, v], i) => (
          <span key={k} className="row gap-1">
            <span className="dot" style={{ background: palette[Math.min(i, palette.length - 1)] }} />
            <span className="mono">{k}</span> {Math.round((v / total) * 100)}%
          </span>
        ))}
        {entries.length > 6 && <span>+{entries.length - 6} more</span>}
      </div>
    </div>
  );
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="btn sm copy" onClick={async () => { await navigator.clipboard.writeText(text).catch(() => {}); setDone(true); setTimeout(() => setDone(false), 1200); }}>
      {done ? "Copied" : label}
    </button>
  );
}

export function Code({ children, copy = true }: { children: string; copy?: boolean }) {
  return <pre className="code">{children}{copy && <Copy text={children} />}</pre>;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function Sparkline({ series, color = "var(--s0)", width = 64, height = 20 }: { series: SeriesPoint[]; color?: string; width?: number; height?: number }) {
  const vals = series.map((p) => p.value ?? 0);
  if (vals.length < 2) return <svg width={width} height={height} />;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * width},${height - 2 - ((v - lo) / (hi - lo || 1)) * (height - 4)}`).join(" ");
  return <svg width={width} height={height} aria-hidden><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

export function LineChart({ lines, unit, height = 180 }: { lines: { label: string; series: SeriesPoint[]; color: string }[]; unit: MetricUnit; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.max(0, ...lines.map((l) => l.series.length));
  const all = lines.flatMap((l) => l.series.map((p) => p.value ?? 0));
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  // Margins come from the labels actually drawn, so long values ("300.000 ₫") are never clipped.
  const lastOf = (l: { series: SeriesPoint[] }) => l.series[l.series.length - 1]?.value ?? null;
  const padL = Math.max(...ticks.map((t) => textWidth(display(t, unit)))) + 10;
  const padR = Math.max(8, ...lines.map((l) => (lastOf(l) == null ? 0 : textWidth(display(lastOf(l), unit), 600) + 14)));
  const padT = 10, padB = 22;
  const W = Math.max(width, 200), H = height;
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const months = lines[0]?.series ?? [];
  const label = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

  return (
    <div ref={ref} style={{ position: "relative" }}>
      {width > 0 && (
        <svg width={W} height={H} onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => { const r = (e.currentTarget as SVGElement).getBoundingClientRect(); const i = Math.round(((e.clientX - r.left - padL) / (W - padL - padR)) * (n - 1)); setHover(i >= 0 && i < n ? i : null); }}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--faint)" className="num">{display(t, unit)}</text>
            </g>
          ))}
          {months.map((p, i) => (i === n - 1 || (i % Math.ceil(n / 6) === 0 && x(n - 1) - x(i) >= 48)) && (
            <text key={p.start} x={x(i)} y={H - 6} textAnchor={i === n - 1 && n > 1 ? "end" : i === 0 ? "start" : "middle"} fontSize="11" fill="var(--faint)">{label(p.start)}</text>
          ))}
          {lines.map((l) => {
            const pts = l.series.map((p, i) => `${x(i)},${y(p.value ?? 0)}`);
            const k = l.series.findIndex((p) => p.partial);
            const solid = k > 0 ? pts.slice(0, k) : pts;
            return (
              <g key={l.label}>
                <polyline fill="none" stroke={l.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={solid.join(" ")} />
                {k > 0 && <polyline fill="none" stroke={l.color} strokeWidth="2" strokeDasharray="4 4" strokeLinecap="round" points={pts.slice(k - 1).join(" ")} />}
                {k > 0 && <circle cx={x(k)} cy={y(l.series[k].value ?? 0)} r="3" fill="var(--panel)" stroke={l.color} strokeWidth="1.5" />}
              </g>
            );
          })}
          {endLabels(lines.map((l) => ({ v: lastOf(l), color: l.color, y: y(lastOf(l) ?? 0) })), padT, H - padB).map((e, i) => e.v != null && (
            <text key={i} x={x(n - 1) + 8} y={e.y + 4} fontSize="11" fontWeight="600" fill={e.color} className="num">{display(e.v, unit)}</text>
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="var(--border-strong)" strokeDasharray="3 3" />
              {lines.map((l) => l.series[hover] && <circle key={l.label} cx={x(hover)} cy={y(l.series[hover].value ?? 0)} r="3.5" fill={l.color} />)}
            </g>
          )}
        </svg>
      )}
      {hover !== null && months[hover] && (
        <div className="card small" style={{ position: "absolute", top: 0, left: Math.min(x(hover) + 10, W - 190), padding: "6px 10px", pointerEvents: "none", minWidth: 150 }}>
          <div className="faint">{label(months[hover].start)}{months[hover].partial ? " · so far" : ""}</div>
          {lines.map((l) => (
            <div key={l.label} className="row num"><span className="dot" style={{ background: l.color }} /><span className="grow ellipsis">{l.label}</span><b>{display(l.series[hover]?.value ?? null, unit)}</b></div>
          ))}
        </div>
      )}
    </div>
  );
}

let measure: CanvasRenderingContext2D | null = null;
/** Rendered width of an 11px chart label, so margins fit the real text. */
function textWidth(text: string, weight = 400) {
  if (typeof document === "undefined") return text.length * 7;
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return text.length * 7;
  measure.font = `${weight} 11px Geist, Arial, sans-serif`;
  return Math.ceil(measure.measureText(text).width);
}

/** End-of-line labels pushed apart so two lines ending close together stay readable. */
function endLabels<T extends { y: number }>(items: T[], top: number, bottom: number, gap = 14): T[] {
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) order[k].y = Math.max(order[k].y, order[k - 1].y + gap);
  const over = order.length ? order[order.length - 1].y - bottom : 0;
  if (over > 0) for (const o of order) o.y = Math.max(top, o.y - over);
  return order.sort((a, b) => a.i - b.i);
}

/** 3–5 round tick values covering [lo, hi]. */
function niceTicks(lo: number, hi: number): number[] {
  if (hi === lo) return [lo, lo + 1];
  const raw = (hi - lo) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let t = Math.floor(lo / step) * step; t < hi + step - 1e-9; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal card pad" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>{children}</div>
    </div>
  );
}

// ---------- confirmation ----------

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  /** destructive: the confirm button is red */
  danger?: boolean;
  /** the exact text that must be typed to confirm (shown, copyable) */
  type?: string;
  /** ask for a reason (optional) and return it */
  reason?: { label: string; placeholder?: string };
};
export type ConfirmResult = { ok: boolean; reason: string };

/** Replaces window.confirm/prompt: says what will happen, shows the text to type, enables the button when it matches. */
export function ConfirmDialog({ opts, onDone }: { opts: ConfirmOptions; onDone: (r: ConfirmResult) => void }) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const ready = !opts.type || typed === opts.type;
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (ready) onDone({ ok: true, reason: reason.trim() }); };
  return (
    <Modal onClose={() => onDone({ ok: false, reason: "" })}>
      <form className="stack confirm" onSubmit={submit}>
        <h2 className="schema-h m-0">{opts.title}</h2>
        {opts.body && <div className="muted">{opts.body}</div>}
        {opts.type && <>
          <div className="confirm-type"><span>Type this to confirm</span><code className="mono">{opts.type}</code><Copy text={opts.type} /></div>
          <input className="input mono" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" aria-label={`Type ${opts.type} to confirm`} placeholder={opts.type} />
        </>}
        {opts.reason && <label className="field">{opts.reason.label}<textarea className="input" rows={2} autoFocus={!opts.type} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={opts.reason.placeholder} /></label>}
        <div className="row"><span className="grow" /><button type="button" className="btn" onClick={() => onDone({ ok: false, reason: "" })}>Cancel</button><button className={`btn ${opts.danger ? "danger-solid" : "primary"}`} disabled={!ready} autoFocus={!opts.type && !opts.reason}>{opts.confirmLabel ?? "Confirm"}</button></div>
      </form>
    </Modal>
  );
}

/** `const [ask, dialog] = useConfirm()`; render `{dialog}`; `if (!(await ask({...})).ok) return;` */
export function useConfirm() {
  const [req, setReq] = useState<{ opts: ConfirmOptions; resolve: (r: ConfirmResult) => void } | null>(null);
  const ask = useCallback((opts: ConfirmOptions) => new Promise<ConfirmResult>((resolve) => setReq({ opts, resolve })), []);
  const dialog = req ? <ConfirmDialog opts={req.opts} onDone={(r) => { req.resolve(r); setReq(null); }} /> : null;
  return [ask, dialog] as const;
}

// ---------- environments ----------

const ENV_LABEL: Record<Environment, string> = { production: "PROD", staging: "STG", development: "DEV" };
/** Says what a database is for. Production is the loud one: it's what real people use. Nothing for an unlabelled database. */
export function EnvBadge({ environment }: { environment: Environment | null }) {
  if (!environment) return null;
  return <span className={`env env-${environment}`} title={environment}>{ENV_LABEL[environment]}</span>;
}
