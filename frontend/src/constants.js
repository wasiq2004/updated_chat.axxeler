// Color tokens map to CSS variables (defined per-theme in index.css) so the
// whole app re-themes when <html data-theme> flips. Fallbacks = light values,
// so colors still render even if the stylesheet hasn't loaded.
export const C = {
  pageBg: 'var(--c-pageBg, #0A0A0A)',
  sidebarBg: 'var(--c-sidebarBg, rgba(17,17,17,.72))',
  sidebarBorder: 'var(--c-sidebarBorder, rgba(255,255,255,.08))',
  headerBg: 'var(--c-headerBg, rgba(10,10,10,.86))',
  headerText: 'var(--c-headerText, #FFFFFF)',
  headerMuted: 'var(--c-headerMuted, #A1A1AA)',
  headerBorder: 'var(--c-headerBorder, rgba(255,255,255,.12))',
  headerSurface: 'var(--c-headerSurface, rgba(255,255,255,.07))',
  cardBg: 'var(--c-cardBg, #111111)',
  border: 'var(--c-border, rgba(255,255,255,.08))',
  borderDark: 'var(--c-borderDark, rgba(255,255,255,.10))',
  text: 'var(--c-text, #FFFFFF)',
  textSecondary: 'var(--c-textSecondary, #A1A1AA)',
  textMuted: 'var(--c-textMuted, #71717A)',
  primary: 'var(--c-primary, #0FA8E0)',
  primaryHover: 'var(--c-primaryHover, #0B8FC2)',
  primaryLight: 'var(--c-primaryLight, rgba(15,168,224,.12))',
  primaryText: 'var(--c-primaryText, #FFFFFF)',
  purple: 'var(--c-purple, #9D7CFF)',
  green: 'var(--c-green, #22C55E)',
  amber: 'var(--c-amber, #F6B100)',
  error: 'var(--c-error, #DC2626)',
  // Brand gradients (ZenAutomation cyan → amber). Use for hero/CTA surfaces.
  primaryGradient: 'var(--c-primaryGradient, linear-gradient(135deg, #0FA8E0 0%, #38CDF0 100%))',
  brandGradient: 'var(--c-brandGradient, linear-gradient(120deg, #0FA8E0 0%, #2BC4E8 48%, #F6B100 125%))',
  amberGradient: 'var(--c-amberGradient, linear-gradient(135deg, #F6B100 0%, #FFD24D 100%))',
  shadowSm: 'var(--c-shadowSm, 0 1px 0 rgba(255,255,255,.04), 0 10px 24px rgba(0,0,0,.24))',
  shadowMd: 'var(--c-shadowMd, 0 18px 50px rgba(0,0,0,.32))',
  shadowLg: 'var(--c-shadowLg, 0 28px 90px rgba(0,0,0,.56))',
  waBg: 'var(--c-waBg, #0F1411)',
  // neutral surface aliases (used when migrating literal-heavy views)
  surface: 'var(--c-surface, #111111)',
  surfaceAlt: 'var(--c-surfaceAlt, #171717)',
  hover: 'var(--c-hover, rgba(255,255,255,.06))',
  waBgPattern: 'url("data:image/svg+xml,%3Csvg width=\'16\' height=\'16\' viewBox=\'0 0 16 16\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cpath d=\'M0 0h8v8H0z\' fill=\'%23d1d7db\' fill-opacity=\'0.15\'/%3E%3C/svg%3E")',
};

export const CHAT = {
  incomingBg: 'var(--c-incomingBg, #18181B)',
  incomingText: 'var(--c-incomingText, #FFFFFF)',
  outgoingBg: 'var(--c-outgoingBg, #0FA8E0)',
  outgoingText: 'var(--c-outgoingText, #FFFFFF)',
  chatBg: 'var(--c-chatBg, #0D0D0D)',
  bubbleRadius: '7.5px',
  bubblePadding: '6px 7px 8px 9px',
  statusDelivered: 'var(--c-statusDelivered, #53bdeb)',
  statusRead: 'var(--c-statusRead, #53bdeb)',
  statusSent: 'var(--c-statusSent, #8696a0)',
};

export const FONT = "'Manrope', 'Plus Jakarta Sans', Inter, system-ui, sans-serif";
export const MONO = "'Geist Mono', 'SFMono-Regular', Consolas, monospace";

export function relativeTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// Phone numbers are shown in full. This used to star out the middle digits
// ("91*******330"); it now passes through.
//
// The masking was cosmetic, not a security control: every contact endpoint
// returns the full number in the clear, so it protected nothing and cost the
// people who actually need the number an extra click on every row.
//
// Kept as a function rather than deleted so the ~11 call sites (<option> labels,
// plain strings) don't all have to change. Still normalises to a string, which
// is what those call sites rely on for null/undefined.
export function maskPhone(raw) {
  return String(raw ?? '');
}

// Tag colors are stored as pale pastels (good as light fills, unreadable with
// the white chip text). Darken a hex color so a white label reads clearly while
// the tag keeps its own hue. Falls back to a dark slate for missing/invalid.
export function darkenColor(hex, factor = 0.5) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return '#374151';
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `rgb(${r}, ${g}, ${b})`;
}

// Trigger a client-side download of a JS object as a pretty-printed .json file.
export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.json') ? filename : `${filename}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Slugify a name into a safe filename fragment.
export function slugifyName(name) {
  return String(name || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export';
}

export function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}
