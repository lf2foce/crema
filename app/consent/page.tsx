"use client";
import { useState } from "react";
import { authClient, nextUrl } from "@/lib/authClient";

const SCOPES: Record<string, string> = {
  openid: "Know it’s you",
  profile: "Your name",
  email: "Your email address",
  offline_access: "Stay connected until you revoke it",
  "metrics:read": "Read certified metrics and their values",
};

/** An AI assistant (MCP client) asks to read this instance's certified metrics on your behalf. */
export default function Consent() {
  const q = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const client = q.get("client_id") ?? "";
  const scopes = (q.get("scope") ?? "").split(" ").filter(Boolean);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let host = client;
  try { host = new URL(client).host; } catch { /* a plain client id */ }

  const answer = async (accept: boolean) => {
    setBusy(true); setError(null);
    const res = await authClient.oauth2.consent({ accept });
    if (res.error) { setBusy(false); setError(res.error.message ?? "Something went wrong."); return; }
    const to = nextUrl(res.data);
    if (to) window.location.href = to;
    else { setBusy(false); setError(accept ? "Allowed. You can close this tab." : "Denied. You can close this tab."); }
  };

  return (
    <div className="connect auth">
      <h1>Allow access to Creama?</h1>
      <div className="auth-card">
        <p className="use-lead"><b className="mono">{host || "An application"}</b> wants to:</p>
        <ul className="consent-list">
          {scopes.map((s) => <li key={s}>{SCOPES[s] ?? s}</li>)}
        </ul>
        <p className="use-note">It can only read metrics a person has certified — never drafts, never your raw tables. You can revoke access at any time.</p>
        {error && <p className="small m-0">{error}</p>}
        <div className="row">
          <button className="btn primary lg grow" onClick={() => answer(true)} disabled={busy}>Allow</button>
          <button className="btn lg" onClick={() => answer(false)} disabled={busy}>Deny</button>
        </div>
      </div>
    </div>
  );
}
