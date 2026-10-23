import { NavLink } from "react-router-dom";

const links = [
  { to: "/", label: "Dashboard", icon: "▦", end: true },
  { to: "/candidates", label: "Candidates", icon: "☺" },
  { to: "/candidates/new", label: "Add Candidate", icon: "＋" },
  { to: "/sheet-import", label: "Google Sheet", icon: "⇩" },
  { to: "/runs", label: "Verification Runs", icon: "◎" },
];

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand"><span className="logo">B</span> BGV Automation</div>
      <nav>
        {links.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? "active" : "")}>
            <span className="ico">{l.icon}</span>{l.label}
          </NavLink>
        ))}
      </nav>
      <div className="side-foot">Background verification, with a human in the loop.</div>
    </aside>
  );
}
