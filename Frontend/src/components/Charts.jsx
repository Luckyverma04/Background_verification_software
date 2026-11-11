import { useEffect, useRef, useState } from "react";

// Small, dependency-free SVG charts. Colours come from the --chart-* tokens
// (validated for colour-blind separation and contrast in light and dark).

const useWidth = () => {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
};

const niceMax = (v) => {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
};

// Rect with only the two top corners rounded (data end), anchored to the baseline.
const topRounded = (x, y, w, h, r) => {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
};
const rightRounded = (x, y, w, h, r) => {
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
};

export function Legend({ series }) {
  if (series.length < 2) return null;
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>
      ))}
    </div>
  );
}

/**
 * Vertical (optionally stacked) bar chart over time.
 * data:   [{ label: "9 Nov", full: "Sun, 9 Nov 2026", values: { runs: 3 } }]
 * series: [{ key: "runs", label: "Runs", color: "var(--chart-1)" }]
 */
export function BarChart({ data, series, height = 190, title }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pad = { top: 10, right: 8, bottom: 26, left: 30 };
  const w = Math.max(width, 240);
  const innerW = w - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const totals = data.map((d) => series.reduce((sum, s) => sum + (d.values[s.key] || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const ticks = [0, max / 2, max];
  const slot = innerW / Math.max(data.length, 1);
  const barW = Math.max(4, Math.min(28, slot * 0.6));
  const y = (v) => pad.top + innerH - (v / max) * innerH;
  const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor(innerW / 56)));

  return (
    <div className="chart" ref={ref}>
      <svg width={w} height={height} role="img" aria-label={title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={w - pad.right} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth="1" />
            <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" className="chart-axis">{t}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.left + slot * i + slot / 2;
          let acc = 0;
          const parts = series.map((s) => ({ s, v: d.values[s.key] || 0 })).filter((p) => p.v > 0);
          return (
            <g key={d.label + i}>
              {parts.map((p, j) => {
                const y0 = y(acc);
                acc += p.v;
                const y1 = y(acc);
                // 2px surface gap between stacked segments
                const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
                const top = j === parts.length - 1;
                return top
                  ? <path key={p.s.key} d={topRounded(cx - barW / 2, y1, barW, h, 4)} fill={p.s.color} />
                  : <rect key={p.s.key} x={cx - barW / 2} y={y1} width={barW} height={h} fill={p.s.color} />;
              })}
              {i % labelEvery === 0 && (
                <text x={cx} y={height - 8} textAnchor="middle" className="chart-axis">{d.label}</text>
              )}
              <rect
                x={pad.left + slot * i} y={pad.top} width={slot} height={innerH} fill="transparent"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0}
                aria-label={`${d.full || d.label}: ${series.map((s) => `${s.label} ${d.values[s.key] || 0}`).join(", ")}`}
              />
            </g>
          );
        })}
        {hover !== null && (
          <line x1={pad.left + slot * hover + slot / 2} x2={pad.left + slot * hover + slot / 2} y1={pad.top} y2={pad.top + innerH}
            stroke="var(--line-2)" strokeDasharray="3 3" pointerEvents="none" />
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(pad.left + slot * hover + slot / 2, 70), w - 70) }}>
          <b>{data[hover].full || data[hover].label}</b>
          {series.map((s) => (
            <div key={s.key}><i style={{ background: s.color }} />{s.label}<span>{data[hover].values[s.key] || 0}</span></div>
          ))}
        </div>
      )}
      <ChartTable title={title} columns={series} rows={data.map((d) => ({ label: d.full || d.label, values: d.values }))} />
    </div>
  );
}

/**
 * Horizontal bars, one row per item (optionally stacked).
 * rows:   [{ label: "Needs review", values: { count: 4 } }]
 */
export function HBarList({ rows, series, title, emptyText = "No data yet." }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const totals = rows.map((r) => series.reduce((sum, s) => sum + (r.values[s.key] || 0), 0));
  const max = Math.max(1, ...totals);
  const labelW = Math.min(150, Math.max(90, width * 0.32));
  const barArea = Math.max(60, width - labelW - 44);
  if (!rows.length) return <p className="muted small">{emptyText}</p>;

  return (
    <div className="chart hbars" ref={ref} role="img" aria-label={title}>
      {rows.map((r, i) => {
        let x = 0;
        const parts = series.map((s) => ({ s, v: r.values[s.key] || 0 })).filter((p) => p.v > 0);
        return (
          <div className="hbar-row" key={r.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="hbar-label" style={{ width: labelW }} title={r.label}>{r.label}</span>
            <svg width={barArea} height="18" aria-hidden="true">
              {parts.map((p, j) => {
                const w = Math.max(2, (p.v / max) * barArea - (j < parts.length - 1 ? 2 : 0));
                const el = j === parts.length - 1
                  ? <path key={p.s.key} d={rightRounded(x, 2, w, 14, 4)} fill={p.s.color} />
                  : <rect key={p.s.key} x={x} y={2} width={w} height={14} fill={p.s.color} />;
                x += w + 2;
                return el;
              })}
            </svg>
            <span className="hbar-value">{totals[i]}</span>
            {hover === i && series.length > 1 && (
              <div className="chart-tip inline">
                <b>{r.label}</b>
                {series.map((s) => (
                  <div key={s.key}><i style={{ background: s.color }} />{s.label}<span>{r.values[s.key] || 0}</span></div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <ChartTable title={title} columns={series} rows={rows} />
    </div>
  );
}

// The same numbers as a table, for screen readers.
function ChartTable({ title, columns, rows }) {
  return (
    <div className="sr-only">
    <table>
      <caption>{title}</caption>
      <thead><tr><th scope="col">Item</th>{columns.map((c) => <th scope="col" key={c.key}>{c.label}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}><th scope="row">{r.label}</th>{columns.map((c) => <td key={c.key}>{r.values[c.key] || 0}</td>)}</tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
