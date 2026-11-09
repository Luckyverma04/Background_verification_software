import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import Icon from "../components/Icon";
import { Avatar } from "../components/ui";

const links = [
  { to: "/", label: "Dashboard", icon: "dashboard", end: true },
  { to: "/candidates", label: "Candidates", icon: "users", end: true },
  { to: "/candidates/new", label: "Add candidate", icon: "userPlus" },
  { to: "/runs", label: "Verification runs", icon: "shield" },
  { to: "/sheet-import", label: "Google Sheet", icon: "sheet" },
];

export default function Sidebar({ onNavigate }) {
  const { user, logout } = useAuth();
  const items = user?.role === "ADMIN" ? [...links, { to: "/users", label: "Users", icon: "settings" }] : links;

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo"><Icon name="shield" size={19} strokeWidth={2} /></span>
        <div>BGV Automation<small>Verification console</small></div>
      </div>
      <div className="nav-label">Workspace</div>
      <nav>
        {items.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} onClick={onNavigate} className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name={l.icon} />{l.label}
          </NavLink>
        ))}
      </nav>
      {user && (
        <div className="side-user">
          <NavLink to="/account" onClick={onNavigate} title="My account"><Avatar name={user.name} size={34} /></NavLink>
          <div className="who">
            <b>{user.name}</b>
            <span>{user.role === "ADMIN" ? "Admin" : "Reviewer"}</span>
          </div>
          <button className="icon-btn" onClick={logout} title="Log out" aria-label="Log out"><Icon name="logout" /></button>
        </div>
      )}
    </aside>
  );
}
