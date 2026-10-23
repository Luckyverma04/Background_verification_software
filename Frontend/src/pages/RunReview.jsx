import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { errMsg, getKnownProfiles, getPlatformMatches, getRelevantMatches, getRun, getRunPlatforms, reviewMatch, searchRun } from "../api/client";
import useAsync from "../components/useAsync";
import { Badge, ErrorBox, Loading, PageHeader } from "../components/ui";
import { AddProfileForm, KnownProfilesPanel } from "../components/KnownProfiles";

const SIGNALS = ["name", "company", "jobTitle", "location", "education", "profileUrl", "username"];
const SIGNAL_LABEL = { name: "Name", company: "Company", jobTitle: "Job title", location: "Location", education: "Education", profileUrl: "Profile URL", username: "Username" };

function MatchCard({ match, onReviewed }) {
  const sr = match.searchResult || {};
  const [notes, setNotes] = useState(match.reviewerNotes || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const loc = [sr.location?.city, sr.location?.state, sr.location?.country].filter(Boolean).join(", ");
  const why = match.rankingEvidence?.summary || match.explanation;
  const kb = sr.rawData?.knowledgeBase;
  const comp = match.rankingEvidence?.completeness;
  const enr = sr.enrichment;
  const FIELD_LABEL = { headline: "headline", company: "company", jobTitle: "job title", location: "location", education: "education", bio: "bio", previousEmployers: "previous employers", linkedProfiles: "linked profiles", username: "username", profileImage: "image" };
  const missing = (comp?.missingFields || []).map((f) => FIELD_LABEL[f] || f);
  const sources = (enr?.sources || []).filter((x) => x.ok).map((x) => x.type.replace(/_/g, " ").toLowerCase());
  const LIMIT_TEXT = { PLATFORM_RESTRICTED_NO_LOGINLESS_FETCH: "Platform needs login – only search-result data available", ONLY_SEARCH_RESULT_DATA: "No structured profile data retrieved", GITHUB_RATE_LIMITED: "GitHub rate limit – profile not enriched", GITHUB_USER_NOT_FOUND: "GitHub user not found" };
  const limits = (enr?.limitations || []).filter((l) => LIMIT_TEXT[l]).map((l) => LIMIT_TEXT[l]);
  const img = sr.profileImageUrl || sr.profileImageUrls?.[0];
  const edu = (Array.isArray(sr.education) ? sr.education : [])
    .map((e) => (typeof e === "string" ? e : [e?.institution || e?.school, e?.degree].filter(Boolean).join(" – ")))
    .filter(Boolean).join("; ");

  const decide = async (status) => {
    setSaving(true); setErr("");
    try { onReviewed(await reviewMatch(match._id, status, notes)); }
    catch (e) { setErr(errMsg(e)); }
    setSaving(false);
  };

  return (
    <div className="card match">
      <div className="match-head">
        {img && <img src={img} alt="" width="56" height="56" loading="lazy" referrerPolicy="no-referrer" style={{ borderRadius: 8, objectFit: "cover" }} onError={(e) => { e.currentTarget.style.display = "none"; }} />}
        <div style={{ flex: 1 }}>
          <h3>{sr.name || sr.username || "Unnamed profile"} <Badge value={sr.platform} /></h3>
          <div className="muted">{[sr.jobTitle, sr.company].filter(Boolean).join(" at ") || sr.headline || "—"}{loc && ` · ${loc}`}</div>
          {edu && <div className="muted">Education: {edu}</div>}
          {sr.username && <div className="muted">@{sr.username}</div>}
          {sr.bio && <div className="muted">“{sr.bio}”</div>}
          {sr.linkedProfiles?.length > 0 && (
            <div className="muted">Links: {sr.linkedProfiles.slice(0, 4).map((l, i) => <span key={l.url}>{i > 0 && " · "}<a href={l.url} target="_blank" rel="noreferrer">{l.platform || "link"}</a></span>)}</div>
          )}
          {match.matchDetails?.previouslyVerified && <div className="muted">✔ Previously verified by {match.matchDetails.previouslyVerified.verifiedByLabel || "a reviewer"} – not asked again</div>}
          {match.matchDetails?.needsReReview && <div className="muted">⚠ Differs from the verified profile ({(match.matchDetails.needsReReview.reasons || []).join(", ").replace(/_/g, " ").toLowerCase()}) – please confirm again</div>}
          {kb && !sr.rawData?.verifiedIdentity && <div className="muted">★ Previously confirmed by a reviewer in an earlier run — please verify again (not auto-approved)</div>}
          {sr.profileUrl && <a href={sr.profileUrl} target="_blank" rel="noreferrer">{sr.profileUrl}</a>}
        </div>
        <div className="score">
          <b>{Math.round(match.similarityScore ?? 0)}</b><span>similarity</span>
          <div className="row">
            <Badge value={match.matchStatus} />
            {match.reviewPriority && <Badge value={String(match.reviewPriority).toUpperCase()} />}
          </div>
        </div>
      </div>

      <div className="chips">
        {SIGNALS.map((k) => {
          const s = match.matchedSignals?.[k];
          return <span key={k} className={`chip ${s?.matched ? "yes" : ""}`}>{s?.matched ? "✓" : "–"} {SIGNAL_LABEL[k]}</span>;
        })}
      </div>

      {why && <p className="why">{why}</p>}

      {comp && (
        <div className="muted" style={{ fontSize: 12, margin: "6px 0" }}>
          <b>Information available:</b> {comp.available}/{comp.total} fields
          {sources.length > 0 && <> · source: {sources.join(", ")}</>}
          {missing.length > 0 && <> · <b>Unknown:</b> {missing.join(", ")}</>}
          {limits.length > 0 && <div>⚠ {limits.join("; ")}</div>}
          <div>A photo or a detailed profile is not proof of identity – confirm with the signals above.</div>
        </div>
      )}

      {match.conflictingSignals?.length > 0 && (
        <div className="conflicts">
          <b>Conflicts</b>
          {match.conflictingSignals.map((c, i) => (
            <div key={i}>• <b>{c.field}</b>: candidate “{c.candidateValue}” vs found “{c.searchResultValue}” {c.reason && <span className="muted">({c.reason})</span>}</div>
          ))}
        </div>
      )}

      <div className="review">
        <input placeholder="Reviewer notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <button className="btn approve" disabled={saving} onClick={() => decide("APPROVED")}>✓ Same person</button>
        <button className="btn danger" disabled={saving} onClick={() => decide("REJECTED")}>✕ Not them</button>
        <Badge value={match.reviewStatus} />
      </div>
      {err && <div className="state error">{err}</div>}
    </div>
  );
}


// Everything that is stored but NOT in the review list, with the recorded reason.
function ExcludedList({ load, deps, local, onReviewed }) {
  const [page, setPage] = useState(1);
  const res = useAsync(() => load(page), [...deps, page]);
  const d = res.data;
  const list = (d?.data || []).map((m) => ({ ...m, ...(local[m._id] || {}) }));
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox message={res.error} onRetry={res.reload} />;
  if (!list.length) return <div className="state">Nothing is hidden here.</div>;
  const pg = d.pagination || {};
  return (
    <div>
      <p className="muted">These {pg.total} profile(s) are stored but not in the review list. Each shows why; none was deleted.
        {d.excludedByReason && Object.keys(d.excludedByReason).length > 0 && <> Reasons: {Object.entries(d.excludedByReason).map(([k, v]) => `${k.replace(/_/g, " ").toLowerCase()} (${v})`).join(", ")}.</>}
      </p>
      {list.map((m) => (
        <div key={m._id}>
          <div className="muted" style={{ margin: "8px 0 -4px" }}>
            <b>Not in review list</b> · matcher: {m.matchStatus} · {(m.exclusion?.reasonText || []).join("; ") || "no reason recorded"}
          </div>
          <MatchCard match={m} onReviewed={onReviewed(m._id)} />
        </div>
      ))}
      <div className="row">
        <button className="btn" disabled={!pg.hasPreviousPage} onClick={() => setPage((x) => Math.max(x - 1, 1))}>← Previous</button>
        <span className="muted">Page {pg.page} / {pg.totalPages}</span>
        <button className="btn" disabled={!pg.hasNextPage} onClick={() => setPage((x) => x + 1)}>Next →</button>
      </div>
    </div>
  );
}

const PLATFORM_LABEL = { LINKEDIN: "LinkedIn", GITHUB: "GitHub", TWITTER: "X / Twitter", INSTAGRAM: "Instagram", FACEBOOK: "Facebook", YOUTUBE: "YouTube", MEDIUM: "Medium", STACKOVERFLOW: "Stack Overflow", QUORA: "Quora", REDDIT: "Reddit", DEVTO: "DEV", ABOUT_ME: "about.me", HUGGINGFACE: "Hugging Face", LEETCODE: "LeetCode", HACKERRANK: "HackerRank", CODECHEF: "CodeChef", CODEPEN: "CodePen", RESEARCHGATE: "ResearchGate", SCHOLAR: "Google Scholar", ORCID: "ORCID", THREADS: "Threads", PINTEREST: "Pinterest", NAUKRI: "Naukri", LINKTREE: "Linktree", GITLAB: "GitLab", BITBUCKET: "Bitbucket", HASHNODE: "Hashnode", PEERLIST: "Peerlist", KAGGLE: "Kaggle", BEHANCE: "Behance", DRIBBBLE: "Dribbble" };
const labelOf = (k) => PLATFORM_LABEL[k] || k;

function PlatformPanel({ runId, platform, summary, local, onReviewed }) {
  const matches = useAsync(() => getPlatformMatches(runId, platform), [runId, platform, summary?.relevant]);
  const knownIds = new Set([...(known.data?.previouslyVerified || []), ...(known.data?.addedByReviewer || []), ...(known.data?.needsReReview || [])].map((m) => String(m._id)));
  const list = (matches.data?.data || []).filter((m) => !knownIds.has(String(m._id))).map((m) => ({ ...m, ...(local[m._id] || {}) }));
  const s = summary || {};
  const [showHidden, setShowHidden] = useState(false);
  const c = matches.data?.counts;
  return (
    <div>
      <div className="card platform-panel">
        <div className="row"><h3>{labelOf(platform)}</h3><Badge value={s.status} /><Badge value={s.relevanceStatus} /></div>
        <div className="grid">
          <div><span className="muted">Discovered</span><b>{s.discovered ?? 0}</b></div>
          <div><span className="muted">Unique URLs</span><b>{s.uniqueUrls ?? 0}</b></div>
          <div title="URL looks like a person's profile page. This is NOT a live check."><span className="muted">Profile-shaped URLs</span><b>{s.profileShapedUrls ?? 0}/{s.target}</b></div>
          <div><span className="muted">Stored</span><b>{s.stored ?? 0}</b></div>
          <div><span className="muted">Enriched</span><b>{s.enriched ?? 0}</b></div>
          <div><span className="muted">Relevant</span><b>{s.relevant ?? "–"}/{s.target}</b></div>
        </div>
        {s.discoveryShortfall > 0 && <p className="muted">Discovery shortfall: found {s.profileShapedUrls} of {s.target} profile-shaped URLs ({s.stoppedBecause ? String(s.stoppedBecause).replace(/_/g, " ").toLowerCase() : "search finished"}).</p>}
        {s.relevanceShortfall > 0 && s.relevant !== undefined && <p className="muted">Only {s.relevant} genuinely relevant profile(s); the list is not padded with unrelated profiles.</p>}
        {s.reachability && (
          <p className="muted">Reachability (only where a real request was made): {s.reachability.reachable} reachable · {s.reachability.notFound} not found · {s.reachability.unreachable} unreachable · {s.reachability.notChecked} not checked. A profile-shaped URL is not proof that the page is live.</p>
        )}
        {s.hasConfirmedProfile && <p className="muted">A previously confirmed / supplied profile exists on this platform. It is kept; fresh discovery still ran.</p>}
        {s.retryAttempts > 0 && <p className="muted">{s.providerCalls} request(s), {s.providerAttempts} provider attempt(s) including {s.retryAttempts} retr{s.retryAttempts === 1 ? "y" : "ies"}.</p>}
        {s.invalidUrls > 0 && <p className="muted">{s.invalidUrls} URL(s) were not person profile pages (search, post, article …) and are not counted.</p>}
        {c && <p className="muted">Matching: {c.matched} matched · {c.reviewRequired} need review · {c.weak} weak · {c.rejectedConflicting} rejected/conflicting · {c.inReviewList} in this list · {c.notInList} not listed.</p>}
        {s.errors?.length > 0 && <p className="muted">⚠ {s.errors.join("; ")}</p>}
        {s.queries?.length > 0 && <details><summary className="muted">{s.queriesRun} platform-specific quer{s.queriesRun === 1 ? "y" : "ies"}</summary>{s.queries.map((q, i) => <div key={i} className="muted"><code>{q}</code></div>)}</details>}
      </div>
      {matches.loading ? <Loading /> : matches.error ? <ErrorBox message={matches.error} onRetry={matches.reload} /> :
        list.length === 0 ? <div className="state">No relevant {labelOf(platform)} profiles to review.</div> :
        list.map((m) => <MatchCard key={m._id} match={m} onReviewed={onReviewed(m._id)} />)}
      {c?.notInList > 0 && (
        <p><button className="btn" onClick={() => setShowHidden((v) => !v)}>{showHidden ? "Hide" : "Show"} {c.notInList} not-listed {labelOf(platform)} result(s) and why</button></p>
      )}
      {showHidden && <ExcludedList load={(pg) => getPlatformMatches(runId, platform, { view: "excluded", page: pg, limit: 25 })} deps={[runId, platform]} local={local} onReviewed={onReviewed} />}
    </div>
  );
}

export default function RunReview() {
  const { id } = useParams();
  const run = useAsync(() => getRun(id), [id]);
  const matches = useAsync(() => getRelevantMatches(id), [id]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [local, setLocal] = useState({}); // optimistic review updates by match id
  const platforms = useAsync(() => getRunPlatforms(id), [id]);
  const [tab, setTab] = useState("SHORTLIST");
  const known = useAsync(() => getKnownProfiles(id), [id]);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");

  if (run.loading) return <Loading />;
  if (run.error) return <ErrorBox message={run.error} onRetry={run.reload} />;
  const r = run.data;

  const runSearch = async () => {
    setRunning(true); setRunError("");
    try { await searchRun(id); setLocal({}); } catch (e) { setRunError(errMsg(e)); }
    setRunning(false);
    run.reload(); matches.reload(); platforms.reload(); known.reload();
  };

  const refreshAll = () => { run.reload(); matches.reload(); platforms.reload(); known.reload(); };
  const openMatch = (matchId) => {
    setAdding(false); setTab("SHORTLIST");
    setTimeout(() => {
      const el = document.getElementById(`match-${matchId}`);
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 2500); }
      else setNotice("That profile is listed under “Previously verified / Added by reviewer” above or in the Not listed tab.");
    }, 150);
  };

  const list = (matches.data?.data || []).map((m) => ({ ...m, ...(local[m._id] || {}) }));
  const reviewed = list.filter((m) => m.reviewStatus && m.reviewStatus !== "PENDING").length;

  return (
    <>
      <PageHeader title={`Verification: ${r.candidate?.fullName || "Candidate"}`} subtitle="Search the web, then confirm which profiles belong to this person.">
        <Badge value={r.status} />{r.finalResult && <Badge value={r.finalResult} />}
        <button className="btn primary" disabled={running || r.status === "SEARCHING"} onClick={runSearch}>
          {running ? "Searching & matching…" : r.status === "PENDING" ? "▶ Run search & match" : "↻ Re-run search"}
        </button>
        <button className="btn" onClick={() => setAdding((a) => !a)}>＋ Add profile</button>
      </PageHeader>
      {r.candidate?._id && <p><Link to={`/candidates/${r.candidate._id}`}>← Candidate profile</Link></p>}
      {adding && (
        <AddProfileForm runId={id} candidateName={r.candidate?.fullName} onAdded={refreshAll}
          onClose={(openId) => (openId ? openMatch(openId) : setAdding(false))} />
      )}
      {notice && <div className="state">{notice}</div>}
      <KnownProfilesPanel known={known.data} />
      {running && <div className="state">Searching external sources and scoring matches. This can take a minute or two…</div>}
      {runError && <div className="state error">{runError}</div>}
      {r.error?.message && <div className="state error">Last run failed: {r.error.message}</div>}

      {r.finalResult && r.finalResultReasons?.length > 0 && (
        <div className="state">
          <b>Final result: {r.finalResult}</b>
          {r.finalResultReasons.map((x, i) => <div key={i}>• {x}</div>)}
        </div>
      )}

      <div className="stats">
        <div className="card stat" title="Everything stored for this run"><span className="muted">Discovered</span><b>{matches.data?.counts?.discovered ?? r.totalSearchResults}</b></div>
        <div className="card stat" title="Name + independent evidence (STRONG / POSSIBLE)"><span className="muted">Matched</span><b>{matches.data?.counts?.matched ?? r.matchedResults}</b></div>
        <div className="card stat" title="Plausible but uncertain: a human must decide"><span className="muted">Needs review</span><b>{matches.data?.counts?.reviewRequired ?? r.reviewRequired}</b></div>
        <div className="card stat" title="Contradicting identity data (kept, not deleted)"><span className="muted">Rejected / conflicting</span><b>{matches.data?.counts?.rejectedConflicting ?? "–"}</b></div>
        <div className="card stat" title="Name-only / non-profile pages"><span className="muted">Weak</span><b>{matches.data?.counts?.weak ?? "–"}</b></div>
        <div className="card stat"><span className="muted">Reviewed (shown)</span><b>{reviewed}/{list.length}</b></div>
      </div>

      <h2>Review</h2>
      <div className="tabs">
        <button className={`tab ${tab === "SHORTLIST" ? "active" : ""}`} onClick={() => setTab("SHORTLIST")}>Shortlist (top 15)</button>
        <button className={`tab ${tab === "EXCLUDED" ? "active" : ""}`} onClick={() => setTab("EXCLUDED")} title="Stored but not in the review list, with the reason">Not listed <small>{matches.data?.counts?.notInList ?? ""}</small></button>
        {(platforms.data?.platforms || []).map((p) => (
          <button key={p.platform} className={`tab ${tab === p.platform ? "active" : ""} ${p.profileShapedUrls === 0 ? "dim" : ""}`} onClick={() => setTab(p.platform)} title={p.status}>
            {labelOf(p.platform)} <small>{p.profileShapedUrls}/{p.target}{p.relevant !== undefined ? ` · ${p.relevant} relevant` : ""}</small>
          </button>
        ))}
      </div>
      {tab === "EXCLUDED" && (
        <ExcludedList load={(pg) => getRelevantMatches(id, 50, { view: "excluded", page: pg })} deps={[id]} local={local}
          onReviewed={(mid) => (u) => setLocal((l) => ({ ...l, [mid]: { reviewStatus: u.reviewStatus, reviewerNotes: u.reviewerNotes } }))} />
      )}
      {tab !== "SHORTLIST" && tab !== "EXCLUDED" && (
        <PlatformPanel runId={id} platform={tab} summary={(platforms.data?.platforms || []).find((p) => p.platform === tab)} local={local}
          onReviewed={(mid) => (u) => setLocal((l) => ({ ...l, [mid]: { reviewStatus: u.reviewStatus, reviewerNotes: u.reviewerNotes } }))} />
      )}
      {tab === "SHORTLIST" && <h2>Shortlist for human review</h2>}
      {tab === "SHORTLIST" && matches.data?.totalBeforeCap > list.length && (
        <p className="muted">Showing the top {list.length} of {matches.data.totalBeforeCap} relevant profiles. All results remain stored.</p>
      )}
      {tab === "SHORTLIST" && (matches.loading ? <Loading /> : matches.error ? <ErrorBox message={matches.error} onRetry={matches.reload} /> :
        list.length === 0 ? <div className="state">No matches to review yet. {r.status === "PENDING" && "Click “Run search & match” above."}</div> :
        list.map((m) => (
          <MatchCard key={m._id} match={m} onReviewed={(u) => { setLocal((l) => ({ ...l, [m._id]: { reviewStatus: u.reviewStatus, reviewerNotes: u.reviewerNotes } })); known.reload(); }} />
        )))}
    </>
  );
}
