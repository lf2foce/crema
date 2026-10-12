"use client";
import { useEffect, useState } from "react";
import { authClient, nextUrl } from "@/lib/authClient";

export default function SignIn() {
  const [setup, setSetup] = useState<{ hasUsers: boolean; google: boolean; setupToken?: boolean; setupBlocked?: string | null } | null>(null);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [down, setDown] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/setup").then((r) => r.json()).then((d) => (d.error ? setDown(d.error) : setSetup(d))).catch(() => setDown("Creama isn’t reachable."));
  }, []);

  const oauth = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("client_id");
  const done = (data: unknown) => {
    const to = nextUrl(data);
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.href = to ?? (next && next.startsWith("/") ? next : "/");
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = setup?.hasUsers
      ? await authClient.signIn.email({ email, password })
      : await authClient.signUp.email({ name, email, password }, { headers: token ? { "x-creama-setup-token": token } : {} });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Could not sign in.");
    else done(res.data);
  };
  const google = async () => {
    setBusy(true);
    const res = await authClient.signIn.social({ provider: "google", callbackURL: oauth ? window.location.href : "/" });
    if (res.error) { setBusy(false); setError(res.error.message ?? "Google sign-in failed."); }
  };

  if (down) return <div className="connect auth"><h1>Creama can’t start</h1><p className="auth-card m-0">{down}</p></div>;
  if (!setup) return <div className="center"><span className="spin" /></div>;
  const first = !setup.hasUsers;
  return (
    <div className="connect auth">
      <h1>{first ? "Set up Creama" : oauth ? "Sign in to connect your AI assistant" : "Sign in to Creama"}</h1>
      <form className="auth-card" onSubmit={submit}>
        {first && <p className="use-note">You’re the first person here, so this account becomes the admin. Others join when you invite them.</p>}
        {first && setup.setupBlocked && <p className="small text-fail m-0">{setup.setupBlocked}</p>}
        {first && setup.setupToken && <label className="field">Setup token<input className="input" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" spellCheck={false} /></label>}
        {first && <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></label>}
        <label className="field">Email<input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!first} autoComplete="email" /></label>
        <label className="field">Password<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete={first ? "new-password" : "current-password"} /></label>
        {error && <p className="text-fail small m-0">{error}</p>}
        <button className="btn primary lg" disabled={busy}>{busy ? <span className="spin" /> : first ? "Create admin account" : "Sign in"}</button>
        {setup.google && !first && <>
          <div className="auth-or"><span>or</span></div>
          <button type="button" className="btn lg" onClick={google} disabled={busy}>Continue with Google</button>
          <p className="use-note">Google works for emails an admin has invited.</p>
        </>}
      </form>
    </div>
  );
}
