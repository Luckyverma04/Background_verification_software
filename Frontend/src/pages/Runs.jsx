import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getRuns } from "../api/client";
import Icon from "../components/Icon";
import useAsync from "../components/useAsync";
import { Avatar, Badge, Empty, ErrorBox, Loading, PageHeader, fmtDate } from "../components/ui";

const FILTERS = [
  ["ALL", "All"],
  ["REVIEW_REQUIRED", "Needs review"],
  ["COMPLETED", "Completed"],
  ["PENDING", "Not started"],
  ["FAILED", "Failed"],
];

export default function Runs() {
  const { data, loading, error, reload } = useAsync(getRuns);
  const [filter, setFilter] = useState("ALL");
  const rows = useMemo(() => (data || []).filter((r) => filter === "ALL" || r.status === filter), [data, filter]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  const count = (k) => (k === "ALL" ? data.length : data.filter((r) => r.status === k).length);

  return (
    <>
      <PageHeader title="Verification runs" subtitle={`${data.length} runs · each one searches the web and asks a human to confirm the results`} />
      <div className="tabs">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={`tab ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>
            {label} <small>{count(k)}</small>
          </button>
        ))}
      </div>
      <div className="card flush">
        {rows.length === 0 ? (
          <Empty icon="shield" title={data.length ? "Nothing in this view" : "No runs yet"}
            action={!data.length && <Link className="btn small primary" to="/candidates">Go to candidates</Link>}>
            {data.length ? "Try another filter." : "Start a verification from the Candidates page."}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Candidate</th><th>Status</th><th>Result</th><th className="right">Found</th><th className="right">To review</th><th>Started</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r._id}>
                    <td>
                      <div className="person">
                        <Avatar name={r.candidate?.fullName} size={34} />
                        <b>{r.candidate?.fullName || "—"}</b>
                      </div>
                    </td>
                    <td><Badge value={r.status} /></td>
                    <td>{r.finalResult ? <Badge value={r.finalResult} /> : <span className="muted">—</span>}</td>
                    <td className="right">{r.totalSearchResults ?? 0}</td>
                    <td className="right">{r.reviewRequired ? <b>{r.reviewRequired}</b> : <span className="muted">0</span>}</td>
                    <td className="muted nowrap">{fmtDate(r.startedAt || r.createdAt)}</td>
                    <td className="actions-cell"><Link className="btn small" to={`/runs/${r._id}`}>Open<Icon name="arrowRight" size={14} /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
