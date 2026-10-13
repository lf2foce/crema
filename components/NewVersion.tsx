"use client";
import { useEffect, useState } from "react";

/**
 * A tab left open across a deploy keeps running the old code (and pressing Enter on a URL that only
 * differs by its #fragment doesn't reload). Ask the server which build it runs now, and say so.
 */
export function NewVersion() {
  const mine = process.env.NEXT_PUBLIC_CREMA_BUILD;
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!mine) return;
    const check = async () => {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const { build } = await r.json();
        if (build && build !== mine) setStale(true);
      } catch { /* offline or restarting: try again later */ }
    };
    const t = setInterval(check, 60_000);
    const onFocus = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("visibilitychange", onFocus); window.addEventListener("focus", onFocus);
    check();
    return () => { clearInterval(t); window.removeEventListener("visibilitychange", onFocus); window.removeEventListener("focus", onFocus); };
  }, [mine]);
  if (!stale) return null;
  return (
    <div className="new-version" role="status">
      <span>A new version of Crema is available.</span>
      <button className="btn sm primary" onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}
