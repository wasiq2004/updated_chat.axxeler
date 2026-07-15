// Chart primitives for the platform console.
//
// Built to fixed mark specs: 2px lines with round caps, ≥8px end markers carrying
// a 2px surface ring, bars ≤24px thick with a 4px rounded data-end squared at the
// baseline, hairline SOLID gridlines one step off the surface, and text in ink
// tokens (never the series color — identity comes from the colored mark beside it).
//
// Every chart ships a hover layer AND a table-view twin: a tooltip enhances, it
// never gates a value. Colors come from lib/vizTokens.js (validator-checked).

import { useState, useRef, useMemo, useId } from 'react';
import { Table2, LineChart as LineIcon } from 'lucide-react';
import { C, FONT, MONO } from '../../constants.js';
import { SERIES, GRID, AXIS, SURFACE, compact } from '../../lib/vizTokens.js';

/* ─── Card shell + table-view twin ──────────────────────────────────────── */

export function ChartCard({ title, subtitle, children, table, right, minHeight }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <div style={{
      background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14,
      padding: 18, display: 'flex', flexDirection: 'column', minHeight,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, letterSpacing: '-0.01em' }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: C.textSecondary, marginTop: 3 }}>{subtitle}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {right}
          {table && (
            <button
              onClick={() => setShowTable(s => !s)}
              title={showTable ? 'Show chart' : 'Show data table'}
              aria-label={showTable ? 'Show chart' : 'Show data table'}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px', borderRadius: 7,
                border: `1px solid ${C.border}`, background: 'transparent', color: C.textSecondary,
                fontSize: 11, fontWeight: 600, fontFamily: FONT, cursor: 'pointer',
              }}
            >
              {showTable ? <LineIcon size={12} /> : <Table2 size={12} />}
              {showTable ? 'Chart' : 'Table'}
            </button>
          )}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {showTable && table ? <DataTable {...table} /> : children}
      </div>
    </div>
  );
}

// The WCAG-clean equivalent of any chart — every plotted value, readable as text.
export function DataTable({ columns, rows }) {
  return (
    <div style={{ overflow: 'auto', maxHeight: 260 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.key} style={{
                textAlign: c.align || 'left', padding: '7px 10px', fontSize: 10.5, fontWeight: 800,
                color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.05em',
                borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, background: C.cardBg,
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map(c => (
                <td key={c.key} style={{
                  textAlign: c.align || 'left', padding: '7px 10px', fontSize: 12.5, color: C.text,
                  borderBottom: `1px solid ${C.border}`,
                  fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : 'normal',
                }}>{r[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Legend (identity is never color-alone) ────────────────────────────── */

function Legend({ items }) {
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
      {items.map(s => (
        <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, flexShrink: 0 }} />
          <span style={{ fontSize: 11.5, color: C.textSecondary, fontWeight: 600 }}>{s.label}</span>
        </span>
      ))}
    </div>
  );
}

/* ─── Tooltip ───────────────────────────────────────────────────────────── */

function Tooltip({ x, y, title, rows, containerW }) {
  const flip = x > containerW * 0.6;
  return (
    <div style={{
      position: 'absolute', left: x, top: y, transform: `translate(${flip ? 'calc(-100% - 12px)' : '12px'}, -50%)`,
      background: C.cardBg, border: `1px solid ${C.borderDark}`, borderRadius: 9,
      boxShadow: C.shadowMd, padding: '8px 10px', pointerEvents: 'none', zIndex: 5, minWidth: 118,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary, marginBottom: 5 }}>{title}</div>
      {rows.map(r => (
        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flexShrink: 0 }} />
          <span style={{ fontSize: 11.5, color: C.textSecondary, flex: 1 }}>{r.label}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── Line chart (trend over time) ──────────────────────────────────────── */

/**
 * props:
 *   data:   [{ [xKey]: label, ...seriesKeys }]
 *   series: [{ key, label }]  — colors assigned from SERIES in fixed order
 *   xKey, formatX
 *   area:   fill the single-series case with a ~10% wash
 */
export function LineChart({ data = [], series = [], xKey = 'day', formatX = String, height = 210, area = false }) {
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);
  const gid = useId().replace(/:/g, '');

  const W = 720, H = height;
  const PAD = { l: 44, r: 16, t: 10, b: 26 }; // b reserves the x-axis band (never clipped)
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  const withColor = series.map((s, i) => ({ ...s, color: SERIES[i % SERIES.length] }));

  const max = useMemo(() => {
    const m = Math.max(1, ...data.flatMap(d => withColor.map(s => Number(d[s.key]) || 0)));
    // Round the axis up to a clean number so ticks read 0 / 500 / 1,000.
    const pow = Math.pow(10, Math.floor(Math.log10(m)));
    return Math.ceil(m / pow) * pow;
  }, [data, series]); // eslint-disable-line react-hooks/exhaustive-deps

  if (data.length === 0) {
    return <Empty>No activity in this range.</Empty>;
  }

  const xAt = (i) => PAD.l + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const yAt = (v) => PAD.t + plotH - (Math.max(0, Number(v) || 0) / max) * plotH;

  const ticks = [0, 0.5, 1].map(f => Math.round(max * f));
  // Show at most ~6 x labels so they never collide.
  const xStep = Math.max(1, Math.ceil(data.length / 6));

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - PAD.l) / plotW) * (data.length - 1))));
    setHover(i);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Trend chart">
        <defs>
          {withColor.map(s => (
            <linearGradient key={s.key} id={`${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: s.color, stopOpacity: 0.14 }} />
              <stop offset="100%" style={{ stopColor: s.color, stopOpacity: 0 }} />
            </linearGradient>
          ))}
        </defs>

        {/* Gridlines — hairline, solid, recessive */}
        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={yAt(t)} y2={yAt(t)} style={{ stroke: GRID }} strokeWidth="1" />
            <text x={PAD.l - 8} y={yAt(t) + 3.5} textAnchor="end"
              style={{ fill: C.textMuted, fontSize: 10, fontFamily: FONT, fontVariantNumeric: 'tabular-nums' }}>
              {compact(t)}
            </text>
          </g>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH} y2={PAD.t + plotH} style={{ stroke: AXIS }} strokeWidth="1" />

        {/* x labels */}
        {data.map((d, i) => (i % xStep === 0 || i === data.length - 1) && (
          <text key={i} x={xAt(i)} y={H - 8} textAnchor="middle"
            style={{ fill: C.textMuted, fontSize: 10, fontFamily: FONT }}>{formatX(d[xKey])}</text>
        ))}

        {/* Area wash (single series only — a wash, never a saturated block) */}
        {area && withColor.length === 1 && (
          <path d={`${data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(d[withColor[0].key])}`).join(' ')} L ${xAt(data.length - 1)} ${PAD.t + plotH} L ${xAt(0)} ${PAD.t + plotH} Z`}
            fill={`url(#${gid}-${withColor[0].key})`} />
        )}

        {/* Series lines — 2px, round join/cap */}
        {withColor.map(s => (
          <path key={s.key}
            d={data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(d[s.key])}`).join(' ')}
            fill="none" style={{ stroke: s.color }} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* Crosshair + hovered dots (dot carries a 2px surface ring) */}
        {hover != null && (
          <>
            <line x1={xAt(hover)} x2={xAt(hover)} y1={PAD.t} y2={PAD.t + plotH} style={{ stroke: AXIS }} strokeWidth="1" />
            {withColor.map(s => (
              <circle key={s.key} cx={xAt(hover)} cy={yAt(data[hover][s.key])} r="4.5"
                style={{ fill: s.color, stroke: SURFACE }} strokeWidth="2" />
            ))}
          </>
        )}

        {/* End marker (≥8px) on the last point of each series */}
        {withColor.map(s => (
          <circle key={s.key} cx={xAt(data.length - 1)} cy={yAt(data[data.length - 1][s.key])} r="4"
            style={{ fill: s.color, stroke: SURFACE }} strokeWidth="2" />
        ))}
      </svg>

      {hover != null && wrapRef.current && (
        <Tooltip
          x={(xAt(hover) / W) * wrapRef.current.clientWidth}
          y={(PAD.t + plotH / 2) / H * (wrapRef.current.clientWidth * (H / W))}
          containerW={wrapRef.current.clientWidth}
          title={formatX(data[hover][xKey])}
          rows={withColor.map(s => ({ label: s.label, color: s.color, value: compact(data[hover][s.key]) }))}
        />
      )}

      {/* A legend is always present for ≥2 series; one series is named by the title */}
      {withColor.length >= 2 && <Legend items={withColor} />}
    </div>
  );
}

/* ─── Horizontal bar chart (compare magnitude) ──────────────────────────── */

// Round only the data-end; the baseline end stays square.
function barPath(x, y, w, h, r) {
  const rr = Math.min(r, w);
  if (w <= 0.5) return '';
  return `M ${x} ${y} H ${x + w - rr} Q ${x + w} ${y} ${x + w} ${y + rr} V ${y + h - rr} Q ${x + w} ${y + h} ${x + w - rr} ${y + h} H ${x} Z`;
}

// A category label must never be clipped by the chart edge. Measure-by-estimate
// against the gutter and ellipsize; the FULL value still lives in the tooltip and
// the table view, so nothing is gated by the truncation.
const CHAR_W = 6.6; // ~12px Manrope semibold
function fitLabel(text, widthPx) {
  const s = String(text ?? '');
  const max = Math.max(3, Math.floor((widthPx - 10) / CHAR_W));
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * props:
 *   data: [{ label, value, color? }] — color defaults to slot 1 (one series → one color)
 *   formatValue
 */
export function BarChart({ data = [], formatValue = compact, labelWidth = 110 }) {
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);
  if (data.length === 0) return <Empty>Nothing to show yet.</Empty>;

  const max = Math.max(1, ...data.map(d => Number(d.value) || 0));
  const ROW = 34;                     // band
  const BAR = Math.min(24, ROW - 12); // ≤24px thick — leftover band is air
  const W = 720;
  const PAD_R = 54;                   // room for the value at the tip
  const H = data.length * ROW + 4;
  const plotW = W - labelWidth - PAD_R;

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Bar chart">
        {data.map((d, i) => {
          const y = i * ROW + (ROW - BAR) / 2;
          const w = (Math.max(0, Number(d.value) || 0) / max) * plotW;
          return (
            <g key={d.label}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              style={{ cursor: 'default' }}>
              {/* Hit area spans the whole band (≫24px), not just the bar */}
              <rect x="0" y={i * ROW} width={W} height={ROW} fill="transparent">
                <title>{`${d.label}: ${formatValue(d.value)}`}</title>
              </rect>
              <text x={labelWidth - 10} y={i * ROW + ROW / 2 + 4} textAnchor="end"
                style={{ fill: C.textSecondary, fontSize: 12, fontFamily: FONT, fontWeight: 600 }}>
                {fitLabel(d.label, labelWidth)}
              </text>
              <path d={barPath(labelWidth, y, Math.max(w, 2), BAR, 4)}
                style={{ fill: d.color || SERIES[0], opacity: hover == null || hover === i ? 1 : 0.55, transition: 'opacity .15s' }} />
              {/* Value at the tip — outside the bar, so it can never be clipped */}
              <text x={labelWidth + Math.max(w, 2) + 8} y={i * ROW + ROW / 2 + 4}
                style={{ fill: C.text, fontSize: 12, fontFamily: FONT, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {formatValue(d.value)}
              </text>
            </g>
          );
        })}
      </svg>
      {/* Always available on hover — carries the FULL (untruncated) label */}
      {hover != null && wrapRef.current && (
        <Tooltip
          x={wrapRef.current.clientWidth * 0.5}
          y={(hover * ROW + ROW / 2) / H * (wrapRef.current.clientWidth * (H / W))}
          containerW={wrapRef.current.clientWidth}
          title={data[hover].label}
          rows={[{ label: data[hover].hint || 'Value', color: data[hover].color || SERIES[0], value: formatValue(data[hover].value) }]}
        />
      )}
    </div>
  );
}

/* ─── Stat tile / hero figure ───────────────────────────────────────────── */

/**
 * `tone` tints the ICON only — never the value. Status steps are deliberately
 * sub-3:1 on the light surface (mitigated for marks by an icon + label pairing),
 * so painting a number with one makes it unreadable: e.g. warning #fab219 on
 * white is 1.79:1. The value therefore always wears the primary ink token, and
 * the tinted icon beside it carries the state.
 */
export function StatTile({ label, value, delta, deltaLabel, tone, icon, hero }) {
  return (
    <div style={{
      background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14,
      padding: hero ? '18px 20px' : '15px 16px', display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {icon && <span style={{ display: 'flex', color: tone || C.textMuted }}>{icon}</span>}
        <span style={{ fontSize: 12, color: C.textSecondary, fontWeight: 600 }}>{label}</span>
      </div>
      {/* Proportional figures — tabular-nums would make a big number look loose */}
      <div style={{
        fontSize: hero ? 40 : 26, fontWeight: 800, color: C.text,
        letterSpacing: '-0.025em', lineHeight: 1.1, fontFamily: FONT,
      }}>{value}</div>
      {delta != null && (
        <div style={{ fontSize: 11.5, color: C.textMuted, fontWeight: 600 }}>
          <span style={{ color: delta > 0 ? 'var(--viz-delta-up)' : delta < 0 ? 'var(--viz-delta-down)' : C.textMuted }}>
            {delta > 0 ? '↑' : delta < 0 ? '↓' : '—'} {Math.abs(delta)}
          </span>{deltaLabel ? ` ${deltaLabel}` : ''}
        </div>
      )}
    </div>
  );
}

/* ─── Small pieces ──────────────────────────────────────────────────────── */

export function Empty({ children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120,
      color: C.textMuted, fontSize: 12.5, fontFamily: FONT, textAlign: 'center', padding: 16,
    }}>{children}</div>
  );
}

export { MONO };
