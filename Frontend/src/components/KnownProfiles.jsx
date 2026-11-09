import { useState } from "react";
import { addProfile, errMsg } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import Icon from "./Icon";
import { Avatar, Badge, Notice, fmtDate } from "./ui";

export const PLATFORM_OPTIONS = [
  "AUTO", "LINKEDIN", "GITHUB", "TWITTER", "FACEBOOK", "INSTAGRAM", "YOUTUBE", "MEDIUM", "STACKOVERFLOW",
  "KAGGLE", "BEHANCE", "DRIBBBLE", "DEVTO", "GITLAB", "WEBSITE", "OTHER",
];

const PLATFORM_NAME = { LINKEDIN: "LinkedIn", GITHUB: "GitHub", GITLAB: "GitLab", DEVTO: "DEV", STACKOVERFLOW: "Stack Overflow", YOUTUBE: "YouTube", TWITTER: "X / Twitter" };

/** Compact card for a profile that is already known (no confirm buttons). */
function KnownCard({ item, tag, note, onOpen }) {
  const sr = item.searchResult || {};
  const pv = item.matchDetails?.previouslyVerified || sr.rawData?.verifiedIdentity || {};
  const manual = sr.rawData?.manual;
  return (
    <div className="card match known" id={`match-${item._id}`}>
      <div className="match-head">
        <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap", gap: 14, flex: 1, minWidth: 0 }}>
        <Avatar name={sr.name || sr.username || "?"} size={44} />
        <div className="match-lines grow">
          <h3>{sr.name || sr.username || "Profile"} <Badge value={sr.platform} label={PLATFORM_NAME[sr.platform]} tone="violet" /> <Badge value={tag} tone="green" /></h3>
          {sr.username && <div className="muted">@{sr.username}</div>}
          {sr.profileUrl && <a href={sr.profileUrl} target="_blank" rel="noreferrer">{sr.profileUrl}</a>}
          {pv.verifiedAt && (
            <div className="muted">Verified by <b>{pv.verifiedByLabel || "a reviewer"}</b> on {fmtDate(pv.verifiedAt)}{pv.method ? ` · ${String(pv.method).replace(/_/g, " ").toLowerCase()}` : ""}</div>
          )}
          {manual && <div className="muted">Added by <b>{manual.addedByLabel || "a reviewer"}</b> on {fmtDate(manual.addedAt)}{manual.notes ? ` – “${manual.notes}”` : ""}{manual.evidenceSource ? ` · source: ${manual.evidenceSource}` : ""}</div>}
          {note && <div className="muted">{note}</div>}
        </div>
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
          <h2><Icon name="alert" size={18} />Needs re-review <small className="muted">(a verified profile changed)</small></h2>
          {needsReReview.map((m) => (
            <KnownCard key={m._id} item={m} tag="Changed"
              note={`Differs from what was verified: ${(m.matchDetails?.needsReReview?.reasons || []).join(", ").replace(/_/g, " ").toLowerCase() || "see details"}. Please confirm again on the cards below.`} />
          ))}
        </>
      )}
      {previouslyVerified.length > 0 && (
        <>
          <h2><Icon name="check" size={18} />Previously verified <small className="muted">({previouslyVerified.length} – not asked again; new profiles are still searched)</small></h2>
          {previouslyVerified.map((m) => <KnownCard key={m._id} item={m} tag="Previously Verified" />)}
        </>
      )}
      {addedByReviewer.length > 0 && (
        <>
          <h2><Icon name="userPlus" size={18} />Added by reviewer <small className="muted">({addedByReviewer.length})</small></h2>
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
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [dup, setDup] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setMsg(""); setDup(null);
    if (!form.profileUrl.trim()) return setErr("Enter the profile URL.");
    setBusy(true);
    try {
      const body = {
        profileUrl: form.profileUrl.trim(), mode: form.mode,
        ...(form.platform !== "AUTO" ? { platform: form.platform } : {}),
        ...(form.username.trim() ? { username: form.username.trim() } : {}),
        ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
        ...(form.evidenceSource.trim() ? { evidenceSource: form.evidenceSource.trim() } : {}),
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
      <div className="card-head">
        <h3><Icon name="plus" size={17} />Add a profile for {candidateName || "this candidate"}</h3>
        <button type="button" className="icon-btn" onClick={() => onClose?.()} aria-label="Close"><Icon name="x" /></button>
      </div>
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
        <label>Recorded as
          <input value={user?.name || ""} disabled title="Decisions are recorded against your login" />
        </label>
      </div>
      <div className="radio-row">
        <label className="radio-card"><input type="radio" name="mode" checked={form.mode === "REVIEW"} onChange={() => setForm((f) => ({ ...f, mode: "REVIEW" }))} /><span><b>Needs review</b><br /><span className="muted small">Save as discovered; someone confirms it later.</span></span></label>
        <label className="radio-card"><input type="radio" name="mode" checked={form.mode === "VERIFIED"} onChange={() => setForm((f) => ({ ...f, mode: "VERIFIED" }))} /><span><b>Verified</b><br /><span className="muted small">I confirm this profile belongs to the candidate.</span></span></label>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {msg && <Notice tone="success">{msg}</Notice>}
      {dup && (
        <div className="state notice error">
          <Icon name="alert" />
          {dup.message || "This profile already exists."}
          {dup.existing?.reviewStatus && <> Status: <b>{dup.existing.reviewStatus}</b>{dup.existing.verified ? " (verified)" : ""}.</>}
          {dup.existing?.candidateMatchId && (
            <button type="button" className="btn small" onClick={() => onClose?.(dup.existing.candidateMatchId)}>Open existing</button>
          )}
        </div>
      )}
      <div className="row">
        <button className="btn primary" disabled={busy}><Icon name="check" size={15} />{busy ? "Saving…" : form.mode === "VERIFIED" ? "Add & verify" : "Add for review"}</button>
        <button type="button" className="btn" onClick={() => onClose?.()}>Close</button>
      </div>
    </form>
  );
}
