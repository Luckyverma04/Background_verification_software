import { Link } from "react-router-dom";
import { getCandidates, getRuns } from "../api/client";
import useAsync from "../components/useAsync";
import { Badge, ErrorBox, Loading, PageHeader, fmtDate } from "../components/ui";

export default function Dashboard() {
  const { data, loading, error, reload } = useAsync(async () => {
    const [candidates, runs] = await Promise.all([getCandidates(), getRuns()]);
    return { candidates, runs };
  });

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  const { candidates, runs } = data;
  const needsReview = runs.filter((r) => r.status === "REVIEW_REQUIRED");
  const done = runs.filter((r) => r.status === "COMPLETED").length;

  const stats = [
    ["Candidates", candidates.length],
    ["Verification runs", runs.length],
    ["Awaiting review", needsReview.length],
    ["Completed", done],
  ];

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Overview of verifications">
        <Link className="btn primary" to="/candidates/new">+ Add candidate</Link>
      </PageHeader>

      <div className="stats">
        {stats.map(([label, n]) => (
          <div className="card stat" key={label}><span className="muted">{label}</span><b>{n}</b></div>
        ))}
      </div>

      <div className="card">
        <h3>Needs your review</h3>
        {needsReview.length === 0 ? (
          <p className="muted">Nothing waiting. 🎉</p>
        ) : (
          <table>
            <thead><tr><th>Candidate</th><th>Relevant matches</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {needsReview.slice(0, 8).map((r) => (
                <tr key={r._id}>
                  <td>{r.candidate?.fullName || "—"}</td>
                  <td>{r.matchedResults}</td>
                  <td>{fmtDate(r.updatedAt)}</td>
                  <td className="right"><Link className="btn small primary" to={`/runs/${r._id}`}>Review</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Recent runs</h3>
        <table>
          <thead><tr><th>Candidate</th><th>Status</th><th>Result</th><th>Started</th></tr></thead>
          <tbody>
            {runs.slice(0, 6).map((r) => (
              <tr key={r._id}>
                <td><Link to={`/runs/${r._id}`}>{r.candidate?.fullName || "—"}</Link></td>
                <td><Badge value={r.status} /></td>
                <td><Badge value={r.finalResult} /></td>
                <td>{fmtDate(r.startedAt || r.createdAt)}</td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td colSpan="4" className="muted">No runs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
