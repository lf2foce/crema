// Pure geometry for the schema map: which columns a card shows, how tall it is, and where it sits.
import type { Column, Table } from "@/core/types";

export const CARD_W = 248;
export const HEAD_H = 62; // name row + one line of meaning
export const ROW_H = 24;
export const MORE_H = 26;
export const PAD_B = 6;
export const COL_GAP = 112;
export const ROW_GAP = 28;
export const COMPACT = 6; // columns shown before "+ n more", key columns always shown

export type Pos = { x: number; y: number };

/** Columns that take part in a relationship: this table's PK and FKs, and columns other tables point at. */
export function keyColumns(t: Table, all: Table[]): Set<string> {
  const keys = new Set<string>([...t.primaryKey, ...t.foreignKeys.flatMap((f) => f.columns)]);
  for (const o of all) for (const f of o.foreignKeys) if (f.refTable === t.qualified) f.refColumns.forEach((c) => keys.add(c));
  return keys;
}

/** Key columns first (in table order), then the rest; compact cards cut after COMPACT but never drop a key. */
export function visibleColumns(t: Table, all: Table[], expanded: boolean): { shown: Column[]; hidden: number } {
  const keys = keyColumns(t, all);
  const ordered = [...t.columns.filter((c) => keys.has(c.name)), ...t.columns.filter((c) => !keys.has(c.name))];
  if (expanded) return { shown: ordered, hidden: 0 };
  const n = Math.max(COMPACT, ordered.filter((c) => keys.has(c.name)).length);
  return { shown: ordered.slice(0, n), hidden: Math.max(0, ordered.length - n) };
}

export function cardHeight(t: Table, all: Table[], expanded: boolean): number {
  const { shown, hidden } = visibleColumns(t, all, expanded);
  return HEAD_H + shown.length * ROW_H + (hidden ? MORE_H : 0) + PAD_B;
}

/** Vertical centre of a column's row inside its card (falls back to the header if it's hidden). */
export function columnY(t: Table, all: Table[], expanded: boolean, column: string): number {
  const i = visibleColumns(t, all, expanded).shown.findIndex((c) => c.name === column);
  return i < 0 ? HEAD_H / 2 : HEAD_H + ROW_H * (i + 0.5);
}

/**
 * Layered layout along foreign keys: a table sits one layer right of every table it references,
 * so dimensions (accounts, plans) read first and facts (events, invoices) follow. Tables with no
 * relationship at all go in a final column. Within a layer, tables are ordered by the average
 * position of what they reference, which keeps most lines short and uncrossed.
 */
export function autoLayout(tables: Table[], height: (t: Table) => number): Record<string, Pos> {
  const by = new Map(tables.map((t) => [t.qualified, t]));
  const refs = (t: Table) => [...new Set(t.foreignKeys.map((f) => f.refTable))].filter((r) => r !== t.qualified && by.has(r));
  const referenced = new Set(tables.flatMap((t) => refs(t)));
  const rank = new Map<string, number>();
  const visit = (t: Table, seen: Set<string>): number => {
    if (rank.has(t.qualified)) return rank.get(t.qualified)!;
    if (seen.has(t.qualified)) return 0; // FK cycle: break it here
    seen.add(t.qualified);
    const r = Math.max(-1, ...refs(t).map((q) => visit(by.get(q)!, seen))) + 1;
    rank.set(t.qualified, r);
    return r;
  };
  tables.forEach((t) => visit(t, new Set()));

  const isolated = tables.filter((t) => !refs(t).length && !referenced.has(t.qualified));
  const layers: Table[][] = [];
  for (const t of tables) {
    if (isolated.includes(t)) continue;
    (layers[rank.get(t.qualified)!] ??= []).push(t);
  }
  const compact = layers.filter(Boolean);
  if (isolated.length) compact.push(isolated);

  const pos: Record<string, Pos> = {};
  compact.forEach((layer, li) => {
    const centre = (t: Table) => {
      const ys = refs(t).map((q) => pos[q]).filter(Boolean).map((p) => p.y);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY;
    };
    const ordered = [...layer].sort((a, b) => centre(a) - centre(b) || b.estimatedRows - a.estimatedRows || a.qualified.localeCompare(b.qualified));
    let y = 0;
    for (const t of ordered) {
      pos[t.qualified] = { x: li * (CARD_W + COL_GAP), y };
      y += height(t) + ROW_GAP;
    }
  });
  return pos;
}

/** Bounding box of placed cards, for "fit to screen". */
export function bounds(pos: Record<string, Pos>, height: (q: string) => number) {
  const qs = Object.keys(pos);
  if (!qs.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x0 = Math.min(...qs.map((q) => pos[q].x)), y0 = Math.min(...qs.map((q) => pos[q].y));
  const x1 = Math.max(...qs.map((q) => pos[q].x + CARD_W)), y1 = Math.max(...qs.map((q) => pos[q].y + height(q)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A foreign-key line between two column rows, leaving and entering from the facing sides. */
export function edgePath(from: Pos, fromY: number, to: Pos, toY: number) {
  const fromRight = to.x + CARD_W / 2 >= from.x + CARD_W / 2;
  const x1 = fromRight ? from.x + CARD_W : from.x;
  const x2 = fromRight ? to.x : to.x + CARD_W;
  const y1 = from.y + fromY, y2 = to.y + toY;
  const dir = fromRight ? 1 : -1;
  const sameColumn = Math.abs(from.x - to.x) < CARD_W; // stacked cards: loop out to the right
  if (sameColumn) {
    const xr = Math.max(from.x, to.x) + CARD_W, bulge = 36;
    return { d: `M ${xr} ${y1} C ${xr + bulge} ${y1}, ${xr + bulge} ${y2}, ${xr} ${y2}`, start: { x: xr, y: y1, dir: 1 }, end: { x: xr, y: y2, dir: 1 } };
  }
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return { d: `M ${x1} ${y1} C ${x1 + dir * dx} ${y1}, ${x2 - dir * dx} ${y2}, ${x2} ${y2}`, start: { x: x1, y: y1, dir }, end: { x: x2, y: y2, dir: -dir } };
}
