import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { errMsg } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import Icon from "../components/Icon";
import { Notice } from "../components/ui";

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const from = location.state?.from || "/";
  if (user) return <Navigate to={from} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch (e2) {
      setErr(errMsg(e2));
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <section className="login-art">
        <div className="brand"><span className="logo"><Icon name="shield" size={19} strokeWidth={2} /></span>BGV Automation</div>
        <div>
          <h2>Verify candidates with confidence.</h2>
          <p>Search the public web for a candidate's profiles, score every match on independent evidence, and let a human make the final call.</p>
          <ul className="login-points">
            <li><Icon name="search" />Discovery across 30+ platforms</li>
            <li><Icon name="sparkle" />Evidence-based identity scoring</li>
            <li><Icon name="check" />Every decision recorded against a named reviewer</li>
          </ul>
        </div>
        <small>Private workspace · access by invitation only</small>
      </section>

      <section className="login-side">
        <form className="login-card" onSubmit={submit}>
          <div className="brand"><span className="logo"><Icon name="shield" size={19} strokeWidth={2} /></span>BGV Automation</div>
          <div>
            <h1>Welcome back</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>Sign in to continue to your workspace.</p>
          </div>
          <label>Email
            <input type="email" autoComplete="username" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
          </label>
          <label>Password
            <div className="pw">
              <input type={show ? "text" : "password"} autoComplete="current-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="icon-btn" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"}><Icon name="eye" size={17} /></button>
            </div>
          </label>
          {err && <Notice tone="error">{err}</Notice>}
          <button className="btn primary" type="submit" disabled={busy}>{busy ? <><span className="spinner" />Signing in…</> : <>Sign in<Icon name="arrowRight" size={16} /></>}</button>
          <p className="muted small" style={{ margin: 0, textAlign: "center" }}><Icon name="lock" size={13} /> No account? Ask your admin to add you.</p>
        </form>
      </section>
    </div>
  );
}
