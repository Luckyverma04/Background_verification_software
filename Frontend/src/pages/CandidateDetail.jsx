import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createRun, errMsg, getCandidate, getRuns, updateCandidate } from "../api/client";
import useAsync from "../components/useAsync";
import { Badge, ErrorBox, Loading, PageHeader, fmtDate } from "../components/ui";

const Field = ({ label, children }) => (
  <div className="field"><span className="muted">{label}</span><div>{children || "—"}</div></div>
);
const link = (u) => u && <a href={u} target="_blank" rel="noreferrer">{u}</a>;
const FIELDS = [
  ["fullName", "Full name"], ["email", "Email"], ["phone", "Phone"], ["dateOfBirth", "Date of birth", "date"],
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
    <form className="card" onSubmit={save}>
      <h3>Edit candidate</h3>
      <p className="muted">Fill in missing details. Sheet-imported completeness is re-checked as soon as you save. Blank fields are left unchanged.</p>
      {err && <div className="state error">{err}</div>}
      {editing && <EditForm candidate={c} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 10 }}>
        {FIELDS.map(([k, label, type]) => (
          <label key={k} className="field"><span className="muted">{label}</span>
            <input type={type || "text"} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required={k === "fullName"} />
          </label>
        ))}
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button className="btn primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
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

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  const { candidate: c, runs } = data;
  const loc = [c.location?.city, c.location?.state, c.location?.country].filter(Boolean).join(", ");

  const start = async () => {
    setStarting(true); setErr("");
    try { nav(`/runs/${(await createRun(c._id))._id}`); }
    catch (e) { setErr(errMsg(e)); setStarting(false); }
  };

  return (
    <>
      <PageHeader title={c.fullName} subtitle={[c.currentJobTitle, c.currentCompany].filter(Boolean).join(" at ")}>
        <Badge value={c.verificationStatus} />
        <button className="btn" onClick={() => setEditing(true)}>Edit</button>
        <button className="btn primary" disabled={starting} onClick={start}>{starting ? "Starting…" : "Start BGV"}</button>
      </PageHeader>
      {err && <div className="state error">{err}</div>}

      <div className="two-col">
        <div className="card">
          <h3>Details</h3>
          <Field label="Email">{c.email}</Field>
          <Field label="Phone">{c.phone}</Field>
          <Field label="Date of birth">{c.dateOfBirth && String(c.dateOfBirth).slice(0, 10)}</Field>
          <Field label="Address">{c.address}</Field>
          {c.sheetSource && <Field label="Sheet source">{`${c.sheetSource.tab || ""} · row ${c.sheetSource.rowNumber || "?"} · Job ${c.sheetSource.jobId || "—"}`}</Field>}
          <Field label="Location">{loc}</Field>
          <Field label="LinkedIn">{link(c.linkedin)}</Field>
          <Field label="GitHub">{link(c.github)}</Field>
          <Field label="Twitter / X">{link(c.twitter)}</Field>
          <Field label="Instagram">{link(c.instagram)}</Field>
          <Field label="Facebook">{link(c.facebook)}</Field>
          <Field label="Website">{link(c.website)}</Field>
        </div>
        <div>
          <div className="card">
            <h3>Experience</h3>
            {c.experience?.length ? c.experience.map((x, i) => (
              <div className="item" key={i}><b>{x.jobTitle || "—"}</b> · {x.company}
                <div className="muted">{year(x.startDate)} – {x.endDate ? year(x.endDate) : "Present"}</div></div>
            )) : <p className="muted">None added.</p>}
          </div>
          <div className="card">
            <h3>Education</h3>
            {c.education?.length ? c.education.map((x, i) => (
              <div className="item" key={i}><b>{x.institution}</b>
                <div className="muted">{[x.degree, x.fieldOfStudy].filter(Boolean).join(", ")} {x.startYear || x.endYear ? `(${x.startYear || "…"}–${x.endYear || "…"})` : ""}</div></div>
            )) : <p className="muted">None added.</p>}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Verification runs</h3>
        <table>
          <thead><tr><th>Started</th><th>Status</th><th>Result</th><th /></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r._id}>
                <td>{fmtDate(r.startedAt || r.createdAt)}</td>
                <td><Badge value={r.status} /></td><td><Badge value={r.finalResult} /></td>
                <td className="right"><Link className="btn small" to={`/runs/${r._id}`}>Open</Link></td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td colSpan="4" className="muted">No runs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
