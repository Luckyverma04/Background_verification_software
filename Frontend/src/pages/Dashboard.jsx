import { Link } from "react-router-dom";
import { getCandidates, getRuns } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import Icon from "../components/Icon";
import useAsync from "../components/useAsync";
import { Avatar, Badge, Empty, ErrorBox, Loading, PageHeader, Stat, fmtDate } from "../components/ui";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

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
    </>
  );
}
