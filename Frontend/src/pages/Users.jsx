import { useState } from "react";
import { createUser, errMsg, getUsers, updateUser } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import useAsync from "../components/useAsync";
import { ErrorBox, Loading, PageHeader, fmtDate } from "../components/ui";

const EMPTY = { name: "", email: "", password: "", role: "REVIEWER" };

export default function Users() {
  const { user: me } = useAuth();
  const { data: users, loading, error, reload } = useAsync(getUsers, []);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const run = async (fn, okText) => {
    setErr(""); setMsg(""); setBusy(true);
    try { await fn(); setMsg(okText); await reload(); } catch (e) { setErr(errMsg(e)); }
    setBusy(false);
  };

  const submit = (e) => {
    e.preventDefault();
    run(async () => { await createUser(form); setForm(EMPTY); }, `User ${form.email} created.`);
  };

  const resetPassword = (u) => {
    const password = window.prompt(`New password for ${u.email} (min 8 characters):`);
    if (password) run(() => updateUser(u._id, { password }), `Password of ${u.email} reset; their sessions were logged out.`);
  };

  return (
    <>
      <PageHeader title="Users" subtitle="Who can log in. Reviewers review candidates; admins can also delete records and manage users." />

      <form className="card" onSubmit={submit}>
        <h3>Add user</h3>
        <div className="grid-form">
          <label>Name *<input value={form.name} onChange={set("name")} required /></label>
          <label>Email *<input type="email" value={form.email} onChange={set("email")} required /></label>
          <label>Password * (min 8)<input type="password" autoComplete="new-password" value={form.password} onChange={set("password")} minLength={8} required /></label>
          <label>Role
            <select value={form.role} onChange={set("role")}>
              <option value="REVIEWER">Reviewer</option>
              <option value="ADMIN">Admin</option>
            </select>
          </label>
        </div>
        <button className="btn primary" type="submit" disabled={busy}>Add user</button>
      </form>

      {err && <div className="state error">{err}</div>}
      {msg && <div className="state">{msg}</div>}

      {loading ? <Loading /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
        <div className="card flush">
          <table>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th /></tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u._id === me?._id;
                return (
                  <tr key={u._id}>
                    <td>{u.name}{self && <span className="muted"> (you)</span>}</td>
                    <td>{u.email}</td>
                    <td>
                      <select value={u.role} disabled={busy || self}
                        onChange={(e) => run(() => updateUser(u._id, { role: e.target.value }), `Role of ${u.email} changed.`)}>
                        <option value="REVIEWER">Reviewer</option>
                        <option value="ADMIN">Admin</option>
                      </select>
                    </td>
                    <td>{u.active ? "Active" : "Disabled"}</td>
                    <td>{fmtDate(u.lastLoginAt)}</td>
                    <td className="row">
                      <button className="btn small" type="button" disabled={busy} onClick={() => resetPassword(u)}>Reset password</button>
                      {!self && (
                        <button className={`btn small ${u.active ? "danger" : ""}`} type="button" disabled={busy}
                          onClick={() => run(() => updateUser(u._id, { active: !u.active }), `${u.email} ${u.active ? "disabled" : "enabled"}.`)}>
                          {u.active ? "Disable" : "Enable"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
