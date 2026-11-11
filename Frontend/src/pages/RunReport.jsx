import { Link, useParams } from "react-router-dom";
import { getRunReport } from "../api/client";
import Icon from "../components/Icon";
import useAsync from "../components/useAsync";
import { Badge, ErrorBox, Loading, fmtDate, fmtDay } from "../components/ui";

const PLATFORM = {
  LINKEDIN: "LinkedIn", GITHUB: "GitHub", TWITTER: "X / Twitter", INSTAGRAM: "Instagram", FACEBOOK: "Facebook",
  YOUTUBE: "YouTube", STACKOVERFLOW: "Stack Overflow", GITLAB: "GitLab", DEVTO: "DEV", WEBSITE: "Website",
};
const RESULT = {
  CLEAR: ["Clear", "No identity issue found in the reviewed public profiles."],
  ISSUE_FOUND: ["Issue found", "The review found a problem; see the reasons below."],
  INCONCLUSIVE: ["Inconclusive", "Not enough confirmed information to reach a result."],
};
const loc = (l) => [l?.city, l?.state, l?.country].filter(Boolean).join(", ");
const ACTION = (a) => String(a || "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

function ProfileTable({ rows, empty }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <div className="report-table-wrap">
    <table className="report-table">
      <thead>
        <tr><th>Platform</th><th>Profile</th><th className="right">Score</th><th>Reviewed by</th><th>Notes</th></tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.matchId}>
            <td>{PLATFORM[p.platform] || p.platform || "—"}</td>
            <td>
              <b>{p.name || p.username || "—"}</b>
              {[p.jobTitle, p.company].filter(Boolean).length > 0 && <div className="muted">{[p.jobTitle, p.company].filter(Boolean).join(" at ")}{loc(p.location) && ` · ${loc(p.location)}`}</div>}
              {p.profileUrl && <div className="url">{p.profileUrl}</div>}
            </td>
            <td className="right nowrap">{p.score ?? "—"}{p.matchStatus && <div className="muted small">{ACTION(p.matchStatus)}</div>}</td>
            <td className="nowrap">{p.reviewer?.name || "—"}<div className="muted small">{fmtDate(p.reviewedAt)}</div></td>
            <td>{p.notes || <span className="muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

export default function RunReport() {
  const { id } = useParams();
  const { data: r, loading, error, reload } = useAsync(() => getRunReport(id), [id]);

  if (loading) return <div className="report-page"><Loading text="Preparing report…" /></div>;
  if (error) return <div className="report-page"><ErrorBox message={error} onRetry={reload} /></div>;

  const c = r.candidate;
  const result = RESULT[r.run.finalResult];
  const reportNo = String(r.run._id).slice(-8).toUpperCase();

  return (
    <div className="report-page">
      <div className="report-toolbar no-print">
        <Link className="btn ghost" to={`/runs/${id}`}><Icon name="arrowLeft" size={15} />Back to review</Link>
        <button className="btn primary" onClick={() => window.print()}><Icon name="upload" size={15} />Print / Save as PDF</button>
      </div>

      <article className="report">
        <header className="report-head">
          <div className="brand"><span className="logo"><Icon name="shield" size={18} strokeWidth={2} /></span>BGV Automation</div>
          <div className="right">
            <div className="report-kicker">Background verification report</div>
            <div className="muted small">Report #{reportNo} · generated {fmtDate(r.generatedAt)}{r.generatedBy?.name ? ` by ${r.generatedBy.name}` : ""}</div>
          </div>
        </header>

        <section className="report-candidate">
          {c.sourceImageUrl && <img src={c.sourceImageUrl} alt="" referrerPolicy="no-referrer" onError={(e) => e.currentTarget.remove()} />}
          <div className="grow">
            <h1>{c.fullName}</h1>
            <div className="muted">{[c.currentJobTitle, c.currentCompany].filter(Boolean).join(" at ") || "—"}</div>
          </div>
          <div className={`report-result ${r.run.finalResult ? `is-${r.run.finalResult.toLowerCase()}` : ""}`}>
            <span className="muted small">Final result</span>
            <b>{result ? result[0] : "Not decided yet"}</b>
          </div>
        </section>

        <section className="report-grid">
          <div>
            <h2>Candidate details</h2>
            <dl className="report-dl">
              <dt>Email</dt><dd>{c.email || "—"}</dd>
              <dt>Phone</dt><dd>{c.phone || "—"}</dd>
              <dt>Date of birth</dt><dd>{c.dateOfBirth ? fmtDay(c.dateOfBirth) : "—"}</dd>
              <dt>Address</dt><dd>{c.address || "—"}</dd>
              <dt>Location</dt><dd>{loc(c.location) || "—"}</dd>
              {c.sheetSource?.jobId && <><dt>Job ID</dt><dd>{c.sheetSource.jobId}</dd></>}
              <dt>Education</dt><dd>{c.education?.length ? c.education.map((e) => [e.institution, e.degree].filter(Boolean).join(" – ")).join("; ") : "—"}</dd>
            </dl>
          </div>
          <div>
            <h2>Verification</h2>
            <dl className="report-dl">
              <dt>Status</dt><dd><Badge value={r.run.status} /></dd>
              <dt>Started</dt><dd>{fmtDate(r.run.startedAt || r.run.createdAt)}</dd>
              <dt>Completed</dt><dd>{r.run.completedAt ? fmtDate(r.run.completedAt) : "—"}</dd>
              <dt>Profiles found</dt><dd>{r.summary.discovered}</dd>
              <dt>Verified</dt><dd>{r.summary.verified}</dd>
              <dt>Rejected</dt><dd>{r.summary.rejected}</dd>
              <dt>Still to review</dt><dd>{r.summary.pendingRelevant}</dd>
            </dl>
          </div>
        </section>

        {(result || r.run.finalResultReasons.length > 0) && (
          <section>
            <h2>Result</h2>
            {result && <p>{result[1]}</p>}
            {r.run.finalResultReasons.length > 0 && <ul>{r.run.finalResultReasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          </section>
        )}

        <section>
          <h2>Verified profiles ({r.verifiedProfiles.length})</h2>
          <p className="muted small">Confirmed by a named reviewer as belonging to the candidate.</p>
          <ProfileTable rows={r.verifiedProfiles} empty="No profile has been verified yet." />
        </section>

        <section>
          <h2>Rejected profiles ({r.rejectedProfiles.length})</h2>
          <p className="muted small">Reviewed and judged to be a different person.</p>
          <ProfileTable rows={r.rejectedProfiles} empty="No profile was rejected." />
        </section>

        {r.timeline.length > 0 && (
          <section className="report-timeline">
            <h2>Audit trail</h2>
            <div className="report-table-wrap">
            <table className="report-table">
              <thead><tr><th>When</th><th>Event</th><th>By</th></tr></thead>
              <tbody>
                {r.timeline.map((t, i) => (
                  <tr key={i}>
                    <td className="nowrap">{fmtDate(t.at)}</td>
                    <td>{ACTION(t.action)}{t.description && <div className="muted small">{t.description}</div>}</td>
                    <td>{t.by || "System"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
        )}

        <footer className="report-foot">
          Based on publicly available web sources found by automated search. Every profile listed as verified or
          rejected was decided by the named reviewer; scores only order results for review and are not proof of identity.
        </footer>
      </article>
    </div>
  );
}
