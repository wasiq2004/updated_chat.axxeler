// The scheduled-trigger inspector.
//
// A schedule is the one trigger with no inbound message, so it must be told WHO
// to run for. That makes its worst failures silent and expensive:
//
//   * an empty audience reading as "everyone" (a test schedule messages the
//     whole contact list at 09:00)
//   * a weekly with no days selected that never runs and never says so
//   * the node label lying about when it fires
//
// getTriggerDisplay is pure; ScheduleTriggerFields is rendered for real, because
// last time it was rendering — not node --check — that caught the live bugs.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The sheet picker fires network calls on mount; the audience/timing rules under
// test don't care what Google says.
vi.mock('../SheetPicker.jsx', () => ({
  useSheetPicker: () => ({ accounts: [], spreadsheets: [], tabs: [], headers: [], scopeMissing: false, headerError: null }),
  useSavedSheets: () => ({ saved: [], reload: () => {} }),
  resolveSavedSheet: () => null,
  default: () => null,
}));
vi.mock('../../api.js', () => ({ api: { googleIntegrations: { list: vi.fn(() => Promise.resolve([])) } } }));

import { getTriggerDisplay, ScheduleTriggerFields } from '../AutomationBuilderView.jsx';

const base = {
  id: 'n1', type: 'trigger', triggerKind: 'schedule',
  scheduleMode: 'daily', timeOfDay: '09:00', timezone: 'Asia/Kolkata',
  audienceMode: 'contacts', audienceTagIds: [7], maxPerRun: 100,
};
const TAGS = [{ id: 7, name: 'Hot Lead' }, { id: 8, name: 'Cold' }];

function renderFields(over = {}) {
  const onUpdateNode = vi.fn();
  render(<ScheduleTriggerFields node={{ ...base, ...over }} onUpdateNode={onUpdateNode} tags={TAGS} />);
  return { onUpdateNode };
}

describe('the node label tells the truth about when it fires', () => {
  it('daily says the time and the timezone', () => {
    const d = getTriggerDisplay({ ...base, timeOfDay: '18:30' });
    expect(d.title).toContain('18:30');
    expect(d.title).toContain('Every day');
    expect(d.sub).toContain('Asia/Kolkata');
  });

  it('weekly names the actual days, not a count', () => {
    const d = getTriggerDisplay({ ...base, scheduleMode: 'weekly', weekdays: [1, 4] });
    expect(d.title).toContain('Mon');
    expect(d.title).toContain('Thu');
  });

  it('a weekly with NO days says so rather than implying it runs', () => {
    // It genuinely never fires. A label reading "Every day" or "0 days" here is
    // how a flow sits dead for a week before anyone notices.
    const d = getTriggerDisplay({ ...base, scheduleMode: 'weekly', weekdays: [] });
    expect(d.title).toMatch(/No days picked/i);
  });

  it('monthly names the day', () => {
    const d = getTriggerDisplay({ ...base, scheduleMode: 'monthly', dayOfMonth: 15 });
    expect(d.title).toContain('Day 15');
  });

  it('the label distinguishes the three audiences', () => {
    expect(getTriggerDisplay({ ...base, audienceMode: 'sheet' }).sub).toMatch(/sheet row/i);
    expect(getTriggerDisplay({ ...base, audienceMode: 'once' }).sub).toMatch(/once, no contact/i);
    expect(getTriggerDisplay({ ...base, audienceMode: 'contacts' }).sub).toMatch(/matching contacts/i);
  });
});

describe('the audience picker', () => {
  it('AN EMPTY TAG LIST WARNS, and promises it will NOT fall back to everyone', async () => {
    // The backend refuses this case. The UI must say the same thing at the point
    // the choice is made, or the operator reasonably assumes "no filter = all".
    renderFields({ audienceTagIds: [] });
    const warn = screen.getByText(/Pick at least one tag/i);
    expect(warn).toBeTruthy();
    expect(warn.textContent).toMatch(/will not fall back to .everyone./i);
  });

  it('does not warn once a tag is chosen', () => {
    renderFields({ audienceTagIds: [7] });
    expect(screen.queryByText(/Pick at least one tag/i)).toBeNull();
  });

  it('tags toggle on and off, and the selection is exposed to assistive tech', async () => {
    const user = userEvent.setup();
    const { onUpdateNode } = renderFields({ audienceTagIds: [7] });
    const hot = screen.getByRole('button', { name: 'Hot Lead' });
    // Colour alone can't carry "selected" — aria-pressed must.
    expect(hot.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Cold' }).getAttribute('aria-pressed')).toBe('false');

    await user.click(screen.getByRole('button', { name: 'Cold' }));
    expect(onUpdateNode).toHaveBeenCalledWith('n1', { audienceTagIds: [7, 8] });

    await user.click(hot);
    expect(onUpdateNode).toHaveBeenLastCalledWith('n1', { audienceTagIds: [] });
  });

  it('"once" mode says out loud that messaging steps will fail', () => {
    renderFields({ audienceMode: 'once' });
    expect(screen.getByText(/no contact/i)).toBeTruthy();
    expect(screen.getByText(/Send Message step in this flow will fail/i)).toBeTruthy();
  });

  it('the safety cap is not offered for a contactless run', () => {
    renderFields({ audienceMode: 'once' });
    expect(screen.queryByText(/Never message more than/i)).toBeNull();
  });
});

describe('the timing fields', () => {
  it('a weekly with no days selected is flagged as never running', async () => {
    renderFields({ scheduleMode: 'weekly', weekdays: [] });
    expect(screen.getByText(/with none selected this never runs/i)).toBeTruthy();
  });

  it('weekday toggles round-trip through onUpdateNode', async () => {
    const user = userEvent.setup();
    const { onUpdateNode } = renderFields({ scheduleMode: 'weekly', weekdays: [1] });
    await user.click(screen.getByRole('button', { name: 'Thu' }));
    expect(onUpdateNode).toHaveBeenCalledWith('n1', { weekdays: [1, 4] });
  });

  it('a monthly past the 28th explains the clamp instead of silently skipping months', () => {
    // The backend clamps 31 -> Feb 28. If the UI doesn't say so, the operator
    // reasonably expects February to be skipped, or worse, doesn't think about it.
    renderFields({ scheduleMode: 'monthly', dayOfMonth: 31 });
    expect(screen.getByText(/February has no 31th/i)).toBeTruthy();
  });

  it('a safe day-of-month says nothing', () => {
    renderFields({ scheduleMode: 'monthly', dayOfMonth: 12 });
    expect(screen.queryByText(/February has no/i)).toBeNull();
  });

  it('a custom timezone survives — the preset list is not a whitelist', async () => {
    // THE TRAP: a <select> whose value matches no <option> renders as the FIRST
    // option, silently rewriting Australia/Sydney to Asia/Kolkata on the next save.
    renderFields({ timezone: 'Australia/Sydney' });
    const free = screen.getByDisplayValue('Australia/Sydney');
    expect(free).toBeTruthy();
  });

  it('a preset timezone does not show the free-text box', () => {
    renderFields({ timezone: 'UTC' });
    expect(screen.queryByDisplayValue('UTC')).toBeNull(); // it's a select option, not an input
    expect(screen.queryByPlaceholderText('Australia/Sydney')).toBeNull();
  });

  it('the polling granularity is disclosed, not discovered', () => {
    renderFields();
    expect(screen.getByText(/once per day at most/i)).toBeTruthy();
  });
});
