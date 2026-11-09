import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import Icon from "../components/Icon";
import { Avatar } from "../components/ui";

const SECTIONS = [
  ["/candidates/new", "Add candidate"],
  ["/candidates", "Candidates"],
  ["/runs", "Verification runs"],
  ["/sheet-import", "Google Sheet"],
  ["/users", "Users"],
  ["/account", "My account"],
];

export default function Topbar({ onMenu }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [online, setOnline] = useState(null);

  useEffect(() => {
    const ping = () =>
      api.get("/health").then(() => setOnline(true)).catch(() => setOnline(false));
    ping();
    const t = setInterval(ping, 30000);
    return () => clearInterval(t);
  }, []);

  const section = SECTIONS.find(([p]) => pathname.startsWith(p))?.[1] || "Dashboard";

  return (
    <header className="topbar">
      <div className="row">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Open menu"><Icon name="menu" /></button>
        <span className="crumb">{section}</span>
      </div>
      <div className="row">
        <span className={`pill ${online === null ? "" : online ? "ok" : "bad"}`} title="Backend API status">
          <i /> <span className="hide-sm">{online === null ? "Checking API…" : online ? "API connected" : "API offline"}</span>
        </span>
        <Link to="/account" className="row" title={user?.email} style={{ color: "inherit", textDecoration: "none" }}>
          <Avatar name={user?.name} size={30} />
          <span className="hide-sm" style={{ fontWeight: 550 }}>{user?.name}</span>
        </Link>
        <button className="btn small ghost" onClick={logout}><Icon name="logout" size={15} /><span className="hide-sm">Log out</span></button>
      </div>
    </header>
  );
}
