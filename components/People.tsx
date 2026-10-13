"use client";
import { useCallback, useEffect, useState } from "react";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import { ago, type Me } from "@/lib/client";
import { authClient } from "@/lib/authClient";
import { useConfirm } from "./ui";

type U = { id: string; name: string; email: string; role?: string | null; createdAt: string | Date; banned?: boolean | null };

/** Admin only: who can sign in. Crema is invite-only after the first account. */
export function People({ me, notify }: { me: Me; notify: (t: string, e?: boolean) => void }) {
  const [ask, confirmDialog] = useConfirm();
  const [users, setUsers] = useState<U[] | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authClient.admin.listUsers({ query: { limit: 200, sortBy: "createdAt", sortDirection: "asc" } });
    if (res.error) notify(res.error.message ?? "Could not load people.", true);
    else setUsers(res.data.users as U[]);
  }, [notify]);
  useEffect(() => { if (me.role === "admin") load(); }, [me.role, load]);

  if (me.role !== "admin") return <div className="page narrow"><h1 className="title">People</h1><p className="muted">Only an admin can manage who signs in.</p></div>;

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    // no password given: the person signs in with Google (an invited email), or an admin sets one later
    const pw = password || crypto.getRandomValues(new Uint32Array(6)).join("-");
    const res = await authClient.admin.createUser({ name, email, password: pw, role });
    setBusy(false);
    if (res.error) { notify(res.error.message ?? "Could not invite.", true); return; }
    notify(password ? `Added ${email}. Share the password with them yourself.` : `Added ${email}. They can sign in with Google.`);
    setName(""); setEmail(""); setPassword(""); setRole("user");
    load();
  };
  const remove = async (u: U) => {
    if (!(await ask({ title: `Remove ${u.email}?`, body: "They can no longer sign in. What they certified stays, with their name.", confirmLabel: "Remove person", danger: true })).ok) return;
    const res = await authClient.admin.removeUser({ userId: u.id });
    if (res.error) notify(res.error.message ?? "Could not remove.", true); else load();
  };
  const toggleRole = async (u: U) => {
    const res = await authClient.admin.setRole({ userId: u.id, role: u.role === "admin" ? "user" : "admin" });
    if (res.error) notify(res.error.message ?? "Could not change the role.", true); else load();
  };

  return (
    <div className="page narrow">
      <h1 className="title">People</h1>
      <p className="meaning">Crema is invite-only. Everyone here can review and certify metrics; admins also choose the database and invite people.</p>

      <form className="card pad stack" onSubmit={invite}>
        <div className="section-title m-0">Invite someone</div>
        <div className="form-grid">
          <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label className="field">Email<input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label className="field">Password (optional)<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={MIN_PASSWORD_LENGTH} placeholder="Leave empty for Google sign-in" autoComplete="new-password" /></label>
          <label className="field">Role
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}><option value="user">Member</option><option value="admin">Admin</option></select>
          </label>
        </div>
        <div className="row"><span className="grow faint small">No email is sent: tell them yourself where to sign in.</span><button className="btn primary" disabled={busy}>Add person</button></div>
      </form>

      <div className="section card">
        {(users ?? []).map((u) => (
          <div key={u.id} className={`row pad list-row`}>
            <div className="grow">
              <div><b>{u.name}</b>{u.id === me.id && <span className="faint"> · you</span>}</div>
              <div className="small muted">{u.email} · joined {ago(new Date(u.createdAt).toISOString())}</div>
            </div>
            <span className={`chip ${u.role === "admin" ? "accent" : ""}`}>{u.role === "admin" ? "Admin" : "Member"}</span>
            {u.id !== me.id && <>
              <button className="btn sm ghost" onClick={() => toggleRole(u)}>{u.role === "admin" ? "Make member" : "Make admin"}</button>
              <button className="btn sm ghost text-fail" onClick={() => remove(u)}>Remove</button>
            </>}
          </div>
        ))}
        {!users && <div className="pad"><span className="spin" /></div>}
      </div>
      {confirmDialog}
    </div>
  );
}
