import { Link } from "react-router-dom";
import { getRuns } from "../api/client";
import useAsync from "../components/useAsync";
import { Badge, ErrorBox, Loading, PageHeader, fmtDate } from "../components/ui";

export default function Runs() {
  const { data, loading, error, reload } = useAsync(getRuns);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  return (
    <>
      <PageHeader title="Verification runs" subtitle={`${data.length} total`} />
      <div className="card flush">
        <table>
          <thead><tr><th>Candidate</th><th>Status</th><th>Result</th><th>Results found</th><th>To review</th><th>Started</th><th /></tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r._id}>
                <td><b>{r.candidate?.fullName || "—"}</b></td>
                <td><Badge value={r.status} /></td>
                <td><Badge value={r.finalResult} /></td>
                <td>{r.totalSearchResults}</td>
                <td>{r.reviewRequired}</td>
                <td>{fmtDate(r.startedAt || r.createdAt)}</td>
                <td className="right"><Link className="btn small primary" to={`/runs/${r._id}`}>Open</Link></td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan="7" className="muted">No runs yet. Start one from the Candidates page.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
