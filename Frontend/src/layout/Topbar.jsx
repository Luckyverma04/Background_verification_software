import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";

export default function Topbar() {
  const { user, logout } = useAuth();
  const [online, setOnline] = useState(null);

  useEffect(() => {
    const ping = () =>
      api.get("/health").then(() => setOnline(true)).catch(() => setOnline(false));
    ping();
    const t = setInterval(ping, 30000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="topbar">
      <span className="muted">Candidate verification console</span>
      <span className="row">
        <span className={`pill ${online === null ? "" : online ? "ok" : "bad"}`}>
          <i /> {online === null ? "Checking API…" : online ? "API connected" : "API offline"}
        </span>
        <Link to="/account" className="muted" title={user?.email}>{user?.name} · {user?.role === "ADMIN" ? "Admin" : "Reviewer"}</Link>
        <button className="btn small" type="button" onClick={logout}>Log out</button>
      </span>
    </header>
  );
}
