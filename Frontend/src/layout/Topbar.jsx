import { useEffect, useState } from "react";
import { api } from "../api/client";

export default function Topbar() {
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
      <span className={`pill ${online === null ? "" : online ? "ok" : "bad"}`}>
        <i /> {online === null ? "Checking API…" : online ? "API connected" : "API offline"}
      </span>
    </header>
  );
}
