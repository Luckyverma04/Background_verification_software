import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createRun, errMsg, getCandidate, getRuns, updateCandidate } from "../api/client";
import Icon from "../components/Icon";
import useAsync from "../components/useAsync";
import { Avatar, Badge, Empty, ErrorBox, Loading, Notice, fmtDate, fmtDay } from "../components/ui";

const Field = ({ icon, label, children }) => (
  <div className="field">
    <span className="muted">{icon && <Icon name={icon} size={15} />}{label}</span>
    <div>{children || <span className="muted">—</span>}</div>
  </div>
);

const SOCIAL = [
  ["linkedin", "LinkedIn"], ["github", "GitHub"], ["twitter", "Twitter / X"],
  ["instagram", "Instagram"], ["facebook", "Facebook"], ["website", "Website"],
];

const FIELDS = [
  ["fullName", "Full name"], ["email", "Email", "email"], ["phone", "Phone", "tel"], ["dateOfBirth", "Date of birth", "date"],
  ["address", "Address"], ["city", "City"], ["state", "State"], ["country", "Country"],
  ["currentCompany", "Current company"], ["currentJobTitle", "Current job title"],
  ["linkedin", "LinkedIn URL"], ["facebook", "Facebook URL"], ["twitter", "Twitter / X URL"], ["instagram", "Instagram URL"],
  ["github", "GitHub URL"], ["website", "Website"], ["sourceImageUrl", "Profile image URL"],
];

const initial = (c) => ({
  ...Object.fromEntries(FIELDS.map(([k]) => [k, c[k] || ""])),
  city: c.location?.city || "", state: c.location?.state || "", country: c.location?.country || "",
  dateOfBirth: c.dateOfBirth ? String(c.dateOfBirth).slice(0, 10) : "",
});

function EditForm({ candidate, onSaved, onCancel }) {
  const [f, setF] = useState(initial(candidate));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const save = async (e) => {
    e.preventDefault(); setSaving(true); setErr("");
    const { city, state, country, ...rest } = f;
    const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => String(v).trim() !== "").map(([k, v]) => [k, String(v).trim()]));
    body.location = { city: city.trim(), state: state.trim(), country: country.trim() };
    try { await updateCandidate(candidate._id, body); onSaved(); } catch (x) { setErr(errMsg(x)); setSaving(false); }
  };

  return (
    <form className="card add-profile" onSubmit={save}>
      <div className="card-head">
        <h3><Icon name="edit" size={17} />Edit candidate</h3>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted" style={{ marginTop: -6 }}>Fill in missing details. Blank fields are left unchanged; completeness is re-checked when you save.</p>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="grid-form">
        {FIELDS.map(([k, label, type]) => (
          <label key={k}>{label}
            <input type={type || "text"} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required={k === "fullName"} />
          </label>
        ))}
      </div>
      <div className="row mt">
        <button className="btn primary" disabled={saving}><Icon name="check" size={16} />{saving ? "Saving…" : "Save changes"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const year = (d) => (d ? new Date(d).getFullYear() : "…");

export default function CandidateDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, loading, error, reload } = useAsync(async () => {
    const [candidate, runs] = await Promise.all([getCandidate(id), getRuns()]);
    return { candidate, runs: runs.filter((r) => (r.candidate?._id || r.candidate) === id) };
  }, [id]);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  const { candidate: c, runs } = data;
  const loc = [c.location?.city, c.location?.state, c.location?.country].filter(Boolean).join(", ");
  const role = [c.currentJobTitle, c.currentCompany].filter(Boolean).join(" at ");
  const socials = SOCIAL.filter(([k]) => c[k]);

  const start = async () => {
    setStarting(true); setErr("");
    try { nav(`/runs/${(await createRun(c._id))._id}`); }
    catch (e) { setErr(errMsg(e)); setStarting(false); }
  };

  return (
    <>
      <div className="eyebrow" style={{ marginBottom: 14 }}><Link to="/candidates"><Icon name="arrowLeft" size={14} /> Candidates</Link></div>

      <div className="card">
        <div className="hero">
          <Avatar name={c.fullName} src={c.sourceImageUrl} size={76} />
          <div className="grow">
            <div className="row"><h1>{c.fullName}</h1><Badge value={c.verificationStatus} /></div>
            <div className="meta">
              {role && <span><Icon name="briefcase" size={15} />{role}</span>}
              {loc && <span><Icon name="pin" size={15} />{loc}</span>}
              {c.email && <span><Icon name="mail" size={15} />{c.email}</span>}
            </div>
          </div>
          <div className="row">
            <button className="btn" onClick={() => { setEditing((v) => !v); setSaved(false); }}><Icon name="edit" size={16} />Edit</button>
            <button className="btn primary" disabled={starting} onClick={start}><Icon name="play" size={14} />{starting ? "Starting…" : "Start BGV"}</button>
          </div>
        </div>
        {socials.length > 0 && (
          <>
            <hr className="divider" />
            <div className="social-links">
              {socials.map(([k, label]) => (
                <a key={k} href={c[k]} target="_blank" rel="noreferrer"><Icon name={k === "website" ? "globe" : "link"} size={14} />{label}</a>
              ))}
            </div>
          </>
        )}
      </div>

      {err && <Notice tone="error" onClose={() => setErr("")}>{err}</Notice>}
      {saved && <Notice tone="success" onClose={() => setSaved(false)}>Candidate updated.</Notice>}
      {editing && <EditForm candidate={c} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); setSaved(true); reload(); }} />}

      <div className="two-col">
        <div className="card">
          <h3>Personal details</h3>
          <Field icon="mail" label="Email">{c.email}</Field>
          <Field icon="phone" label="Phone">{c.phone}</Field>
          <Field icon="calendar" label="Date of birth">{c.dateOfBirth && fmtDay(c.dateOfBirth)}</Field>
          <Field icon="pin" label="Address">{c.address}</Field>
          <Field icon="globe" label="Location">{loc}</Field>
          {c.sheetSource && <Field icon="sheet" label="Sheet source">{`${c.sheetSource.tab || ""} · row ${c.sheetSource.rowNumber || "?"} · Job ${c.sheetSource.jobId || "—"}`}</Field>}
        </div>
        <div>
          <div className="card">
            <h3>Experience</h3>
            {c.experience?.length ? (
              <div className="timeline">
                {c.experience.map((x, i) => (
                  <div className="item" key={i}>
                    <span className="dot"><Icon name="briefcase" size={16} /></span>
                    <div><b>{x.jobTitle || "—"}</b>{x.company && <> · {x.company}</>}
                      <div className="muted small">{year(x.startDate)} – {x.endDate ? year(x.endDate) : "Present"}</div></div>
                  </div>
                ))}
              </div>
            ) : <p className="muted">No experience added.</p>}
          </div>
          <div className="card">
            <h3>Education</h3>
            {c.education?.length ? (
              <div className="timeline">
                {c.education.map((x, i) => (
                  <div className="item" key={i}>
                    <span className="dot"><Icon name="graduation" size={16} /></span>
                    <div><b>{x.institution || "—"}</b>
                      <div className="muted small">{[x.degree, x.fieldOfStudy].filter(Boolean).join(", ")} {x.startYear || x.endYear ? `(${x.startYear || "…"}–${x.endYear || "…"})` : ""}</div></div>
                  </div>
                ))}
              </div>
            ) : <p className="muted">No education added.</p>}
          </div>
        </div>
      </div>

      <div className="card flush">
        <div className="card-head"><h3><Icon name="shield" size={17} />Verification runs</h3></div>
        {runs.length === 0 ? (
          <Empty icon="shield" title="Not verified yet" action={<button className="btn small primary" onClick={start} disabled={starting}>Start BGV</button>}>
            Start a verification to search for this person's public profiles.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Started</th><th>Status</th><th>Result</th><th /></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r._id}>
                    <td>{fmtDate(r.startedAt || r.createdAt)}</td>
                    <td><Badge value={r.status} /></td>
                    <td>{r.finalResult ? <Badge value={r.finalResult} /> : <span className="muted">—</span>}</td>
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
