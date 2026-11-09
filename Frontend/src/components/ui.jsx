import Icon from "./Icon";

const TONES = {
  PENDING: "gray", NOT_APPLICABLE: "gray", INPUT_REVIEW: "amber", CONFIRMED: "blue",
  SEARCHING: "blue", MATCHING: "blue", REVIEW_REQUIRED: "amber", COMPLETED: "green",
  FAILED: "red", CLEAR: "green", ISSUE_FOUND: "red", INCONCLUSIVE: "gray",
  STRONG: "green", POSSIBLE: "blue", WEAK: "gray", CONFLICT: "red",
  TARGET_REACHED: "green", TARGET_MET: "green", SHORTFALL: "amber", NOT_FOUND: "gray", NONE_RELEVANT: "gray",
  COVERED_BY_CONFIRMED_PROFILE: "blue", SKIPPED_CALL_BUDGET: "amber", SKIPPED_TIME_BUDGET: "amber", NOT_RANKED_YET: "gray",
  APPROVED: "green", REJECTED: "red", HIGH: "red", MEDIUM: "amber", LOW: "gray",
  COMPLETE: "green", SEARCHABLE: "blue", INCOMPLETE: "amber", REVIEW: "amber", QUEUED: "blue", RUNNING: "blue", DONE: "green",
  IMPORTED: "green", UPDATED: "blue", DUPLICATE: "amber", ADMIN: "violet", REVIEWER: "gray",
};

const pretty = (v) => {
  const s = String(v).replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function Badge({ value, tone, label }) {
  if (!value) return null;
  return <span className={`badge ${tone || TONES[value] || "gray"}`}><i />{label || pretty(value)}</span>;
}

export function PageHeader({ title, subtitle, eyebrow, children }) {
  return (
    <div className="page-header">
      <div className="page-title">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children && <div className="row page-actions">{children}</div>}
    </div>
  );
}

export function Loading({ text = "Loading…" }) {
  return (
    <div className="state loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {text}
    </div>
  );
}

export function ErrorBox({ message, onRetry }) {
  return (
    <div className="state error" role="alert">
      <Icon name="alert" />
      <span className="grow">{message}</span>
      {onRetry && <button className="btn small" onClick={onRetry}><Icon name="refresh" size={14} />Retry</button>}
    </div>
  );
}

export function Notice({ tone = "info", children, onClose }) {
  return (
    <div className={`state notice ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon name={tone === "error" ? "alert" : tone === "success" ? "check" : "info"} />
      <div className="grow">{children}</div>
      {onClose && <button className="icon-btn" onClick={onClose} aria-label="Dismiss"><Icon name="x" size={16} /></button>}
    </div>
  );
}

export function Empty({ icon = "inbox", title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={22} /></div>
      <b>{title}</b>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

// Initials avatar with a stable colour per name (or the photo when given)
const HUES = [250, 200, 160, 20, 330, 280, 40, 180];
export function Avatar({ name, src, size = 36 }) {
  const text = String(name || "?").trim();
  const initials = text.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  const hue = HUES[[...text].reduce((a, ch) => a + ch.charCodeAt(0), 0) % HUES.length];
  return (
    <span className="avatar" style={{ "--h": hue, width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden="true">
      {src ? <img src={src} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.remove(); }} /> : null}
      {initials}
    </span>
  );
}

export function Stat({ icon, label, value, tone = "brand", hint }) {
  return (
    <div className={`stat-card tone-${tone}`} title={hint}>
      <div className="stat-icon"><Icon name={icon} size={20} /></div>
      <div>
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
      </div>
    </div>
  );
}

export const fmtDate = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

export const fmtDay = (d) =>
  d ? new Date(d).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—";
