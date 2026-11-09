import { useState } from "react";
import { createUser, errMsg, getUsers, updateUser } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import Icon from "../components/Icon";
import useAsync from "../components/useAsync";
import { Avatar, Badge, ErrorBox, Loading, Notice, PageHeader, fmtDate } from "../components/ui";

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
        <h3><Icon name="userPlus" size={17} /> Add user</h3>
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
        <button className="btn primary mt" type="submit" disabled={busy}><Icon name="plus" size={15} />Add user</button>
      </form>

      {err && <Notice tone="error" onClose={() => setErr("")}>{err}</Notice>}
      {msg && <Notice tone="success" onClose={() => setMsg("")}>{msg}</Notice>}

      {loading ? <Loading /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
        <div className="card flush">
          <div className="table-wrap">
          <table>
            <thead>
              <tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th /></tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u._id === me?._id;
                return (
                  <tr key={u._id}>
                    <td>
                      <div className="person">
                        <Avatar name={u.name} size={34} />
                        <div className="stack" style={{ gap: 0 }}>
                          <b>{u.name}{self && <span className="muted" style={{ fontWeight: 500 }}> (you)</span>}</b>
                          <span className="sub">{u.email}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <select style={{ width: "auto" }} value={u.role} disabled={busy || self}
                        onChange={(e) => run(() => updateUser(u._id, { role: e.target.value }), `Role of ${u.email} changed.`)}>
                        <option value="REVIEWER">Reviewer</option>
                        <option value="ADMIN">Admin</option>
                      </select>
                    </td>
                    <td><Badge value={u.active ? "Active" : "Disabled"} tone={u.active ? "green" : "gray"} /></td>
                    <td className="muted nowrap">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : "Never"}</td>
                    <td className="actions-cell">
                      <button className="btn small" type="button" disabled={busy} onClick={() => resetPassword(u)}><Icon name="lock" size={13} />Reset password</button>
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
        </div>
      )}
    </>
  );
}
