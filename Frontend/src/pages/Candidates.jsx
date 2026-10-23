import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createRun, deleteCandidate, errMsg, getCandidates } from "../api/client";
import useAsync from "../components/useAsync";
import { Badge, ErrorBox, Loading, PageHeader } from "../components/ui";

export default function Candidates() {
  const nav = useNavigate();
  const { data, loading, error, reload } = useAsync(getCandidates);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState("");

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!data) return [];
    return s
      ? data.filter((c) => [c.fullName, c.email, c.currentCompany].some((v) => v?.toLowerCase().includes(s)))
      : data;
  }, [data, q]);

  const startBgv = async (c) => {
    setBusy(c._id); setActionError("");
    try {
      const run = await createRun(c._id);
      nav(`/runs/${run._id}`);
    } catch (e) { setActionError(errMsg(e)); setBusy(null); }
  };

  const remove = async (c) => {
    if (!window.confirm(`Delete ${c.fullName}?`)) return;
    try { await deleteCandidate(c._id); reload(); } catch (e) { setActionError(errMsg(e)); }
  };

  return (
    <>
      <PageHeader title="Candidates" subtitle={data ? `${data.length} total` : ""}>
        <input className="search" placeholder="Search name, email, company…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Link className="btn primary" to="/candidates/new">+ Add candidate</Link>
      </PageHeader>

      {actionError && <div className="state error">{actionError}</div>}
      {loading ? <Loading /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
        <div className="card flush">
          <table>
            <thead><tr><th>Name</th><th>Current role</th><th>Contact</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c._id}>
                  <td><Link to={`/candidates/${c._id}`}><b>{c.fullName}</b></Link></td>
                  <td>{[c.currentJobTitle, c.currentCompany].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="muted">{c.email || c.phone || "—"}</td>
                  <td><Badge value={c.verificationStatus} /></td>
                  <td className="right nowrap">
                    <button className="btn small primary" disabled={busy === c._id} onClick={() => startBgv(c)}>
                      {busy === c._id ? "Starting…" : "Start BGV"}
                    </button>{" "}
                    <button className="btn small danger" onClick={() => remove(c)}>Delete</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan="5" className="muted">No candidates found.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
