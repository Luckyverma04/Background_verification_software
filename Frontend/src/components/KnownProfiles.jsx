import { useState } from "react";
import { addProfile, errMsg, getReviewerName, setReviewerName } from "../api/client";
import { Badge, fmtDate } from "./ui";

export const PLATFORM_OPTIONS = [
  "AUTO", "LINKEDIN", "GITHUB", "TWITTER", "FACEBOOK", "INSTAGRAM", "YOUTUBE", "MEDIUM", "STACKOVERFLOW",
  "KAGGLE", "BEHANCE", "DRIBBBLE", "DEVTO", "GITLAB", "WEBSITE", "OTHER",
];

/** Compact card for a profile that is already known (no confirm buttons). */
function KnownCard({ item, tag, note, onOpen }) {
  const sr = item.searchResult || {};
  const pv = item.matchDetails?.previouslyVerified || sr.rawData?.verifiedIdentity || {};
  const manual = sr.rawData?.manual;
  return (
    <div className="card match known" id={`match-${item._id}`}>
      <div className="match-head">
        <div style={{ flex: 1 }}>
          <h3>{sr.name || sr.username || "Profile"} <Badge value={sr.platform} /> <span className="badge green">{tag}</span></h3>
          {sr.username && <div className="muted">@{sr.username}</div>}
          {sr.profileUrl && <a href={sr.profileUrl} target="_blank" rel="noreferrer">{sr.profileUrl}</a>}
          {pv.verifiedAt && (
            <div className="muted">Verified by <b>{pv.verifiedByLabel || "a reviewer"}</b> on {fmtDate(pv.verifiedAt)}{pv.method ? ` · ${String(pv.method).replace(/_/g, " ").toLowerCase()}` : ""}</div>
          )}
          {manual && <div className="muted">Added by <b>{manual.addedByLabel || "a reviewer"}</b> on {fmtDate(manual.addedAt)}{manual.notes ? ` – “${manual.notes}”` : ""}{manual.evidenceSource ? ` · source: ${manual.evidenceSource}` : ""}</div>}
          {note && <div className="muted">{note}</div>}
        </div>
        <div className="score"><Badge value={item.reviewStatus} />{onOpen && <button className="btn small" onClick={() => onOpen(item._id)}>Open</button>}</div>
      </div>
    </div>
  );
}

/** Previously verified / needs re-review / added-by-reviewer, shown apart from new results. */
export function KnownProfilesPanel({ known }) {
  if (!known) return null;
  const { previouslyVerified = [], needsReReview = [], addedByReviewer = [] } = known;
  if (!previouslyVerified.length && !needsReReview.length && !addedByReviewer.length) return null;
  return (
    <div className="known-panel">
      {needsReReview.length > 0 && (
        <>
          <h2>Needs re-review <small className="muted">(a verified profile changed)</small></h2>
          {needsReReview.map((m) => (
            <KnownCard key={m._id} item={m} tag="Changed"
              note={`Differs from what was verified: ${(m.matchDetails?.needsReReview?.reasons || []).join(", ").replace(/_/g, " ").toLowerCase() || "see details"}. Please confirm again on the cards below.`} />
          ))}
        </>
      )}
      {previouslyVerified.length > 0 && (
        <>
          <h2>Previously verified <small className="muted">({previouslyVerified.length} – not asked again; new profiles are still searched)</small></h2>
          {previouslyVerified.map((m) => <KnownCard key={m._id} item={m} tag="Previously Verified" />)}
        </>
      )}
      {addedByReviewer.length > 0 && (
        <>
          <h2>Added by reviewer <small className="muted">({addedByReviewer.length})</small></h2>
          {addedByReviewer.map((m) => (
            <KnownCard key={m._id} item={m} tag={m.reviewStatus === "APPROVED" ? "Verified" : "Needs review"} />
          ))}
        </>
      )}
    </div>
  );
}

/** "Add profile" form: works without any external search. */
export function AddProfileForm({ runId, candidateName, onClose, onAdded }) {
  const [form, setForm] = useState({ platform: "AUTO", profileUrl: "", username: "", displayName: "", notes: "", evidenceSource: "", mode: "REVIEW" });
  const [reviewer, setReviewer] = useState(getReviewerName());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [dup, setDup] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setMsg(""); setDup(null);
    if (!form.profileUrl.trim()) return setErr("Enter the profile URL.");
    if (form.mode === "VERIFIED" && !reviewer.trim()) return setErr("Enter your name – verification is recorded against a named reviewer.");
    setBusy(true);
    try {
      setReviewerName(reviewer);
      const body = {
        profileUrl: form.profileUrl.trim(), mode: form.mode,
        ...(form.platform !== "AUTO" ? { platform: form.platform } : {}),
        ...(form.username.trim() ? { username: form.username.trim() } : {}),
        ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
        ...(form.evidenceSource.trim() ? { evidenceSource: form.evidenceSource.trim() } : {}),
        ...(reviewer.trim() ? { reviewerName: reviewer.trim() } : {}),
      };
      const r = await addProfile(runId, body);
      if (!r.ok) { setDup(r); }
      else {
        setMsg(r.message || "Profile added.");
        setForm((f) => ({ ...f, profileUrl: "", username: "", displayName: "", notes: "", evidenceSource: "" }));
        onAdded?.(r);
      }
    } catch (e2) { setErr(errMsg(e2)); }
    setBusy(false);
  };

  return (
    <form className="card add-profile" onSubmit={submit}>
      <h3>Add a profile for {candidateName || "this candidate"}</h3>
      <p className="muted">Use this when you already know a profile the search did not find. It appears in the results immediately; no new web search is run.</p>
      <div className="grid-form">
        <label>Platform
          <select value={form.platform} onChange={set("platform")}>
            {PLATFORM_OPTIONS.map((p) => <option key={p} value={p}>{p === "AUTO" ? "Detect from URL" : p}</option>)}
          </select>
        </label>
        <label>Profile URL *
          <input value={form.profileUrl} onChange={set("profileUrl")} placeholder="https://www.linkedin.com/in/…" />
        </label>
        <label>Username / profile ID
          <input value={form.username} onChange={set("username")} placeholder="optional – taken from the URL if empty" />
        </label>
        <label>Display name
          <input value={form.displayName} onChange={set("displayName")} placeholder="optional" />
        </label>
        <label>Notes
          <input value={form.notes} onChange={set("notes")} placeholder="optional" />
        </label>
        <label>Source / evidence
          <input value={form.evidenceSource} onChange={set("evidenceSource")} placeholder="e.g. link on CV, HR email" />
        </label>
        <label>Your name
          <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="recorded in the audit trail" />
        </label>
      </div>
      <div className="row" style={{ margin: "8px 0" }}>
        <label><input type="radio" name="mode" checked={form.mode === "REVIEW"} onChange={() => setForm((f) => ({ ...f, mode: "REVIEW" }))} /> Save as discovered – needs review</label>
        <label><input type="radio" name="mode" checked={form.mode === "VERIFIED"} onChange={() => setForm((f) => ({ ...f, mode: "VERIFIED" }))} /> I confirm this profile belongs to the candidate (verified)</label>
      </div>
      {err && <div className="state error">{err}</div>}
      {msg && <div className="state">{msg}</div>}
      {dup && (
        <div className="state error">
          {dup.message || "This profile already exists."}
          {dup.existing?.reviewStatus && <> Status: <b>{dup.existing.reviewStatus}</b>{dup.existing.verified ? " (verified)" : ""}.</>}
          {dup.existing?.candidateMatchId && (
            <button type="button" className="btn small" onClick={() => onClose?.(dup.existing.candidateMatchId)}>Open existing</button>
          )}
        </div>
      )}
      <div className="row">
        <button className="btn primary" disabled={busy}>{busy ? "Saving…" : form.mode === "VERIFIED" ? "Add & verify" : "Add for review"}</button>
        <button type="button" className="btn" onClick={() => onClose?.()}>Close</button>
      </div>
    </form>
  );
}
