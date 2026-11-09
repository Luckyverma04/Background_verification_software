import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  cancelSheetQueue, confirmSheetCandidates, errMsg, getSheetItems, getSheetStatus,
  retrySheetFailed, startSheetQueue, syncSheet, unconfirmSheetCandidates,
} from "../api/client";
import Icon from "../components/Icon";
import { Avatar, Badge, Empty, ErrorBox, Loading, Notice, PageHeader, Stat, fmtDate } from "../components/ui";

const LEVEL = { COMPLETE: "Complete", SEARCHABLE: "Searchable (some details missing)", INCOMPLETE: "Incomplete" };
const QUEUE = { REVIEW: "Waiting for review", QUEUED: "In queue", RUNNING: "Searching now…", DONE: "Search done", FAILED: "Search failed" };

export default function SheetImport() {
  const [status, setStatus] = useState(null);
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [sel, setSel] = useState(new Set());

  const load = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([getSheetStatus(), getSheetItems()]);
      setStatus(s); setItems(i); setError("");
    } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const active = (items || []).some((i) => ["QUEUED", "RUNNING"].includes(i.queueStatus));
  useEffect(() => {
    if (!active && !status?.syncing) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [active, status?.syncing, load]);

  const act = async (name, fn) => {
    setBusy(name); setNotice(""); setError("");
    try { await fn(); await load(); } catch (e) { setError(errMsg(e)); }
    setBusy("");
  };

  const reviewable = useMemo(() => (items || []).filter((i) => i.candidateId && i.queueStatus === "REVIEW"), [items]);
  const chosen = useMemo(() => (items || []).filter((i) => sel.has(i.candidateId)), [items, sel]);
  const chosenReview = chosen.filter((i) => i.queueStatus === "REVIEW");
  const chosenIncomplete = chosenReview.filter((i) => i.completeness?.level === "INCOMPLETE" || i.completeness?.invalid?.length);
  const readyConfirmed = (items || []).filter((i) => i.queueStatus === "REVIEW" && i.confirmed);
  const failed = (items || []).filter((i) => i.queueStatus === "FAILED");
  const queued = (items || []).filter((i) => i.queueStatus === "QUEUED");

  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAllReview = () => setSel(new Set(reviewable.map((i) => i.candidateId)));

  const doSync = () => act("sync", async () => {
    const r = await syncSheet();
    const skipped = r.skipped?.length ? `, ${r.skipped.length} row(s) skipped (${r.skipped.slice(0, 3).map((x) => `row ${x.row}: ${x.reason}`).join("; ")})` : "";
    setNotice(`Synced: ${r.imported} new, ${r.updated} updated, ${r.alreadyImported} already imported, ${r.linkedExisting} matched existing${skipped}. Nothing was searched.`);
  });

  const confirm = (acknowledge) => act("confirm", async () => {
    const ids = [...sel];
    const r = await confirmSheetCandidates(ids, acknowledge);
    setNotice(`${r.confirmed.length} confirmed.${r.needsAcknowledgement.length ? ` ${r.needsAcknowledgement.length} incomplete/invalid not confirmed — use "Search with incomplete data" if you really want them.` : ""}`);
  });

  const confirmIncomplete = () => {
    const names = chosenIncomplete.map((i) => i.name).join(", ");
    if (!window.confirm(`Search with incomplete data?\n\n${names}\n\nThese candidates have missing or invalid details. Results may be weaker or less certain. Continue?`)) return;
    confirm(true);
  };

  const start = () => {
    if (!window.confirm(`Start the sequential search for ${readyConfirmed.length} confirmed candidate(s)? They are searched one at a time and this uses your search providers.`)) return;
    act("start", async () => {
      const r = await startSheetQueue();
      setNotice(`${r.queued} candidate(s) queued. They are searched one at a time.`);
    });
  };

  if (!status && !error) return <Loading />;
  const q = status?.queue;
  const doneCount = q ? q.done : 0;

  return (
    <>
      <PageHeader title="Google Sheet" subtitle="Rows are imported automatically; nothing is searched until you confirm.">
        <button className="btn primary" onClick={doSync} disabled={busy === "sync" || !status?.configured}><Icon name="refresh" size={15} />{busy === "sync" ? "Syncing…" : "Sync now"}</button>
      </PageHeader>

      {error && <ErrorBox message={error} onRetry={load} />}
      {notice && <Notice tone="success" onClose={() => setNotice("")}>{notice}</Notice>}

      {status && (
        <div className="card">
          <div className="card-head">
            <h3><Icon name="sheet" size={17} />Connection</h3>
            <span className={`pill ${status.configured ? "ok" : "bad"}`}><i />{status.configured ? "Connected" : "Not connected"}</span>
          </div>
          {!status.configured ? (
            <Notice tone="error">Not connected: {status.problem}. See the setup steps in the README / .env.example.</Notice>
          ) : (
            <>
              <div>Tab <b>{status.tab || "(first tab)"}</b> · checked every {status.pollingMinutes > 0 ? `${status.pollingMinutes} min` : "— (manual only)"} (polling, not instant)</div>
              <div className="muted">Last successful sync: {status.lastSuccessAt ? fmtDate(status.lastSuccessAt) : "never"} · Searching is {status.searchEnabled ? "enabled" : "DISABLED"} · one-by-one, {Math.round(status.queueDelayMs / 100) / 10}s between candidates</div>
              {status.lastError && <div className="mt"><Notice tone="error">Last sync problem: {status.lastError}</Notice></div>}
            </>
          )}
        </div>
      )}

      {q && q.review > 0 && (
        <Notice tone="warn">Candidate data imported. Please review completeness before starting searches.</Notice>
      )}

      {q && q.total > 0 && (
        <div className="card">
          <div className="card-head"><h3><Icon name="list" size={17} />Search queue</h3></div>
          <div className="stats" style={{ marginBottom: 14 }}>
            <Stat icon="eye" tone="amber" label={`To review (${q.reviewConfirmed} confirmed)`} value={q.review} />
            <Stat icon="clock" tone="blue" label="Waiting / running" value={`${q.queued} / ${q.running}`} />
            <Stat icon="check" tone="green" label="Done" value={doneCount} />
            <Stat icon="alert" tone="red" label="Failed" value={q.failed} />
          </div>
          {q.current?.length > 0 && <p className="row"><span className="spinner" />Now searching: <b>{q.current.map((c) => c.name).join(", ")}</b>{queued.length ? ` · ${queued.length} waiting after it` : ""}</p>}
          <progress max={q.total || 1} value={doneCount} aria-label="Queue progress" />
          <div className="row mt">
            <button className="btn primary" disabled={!readyConfirmed.length || !status?.searchEnabled || busy === "start"} onClick={start}>
              <Icon name="play" size={14} />Start sequential search ({readyConfirmed.length})
            </button>
            {failed.length > 0 && <button className="btn" disabled={busy === "retry"} onClick={() => act("retry", async () => { const r = await retrySheetFailed(); setNotice(`${r.retried} re-queued.`); })}>Retry failed ({failed.length})</button>}
            {queued.length > 0 && <button className="btn" onClick={() => act("cancel", async () => { const r = await cancelSheetQueue(); setNotice(`${r.cancelled} taken out of the queue.`); })}>Cancel waiting ({queued.length})</button>}
          </div>
        </div>
      )}

      <div className="card flush">
        <div className="toolbar">
          <button className="btn small" onClick={selectAllReview}>Select all awaiting review</button>
          <button className="btn small" onClick={() => setSel(new Set())}>Clear</button>
          <span className="muted small">{chosen.length} selected</span>
          <span className="grow" />
          <button className="btn small primary" disabled={!chosenReview.length || busy === "confirm"} onClick={() => confirm(false)}><Icon name="check" size={14} />Confirm data is complete</button>
          <button className="btn small" disabled={!chosenIncomplete.length || busy === "confirm"} onClick={confirmIncomplete}>Search with incomplete data…</button>
          <button className="btn small" disabled={!chosenReview.length} onClick={() => act("unconfirm", async () => { await unconfirmSheetCandidates([...sel]); })}>Un-confirm</button>
        </div>
        {!items ? <Loading /> : items.length === 0 ? (
          <Empty icon="sheet" title="No rows imported yet">Press “Sync now” to pull candidates from your Google Sheet.</Empty>
        ) : (
          <div className="table-wrap">
          <table>
            <thead><tr><th /><th>Row / Job</th><th>Candidate</th><th>Import</th><th>Completeness</th><th>Missing / invalid</th><th>Search</th><th /></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td><input type="checkbox" disabled={i.queueStatus !== "REVIEW" || !i.candidateId} checked={sel.has(i.candidateId)} onChange={() => toggle(i.candidateId)} /></td>
                  <td>#{i.rowNumber}<div className="muted">{i.jobId || "—"}</div></td>
                  <td>
                    <div className="person">
                      <Avatar name={i.name} size={32} />
                      <div className="stack" style={{ gap: 0 }}>
                        {i.candidateId ? <Link to={`/candidates/${i.candidateId}`}><b>{i.name}</b></Link> : <b>{i.name || "—"}</b>}
                        <span className="sub">{i.email}</span>
                      </div>
                    </div>
                  </td>
                  <td><Badge value={i.importStatus} />{i.duplicateReason && <div className="muted">{i.duplicateReason}</div>}{i.sourceDuplicateStatus && <div className="muted">sheet: {i.sourceDuplicateStatus}</div>}</td>
                  <td>{i.completeness ? <span title={LEVEL[i.completeness.level]}><Badge value={i.completeness.level} /></span> : "—"}</td>
                  <td style={{ maxWidth: 280 }} className="small">
                    {i.completeness?.missing?.length > 0 && <div>Missing: {i.completeness.missing.join(", ")}</div>}
                    {i.completeness?.invalid?.length > 0 && <div className="muted">Invalid: {i.completeness.invalid.map((x) => `${x.field} (${x.reason})`).join("; ")}</div>}
                    {i.completeness?.identifiers?.length > 0 && <div className="muted">Can search by: {i.completeness.identifiers.join(", ")}</div>}
                    {i.candidateId && <Link className="btn small mt" to={`/candidates/${i.candidateId}`}><Icon name="edit" size={13} />Edit details</Link>}
                  </td>
                  <td>
                    <Badge value={i.queueStatus} />
                    <div className="muted small">{QUEUE[i.queueStatus]}{i.queuePosition ? ` · #${i.queuePosition}` : ""}{i.confirmed && i.queueStatus === "REVIEW" ? " · confirmed" : ""}{i.incompleteOverride ? " · incomplete override" : ""}</div>
                    {i.error && <div className="small" style={{ color: "var(--red)" }}>{i.error}</div>}
                  </td>
                  <td className="actions-cell">{i.bgvRun && <Link className="btn small" to={`/runs/${i.bgvRun}`}>Results<Icon name="arrowRight" size={13} /></Link>}</td>
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
