import { useState } from "react";
import { changePassword, errMsg } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/ui";

export default function Account() {
  const { user, replaceSession } = useAuth();
  const [form, setForm] = useState({ current: "", next: "", repeat: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setMsg("");
    if (form.next !== form.repeat) return setErr("The new passwords do not match.");
    setBusy(true);
    try {
      replaceSession(await changePassword(form.current, form.next));
      setForm({ current: "", next: "", repeat: "" });
      setMsg("Password changed. Other sessions have been logged out.");
    } catch (e2) { setErr(errMsg(e2)); }
    setBusy(false);
  };

  return (
    <>
      <PageHeader title="My account" subtitle={`${user?.name} · ${user?.email} · ${user?.role}`} />
      <form className="card narrow-form" onSubmit={submit}>
        <h3>Change password</h3>
        <label>Current password
          <input type="password" autoComplete="current-password" value={form.current} onChange={set("current")} required />
        </label>
        <label>New password (min 8 characters)
          <input type="password" autoComplete="new-password" value={form.next} onChange={set("next")} minLength={8} required />
        </label>
        <label>Repeat new password
          <input type="password" autoComplete="new-password" value={form.repeat} onChange={set("repeat")} minLength={8} required />
        </label>
        {err && <div className="state error">{err}</div>}
        {msg && <div className="state">{msg}</div>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
      </form>
    </>
  );
}
