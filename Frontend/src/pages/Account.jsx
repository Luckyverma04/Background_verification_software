import { useState } from "react";
import { changePassword, errMsg } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import Icon from "../components/Icon";
import { Avatar, Badge, Notice, PageHeader } from "../components/ui";

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
      <PageHeader title="My account" subtitle="Your profile and sign-in settings." />
      <div className="card" style={{ maxWidth: 520 }}>
        <div className="hero">
          <Avatar name={user?.name} size={60} />
          <div className="grow">
            <div className="row"><h3 style={{ margin: 0, fontSize: 18 }}>{user?.name}</h3><Badge value={user?.role} /></div>
            <div className="muted">{user?.email}</div>
          </div>
        </div>
      </div>
      <form className="card narrow-form" style={{ maxWidth: 520 }} onSubmit={submit}>
        <h3 style={{ margin: 0 }}><Icon name="lock" size={17} /> Change password</h3>
        <label>Current password
          <input type="password" autoComplete="current-password" value={form.current} onChange={set("current")} required />
        </label>
        <label>New password (min 8 characters)
          <input type="password" autoComplete="new-password" value={form.next} onChange={set("next")} minLength={8} required />
        </label>
        <label>Repeat new password
          <input type="password" autoComplete="new-password" value={form.repeat} onChange={set("repeat")} minLength={8} required />
        </label>
        {err && <Notice tone="error">{err}</Notice>}
        {msg && <Notice tone="success">{msg}</Notice>}
        <button className="btn primary" style={{ alignSelf: "flex-start" }} type="submit" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
      </form>
    </>
  );
}
