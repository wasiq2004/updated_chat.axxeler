// The NT style map — a drift guard.
//
// THE BUG THIS EXISTS FOR: adding a block to BLOCK_GROUPS without an NT entry
// makes NT[type] undefined, and the very next `.bg` throws. The block library
// maps over EVERY palette item when it opens, so one missing entry white-screens
// the whole Automation Builder with "Cannot read properties of undefined
// (reading 'bg')" — not a broken block, a broken page. That shipped twice, for
// `sheets` and `agentHandoff`.
//
// Nothing about that is caught by a build, a typecheck, or any test that doesn't
// render the palette. So: assert the invariant directly.

import { describe, it, expect } from 'vitest';
import { NT, ntOf, BLOCK_GROUPS } from '../AutomationBuilderView.jsx';

// Every field a render path reads off an NT entry.
const REQUIRED = ['bg', 'border', 'color', 'accent', 'label', 'icon'];

const paletteTypes = [...new Set(BLOCK_GROUPS.flatMap(g => g.items.map(i => i.type)))];

describe('every palette block has a real NT entry', () => {
  it('the palette is not empty (a vacuous pass would be worse than a failure)', () => {
    expect(paletteTypes.length).toBeGreaterThan(5);
  });

  it.each(paletteTypes)('NT has an entry for the "%s" block', (type) => {
    // NOT ntOf() — the fallback would make this pass for a missing entry, which
    // is the exact bug. Index the map directly.
    expect(NT[type], `BLOCK_GROUPS offers a "${type}" block but NT has no entry — the builder will throw on open`).toBeDefined();
  });

  it.each(paletteTypes)('the "%s" entry has every field a render path reads', (type) => {
    const entry = NT[type];
    for (const field of REQUIRED) {
      expect(entry?.[field], `NT.${type}.${field} is missing`).toBeDefined();
    }
  });

  it('the two blocks that actually caused the white-screen are present', () => {
    // Regression pins, by name, so a refactor can't quietly drop them again.
    expect(NT.sheets).toBeDefined();
    expect(NT.agentHandoff).toBeDefined();
  });

  it('every icon is callable — a render path invokes it as icon(13)', () => {
    for (const type of paletteTypes) {
      expect(typeof NT[type].icon, `NT.${type}.icon must be a function`).toBe('function');
    }
  });
});

describe('ntOf never returns undefined', () => {
  it('an unknown type degrades to a neutral chip instead of throwing', () => {
    // An imported flow, a future block, or a typo must not white-screen the
    // builder. This is the safety net behind the drift guard above.
    const t = ntOf('some-block-from-the-future');
    expect(t).toBeDefined();
    for (const field of REQUIRED) expect(t[field]).toBeDefined();
    // The thing that actually threw.
    expect(() => `${t.bg}`).not.toThrow();
  });

  it.each([undefined, null, '', 0, false])('degrades safely for %p', (bad) => {
    expect(ntOf(bad)?.bg).toBeDefined();
  });

  it('a known type still gets its own style, not the fallback', () => {
    expect(ntOf('trigger')).toBe(NT.trigger);
    expect(ntOf('sheets')).toBe(NT.sheets);
    expect(ntOf('sheets').color).not.toBe(ntOf('nonsense').color);
  });
});

describe('the node categories stay visually distinct', () => {
  // Both `color` and `accent` are checked independently: keying only on `color`
  // let a duplicated `accent` through, which is half the styling.
  it.each(['color', 'accent'])('no two categories share a %s', (field) => {
    // Colour is how a category is recognised at a glance on the canvas. Two
    // categories with the same one are indistinguishable while scanning — and
    // duplicates creep in easily when adding a block by copy-paste.
    // (delay/condition deliberately share amber: both are "wait/branch" timing.)
    const byColor = {};
    for (const [type, v] of Object.entries(NT)) {
      (byColor[v[field]] ||= []).push(type);
    }
    const clashes = Object.entries(byColor)
      .filter(([, types]) => types.length > 1)
      .map(([color, types]) => `${color}: ${types.join(' + ')}`);
    expect(clashes).toEqual(['#D97706: condition + delay']);
  });

  it('color and accent agree within each entry', () => {
    // They are the same value in every entry today. If that ever diverges it's
    // a copy-paste slip, and the two uniqueness checks above stop being
    // equivalent — which is how the duplicate-accent case hid.
    for (const [type, v] of Object.entries(NT)) {
      expect(v.accent, `NT.${type}: color/accent disagree`).toBe(v.color);
    }
  });

  it('every label is unique — the label is what disambiguates a shared hue', () => {
    const labels = Object.values(NT).map(v => v.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
