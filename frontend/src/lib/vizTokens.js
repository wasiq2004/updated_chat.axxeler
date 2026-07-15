// Data-visualisation tokens for the platform console.
//
// These values are NOT hand-picked — every slot was produced by snapping the Zen
// brand hues to steps that pass the palette validator against this app's REAL
// chart surface (light #FFFFFF, dark #111923), then verified by running the
// checks per mode. Results (OKLab ×100 ΔE):
//
//   Categorical [#1183B4, #7C3AED, #C2410C]
//     light: band PASS · chroma PASS · CVD worst adjacent 11.7 (≥8) · normal 21.3 (≥15) · contrast ≥3:1 PASS
//     dark : band PASS · chroma PASS · CVD worst adjacent 11.7 (≥8) · normal 21.3 (≥15) · contrast ≥3:1 PASS
//   Ordinal (plan tiers — ordered, so one hue with monotone lightness)
//     light [#45AEDE→#08425C]: monotone PASS · ΔL PASS · light-end 2.51:1 PASS · single hue PASS
//     dark  [#A9DEF5→#12719C]: monotone PASS · ΔL PASS · light-end 3.26:1 PASS · single hue PASS
//
// The dark steps are a SELECTED set validated against the dark surface — not the
// light palette brightened (naive brightening fails the lightness band + CVD).
// If you change any value here, re-run the validator for BOTH modes.
//
// Status colors are the reserved fixed scale — never used for a data series, and
// always shipped with an icon + label so state never rides on color alone.

// Injected once per console view. Dark values are declared under the app's
// [data-theme="dark"] scope (the app stamps data-theme on <html>).
export const VIZ_CSS = `
.viz-root {
  --viz-s1: #1183B4;
  --viz-s2: #7C3AED;
  --viz-s3: #C2410C;
  --viz-o1: #45AEDE;
  --viz-o2: #1183B4;
  --viz-o3: #0C6187;
  --viz-o4: #08425C;
  --viz-good: #0ca30c;
  --viz-warning: #fab219;
  --viz-serious: #ec835a;
  --viz-critical: #d03b3b;
  /* TEXT steps for deltas — the status steps above are mark colors and are
     sub-4.5:1 as small text (good #0ca30c is only 3.35:1 on white). These are
     the darker text-safe equivalents: 7.54:1 and 6.54:1 on the light surface. */
  --viz-delta-up: #006300;
  --viz-delta-down: #b3261e;
  --viz-grid: rgba(11,11,11,0.08);
  --viz-axis: rgba(11,11,11,0.18);
  --viz-surface: #FFFFFF;
  --viz-deemph: rgba(11,11,11,0.16);
}
[data-theme="dark"] .viz-root {
  --viz-s1: #1183B4;
  --viz-s2: #7C3AED;
  --viz-s3: #C2410C;
  --viz-o1: #A9DEF5;
  --viz-o2: #5CBCE8;
  --viz-o3: #2295C8;
  --viz-o4: #12719C;
  /* Dark-surface text steps: 5.27:1 and 7.40:1 on #111923. */
  --viz-delta-up: #0ca30c;
  --viz-delta-down: #f28b82;
  --viz-grid: rgba(255,255,255,0.08);
  --viz-axis: rgba(255,255,255,0.20);
  --viz-surface: #111923;
  --viz-deemph: rgba(255,255,255,0.18);
}
`;

// Categorical slots — assigned in fixed order, never cycled. Past 3 series, fold
// the tail into "Other" or facet; do NOT generate a 4th hue.
export const SERIES = ['var(--viz-s1)', 'var(--viz-s2)', 'var(--viz-s3)'];

// Ordinal ramp (light→dark) for ordered tiers.
const ORDINAL = ['var(--viz-o1)', 'var(--viz-o2)', 'var(--viz-o3)', 'var(--viz-o4)'];

/**
 * Map item i of n onto the ordinal ramp so the reader sees the ORDER in the color.
 * With n ≤ 4 every tier gets its own validated step. With more tiers than steps,
 * neighbours may share a step — acceptable here because every bar is also
 * direct-labelled with its tier name and value (secondary encoding).
 */
export function ordinalStep(i, n) {
  if (n <= 1) return ORDINAL[ORDINAL.length - 1];
  const idx = Math.round((i / (n - 1)) * (ORDINAL.length - 1));
  return ORDINAL[Math.max(0, Math.min(ORDINAL.length - 1, idx))];
}

export const STATUS = {
  good: 'var(--viz-good)',
  warning: 'var(--viz-warning)',
  serious: 'var(--viz-serious)',
  critical: 'var(--viz-critical)',
};

export const GRID = 'var(--viz-grid)';
export const AXIS = 'var(--viz-axis)';
export const SURFACE = 'var(--viz-surface)';
export const DEEMPH = 'var(--viz-deemph)';

// Compact value formatting for stat tiles / axis ticks (1,284 · 12.9K · 4.2M).
export function compact(n) {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return v.toLocaleString();
}
