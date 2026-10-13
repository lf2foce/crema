// Pure formatting, shared by the server and the browser.
import type { MetricUnit } from "./types";

// Money is shown in one workspace currency. The server reads CREMA_CURRENCY; the browser is
// told through /api/state (see setCurrency). Default is the dong: this is built for Vietnamese teams.
let currency = (typeof process !== "undefined" && (process.env?.CREMA_CURRENCY || process.env?.CREAMA_CURRENCY)) || "VND";

export function setCurrency(code: string | null | undefined) {
  if (code && /^[A-Za-z]{3}$/.test(code)) currency = code.toUpperCase();
}
export function currentCurrency() {
  return currency;
}

export function fmt(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const trim = (n: number, digits: number) => n.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1");

/** Vietnamese-style money: 1.234.567 ₫, and "1,25 tỷ ₫" / "340 tr ₫" when compact. */
function dong(v: number, compact: boolean): string {
  const a = Math.abs(v);
  const vn = (n: number) => n.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
  if (compact && a >= 1e9) return `${vn(Number(trim(v / 1e9, 2)))} tỷ ₫`;
  if (compact && a >= 1e6) return `${vn(Number(trim(v / 1e6, a >= 1e8 ? 0 : 1)))} tr ₫`;
  return `${Math.round(v).toLocaleString("vi-VN")} ₫`;
}

function otherCurrency(v: number, code: string, compact: boolean): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: code, currencyDisplay: "narrowSymbol",
      notation: compact && Math.abs(v) >= 10_000 ? "compact" : "standard",
      maximumFractionDigits: compact && Math.abs(v) >= 10_000 ? 1 : Math.abs(v) < 1000 ? 2 : 0,
    }).format(v);
  } catch {
    return `${code} ${fmt(v)}`;
  }
}

export function money(v: number, opts: { compact?: boolean } = {}): string {
  const compact = opts.compact ?? true;
  return currency === "VND" ? dong(v, compact) : otherCurrency(v, currency, compact);
}

export function display(v: number | null | undefined, unit: MetricUnit, opts: { compact?: boolean } = {}): string {
  if (v === null || v === undefined) return "—";
  const compact = opts.compact ?? true;
  if (unit === "currency") return money(v, { compact });
  if (unit === "percent") return `${(v * 100).toFixed(v < 0.1 ? 2 : 1)}%`;
  if (compact && Math.abs(v) >= 100_000) return `${(v / 1000).toFixed(0)}k`;
  return fmt(Math.round(v * 100) / 100);
}
