// Phone numbers must render in full.
//
// The masking these replace was cosmetic — every contact endpoint returns the
// full number in the clear, so it protected nothing and cost an extra click on
// every row. These tests exist because "helpfully" re-adding a mask is an easy,
// well-meaning regression, and nothing else in the suite would notice.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { maskPhone } from '../../constants.js';
import MaskedNumber from '../MaskedNumber.jsx';

describe('maskPhone', () => {
  it('returns the number unchanged, with no stars', () => {
    expect(maskPhone('919487722330')).toBe('919487722330');
    expect(maskPhone('93123456678')).toBe('93123456678');
    expect(maskPhone(919487722330)).toBe('919487722330');
  });

  it('never emits a mask character for any length', () => {
    for (const n of ['1', '12345', '123456', '919487722330', '+91 94877 22330']) {
      expect(maskPhone(n)).not.toContain('*');
    }
  });

  it('still normalises nullish input to a string', () => {
    // Call sites use it inline in <option> labels and template strings, which
    // relied on this before and would render "null"/"undefined" without it.
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
    expect(maskPhone('')).toBe('');
  });

  it('preserves formatting rather than stripping to digits', () => {
    // The old implementation digit-stripped as a side effect of masking. Now
    // that we show the value, show what we were actually given.
    expect(maskPhone('+91 94877 22330')).toBe('+91 94877 22330');
  });
});

describe('<MaskedNumber>', () => {
  it('renders the full number immediately, with no click needed', () => {
    render(<MaskedNumber number="919487722330" />);
    expect(screen.getByText('919487722330')).toBeInTheDocument();
  });

  it('applies the prefix', () => {
    render(<MaskedNumber number="919487722330" prefix="+" />);
    expect(screen.getByText('+919487722330')).toBeInTheDocument();
  });

  it('renders nothing for an empty number', () => {
    const { container } = render(<MaskedNumber number="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not swallow clicks from the row it sits in', async () => {
    // It used to stopPropagation() so revealing didn't fire the row's onClick.
    // With nothing to reveal, that just made part of the row mysteriously dead.
    let rowClicked = false;
    render(
      <div onClick={() => { rowClicked = true; }}>
        <MaskedNumber number="919487722330" />
      </div>
    );
    screen.getByText('919487722330').click();
    expect(rowClicked).toBe(true);
  });
});
