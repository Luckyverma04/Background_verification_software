import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createRun, deleteCandidate, errMsg, getCandidates } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import Icon from "../components/Icon";
import useAsync from "../components/useAsync";
import { Avatar, Badge, Empty, ErrorBox, Loading, Notice, PageHeader } from "../components/ui";

export default function Candidates() {
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const { data, loading, error, reload } = useAsync(getCandidates);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState("");

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!data) return [];
    return s
      ? data.filter((c) => [c.fullName, c.email, c.currentCompany, c.currentJobTitle].some((v) => v?.toLowerCase().includes(s)))
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
    if (!window.confirm(`Delete ${c.fullName}? This cannot be undone.`)) return;
    try { await deleteCandidate(c._id); reload(); } catch (e) { setActionError(errMsg(e)); }
  };

  return (
    <>
      <PageHeader title="Candidates" subtitle={data ? `${data.length} people in your workspace` : "People you are verifying"}>
        <Link className="btn primary" to="/candidates/new"><Icon name="plus" size={16} />Add candidate</Link>
      </PageHeader>

      {actionError && <Notice tone="error" onClose={() => setActionError("")}>{actionError}</Notice>}
      {loading ? <Loading /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
        <div className="card flush">
          <div className="toolbar">
            <div className="search">
              <Icon name="search" size={16} />
              <input placeholder="Search name, email, company…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search candidates" />
            </div>
            {q && <span className="muted small">{rows.length} result{rows.length === 1 ? "" : "s"}</span>}
          </div>
          {rows.length === 0 ? (
            q ? <Empty icon="search" title="No match">Nobody matches “{q}”.</Empty> : (
              <Empty icon="users" title="No candidates yet" action={<Link className="btn small primary" to="/candidates/new">Add the first one</Link>}>
                Add a candidate manually or import them from your Google Sheet.
              </Empty>
            )
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Candidate</th><th className="hide-sm">Current role</th><th className="hide-sm">Status</th><th /></tr></thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c._id}>
                      <td>
                        <div className="person">
                          <Avatar name={c.fullName} src={c.sourceImageUrl} size={38} />
                          <div className="stack" style={{ gap: 0, minWidth: 0 }}>
                            <Link to={`/candidates/${c._id}`}><b>{c.fullName}</b></Link>
                            <span className="sub">{c.email || c.phone || "No contact details"}</span>
                          </div>
                        </div>
                      </td>
                      <td className="hide-sm">{[c.currentJobTitle, c.currentCompany].filter(Boolean).join(" · ") || <span className="muted">—</span>}</td>
                      <td className="hide-sm"><Badge value={c.verificationStatus} /></td>
                      <td className="actions-cell">
                        <button className="btn small primary" disabled={busy === c._id} onClick={() => startBgv(c)} title="Start background verification">
                          <Icon name="play" size={13} /><span className="hide-sm">{busy === c._id ? "Starting…" : "Start BGV"}</span>
                        </button>
                        {isAdmin && (
                          <button className="btn small danger" onClick={() => remove(c)} title="Delete candidate" aria-label={`Delete ${c.fullName}`}>
                            <Icon name="trash" size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
