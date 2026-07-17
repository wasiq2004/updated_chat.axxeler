// "Cannot read properties of undefined (reading 'bg')" — the builder would not
// open at all. The palette maps NT[it.type] over EVERY block when the library
// renders, so a single missing NT entry threw before anything drew.
//
// The drift guard in nodeStyles.test.jsx asserts the invariant; this proves the
// real consequence: the block library renders every block without throwing.

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { BLOCK_GROUPS, ntOf } from '../AutomationBuilderView.jsx';

describe('every palette block renders the chip that used to throw', () => {
  const items = BLOCK_GROUPS.flatMap(g => g.items);

  it.each(items.map(i => [i.name, i]))('renders the "%s" block chip', (_name, it_) => {
    const t = ntOf(it_.type);
    // This is the exact expression from the block library (line ~1161) that blew up.
    expect(() => render(
      <div style={{ background: t.bg, color: t.color, borderColor: t.border }}>
        <span style={{ background: t.bg }}>{t.icon(13)}</span>
        {it_.icon(13)}
        <span>{it_.name}</span>
      </div>
    )).not.toThrow();
  });

  it('the palette actually contains the two blocks that broke it', () => {
    const types = items.map(i => i.type);
    expect(types).toContain('sheets');
    expect(types).toContain('agentHandoff');
  });
});
