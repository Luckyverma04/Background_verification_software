import { Link } from "react-router-dom";
import { useState } from "react";
import { getCandidates, getRuns, getStats } from "../api/client";
import { BarChart, HBarList, Legend } from "../components/Charts";
import { useAuth } from "../auth/AuthContext";
import Icon from "../components/Icon";
import useAsync from "../components/useAsync";
import { Avatar, Badge, Empty, ErrorBox, Loading, PageHeader, Stat, fmtDate } from "../components/ui";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

const STATUS_LABEL = {
  PENDING: "Not started", SEARCHING: "Searching", MATCHING: "Matching", REVIEW_REQUIRED: "Needs review",
  COMPLETED: "Completed", FAILED: "Failed", INPUT_REVIEW: "Input review", CONFIRMED: "Confirmed",
};
const RESULT_LABEL = { CLEAR: "Clear", ISSUE_FOUND: "Issue found", INCONCLUSIVE: "Inconclusive", NONE: "No result yet" };
const DECISIONS = [
  { key: "approved", label: "Same person", color: "var(--chart-ok)" },
  { key: "rejected", label: "Not them", color: "var(--chart-bad)" },
];
const RUNS = [{ key: "runs", label: "Runs started", color: "var(--chart-1)" }];
const COUNT = [{ key: "count", label: "Runs", color: "var(--chart-1)" }];

const dayLabels = (day) => {
  const d = new Date(`${day}T12:00:00`);
  return {
    label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    full: d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
  };
};

function Activity() {
  const [days, setDays] = useState(14);
  const { data, loading, error, reload } = useAsync(() => getStats(days), [days]);

  const daily = (data?.daily || []).map((d) => ({ ...dayLabels(d.day), values: d }));
  const statusRows = Object.entries(data?.runsByStatus || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: STATUS_LABEL[k] || k, values: { count: v } }));
  const resultRows = Object.entries(data?.runsByResult || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: RESULT_LABEL[k] || k, values: { count: v } }));
  const reviewerRows = (data?.reviewers || []).slice(0, 8).map((r) => ({ label: r.name, values: r }));
  const totalDecisions = daily.reduce((n, d) => n + d.values.approved + d.values.rejected, 0);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", margin: "28px 0 12px" }}>
        <h2 style={{ margin: 0 }}><Icon name="list" size={18} />Activity</h2>
        <div className="segmented" role="group" aria-label="Time range">
          {[14, 30, 90].map((n) => (
            <button key={n} className={days === n ? "on" : ""} onClick={() => setDays(n)} aria-pressed={days === n}>{n} days</button>
          ))}
        </div>
      </div>
      {loading && !data ? <Loading /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
        <>
          <div className="chart-grid">
            <div className="card">
              <div className="card-head"><h3>Runs started</h3><span className="muted small">{daily.reduce((n, d) => n + d.values.runs, 0)} in {days} days</span></div>
              <BarChart data={daily} series={RUNS} title={`Runs started per day, last ${days} days`} />
            </div>
            <div className="card">
              <div className="card-head"><h3>Review decisions</h3><Legend series={DECISIONS} /></div>
              {totalDecisions === 0
                ? <Empty icon="check" title="No decisions yet">Approvals and rejections from the review page appear here.</Empty>
                : <BarChart data={daily} series={DECISIONS} title={`Review decisions per day, last ${days} days`} />}
            </div>
          </div>
          <div className="chart-grid">
            <div className="card">
              <div className="card-head"><h3>Runs by status</h3><span className="muted small">all time</span></div>
              <HBarList rows={statusRows} series={COUNT} title="Runs by status" />
              <hr className="divider" />
              <div className="card-head" style={{ marginBottom: 10 }}><h3>Final results</h3></div>
              <HBarList rows={resultRows} series={COUNT} title="Runs by final result" />
            </div>
            <div className="card">
              <div className="card-head"><h3>Reviewer activity</h3><Legend series={DECISIONS} /></div>
              <HBarList rows={reviewerRows} series={DECISIONS} title={`Decisions per reviewer, last ${days} days`}
                emptyText={`No review decisions in the last ${days} days.`} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useAsync(async () => {
    const [candidates, runs] = await Promise.all([getCandidates(), getRuns()]);
    return { candidates, runs };
  });

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  const { candidates, runs } = data;
  const needsReview = runs.filter((r) => r.status === "REVIEW_REQUIRED");
  const done = runs.filter((r) => r.status === "COMPLETED").length;
  const firstName = String(user?.name || "").split(" ")[0];

  return (
    <>
      <PageHeader title={`${greeting()}${firstName ? `, ${firstName}` : ""}`} subtitle="Here is where your verifications stand today.">
        <Link className="btn" to="/runs"><Icon name="shield" size={16} />All runs</Link>
        <Link className="btn primary" to="/candidates/new"><Icon name="plus" size={16} />Add candidate</Link>
      </PageHeader>

      <div className="stats">
        <Stat icon="users" label="Candidates" value={candidates.length} tone="brand" />
        <Stat icon="shield" label="Verification runs" value={runs.length} tone="blue" />
        <Stat icon="clock" label="Awaiting review" value={needsReview.length} tone="amber" />
        <Stat icon="check" label="Completed" value={done} tone="green" />
      </div>

      <div className="two-col">
        <div className="card flush">
          <div className="card-head">
            <h3><Icon name="clock" size={17} />Needs your review</h3>
            {needsReview.length > 0 && <Badge value={`${needsReview.length} waiting`} tone="amber" />}
          </div>
          {needsReview.length === 0 ? (
            <Empty icon="check" title="All caught up">No verification is waiting for a decision.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {needsReview.slice(0, 8).map((r) => (
                    <tr key={r._id}>
                      <td>
                        <div className="person">
                          <Avatar name={r.candidate?.fullName} size={34} />
                          <div className="stack" style={{ gap: 0 }}>
                            <b>{r.candidate?.fullName || "—"}</b>
                            <span className="sub">{r.matchedResults ?? 0} relevant matches · {fmtDate(r.updatedAt)}</span>
                          </div>
                        </div>
                      </td>
                      <td className="actions-cell"><Link className="btn small primary" to={`/runs/${r._id}`}>Review<Icon name="arrowRight" size={14} /></Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card flush">
          <div className="card-head">
            <h3><Icon name="list" size={17} />Recent runs</h3>
            <Link to="/runs" className="small">View all</Link>
          </div>
          {runs.length === 0 ? (
            <Empty icon="shield" title="No runs yet" action={<Link className="btn small primary" to="/candidates">Start from Candidates</Link>}>
              Start a verification from a candidate's page.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {runs.slice(0, 6).map((r) => (
                    <tr key={r._id}>
                      <td>
                        <div className="person">
                          <Avatar name={r.candidate?.fullName} size={34} />
                          <div className="stack" style={{ gap: 0 }}>
                            <Link to={`/runs/${r._id}`}><b>{r.candidate?.fullName || "—"}</b></Link>
                            <span className="sub">{fmtDate(r.startedAt || r.createdAt)}</span>
                          </div>
                        </div>
                      </td>
                      <td className="actions-cell"><Badge value={r.finalResult || r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <Activity />
    </>
  );
}
