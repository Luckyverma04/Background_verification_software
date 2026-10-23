const TONES = {
  PENDING: "gray", NOT_APPLICABLE: "gray", INPUT_REVIEW: "amber", CONFIRMED: "blue",
  SEARCHING: "blue", MATCHING: "blue", REVIEW_REQUIRED: "amber", COMPLETED: "green",
  FAILED: "red", CLEAR: "green", ISSUE_FOUND: "red", INCONCLUSIVE: "gray",
  STRONG: "green", POSSIBLE: "blue", WEAK: "gray", CONFLICT: "red",
  TARGET_REACHED: "green", TARGET_MET: "green", SHORTFALL: "amber", NOT_FOUND: "gray", NONE_RELEVANT: "gray",
  COVERED_BY_CONFIRMED_PROFILE: "blue", SKIPPED_CALL_BUDGET: "amber", SKIPPED_TIME_BUDGET: "amber", NOT_RANKED_YET: "gray",
  APPROVED: "green", REJECTED: "red", HIGH: "red", MEDIUM: "amber", LOW: "gray",
};

export function Badge({ value }) {
  if (!value) return null;
  return <span className={`badge ${TONES[value] || "gray"}`}>{String(value).replace(/_/g, " ")}</span>;
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      <div className="row">{children}</div>
    </div>
  );
}

export function Loading({ text = "Loading..." }) {
  return <div className="state">{text}</div>;
}

export function ErrorBox({ message, onRetry }) {
  return (
    <div className="state error">
      {message}
      {onRetry && <button className="btn small" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export const fmtDate = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
