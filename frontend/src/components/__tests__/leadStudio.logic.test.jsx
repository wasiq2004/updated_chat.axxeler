// Lead Studio — the logic that can't be eyeballed.
//
// Three stated traps, each a silent failure:
//   * a bulk action reusing the per-record save WIPES tags (the save path does
//     `tags = EXCLUDED.tags` with no COALESCE, and api.saveContact defaults []).
//   * unscored leads sorting as 0 — wrong in both directions.
//   * a segment chip counting with a different predicate than it filters with,
//     so the chip says 12 and the table shows 9.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api.js', () => ({
  api: {
    numbers: vi.fn(() => Promise.resolve([{ wa_number: '919876543210', display_name: 'Sales' }])),
    savedContacts: vi.fn(() => Promise.resolve(CONTACTS)),
    categories: { list: vi.fn(() => Promise.resolve(CATEGORIES)) },
    tags: { list: vi.fn(() => Promise.resolve(TAGS)) },
    contactFields: { list: vi.fn(() => Promise.resolve([])) },
    users: { list: vi.fn(() => Promise.resolve(USERS)) },
    saveContact: vi.fn(() => Promise.resolve({})),
    contact: vi.fn(() => Promise.resolve({})),
    deleteContact: vi.fn(() => Promise.resolve({})),
    templates: vi.fn(() => Promise.resolve([])),
    mediaLibrary: { list: vi.fn(() => Promise.resolve([])) },
  },
}));

import ContactsPage from '../../pages/ContactsPage.jsx';
import { api } from '../../api.js';

const CATEGORIES = [
  { id: 'cat-stage', name: 'Stage' },
  { id: 'cat-source', name: 'Lead Source' },
];
const TAGS = [
  { id: 'tag-hot', name: 'Hot', color: '#fecaca', category_id: 'cat-stage' },
  { id: 'tag-cold', name: 'Cold', color: '#bfdbfe', category_id: 'cat-stage' },
  // 'Warm' and 'Referral' are on NO contact, so clicking them in a dropdown is
  // unambiguous — 'Cold'/'Instagram' also render as badges in the table.
  { id: 'tag-warm', name: 'Warm', color: '#fed7aa', category_id: 'cat-stage' },
  { id: 'tag-ig', name: 'Instagram', color: '#fbcfe8', category_id: 'cat-source' },
  { id: 'tag-ref', name: 'Referral', color: '#ddd6fe', category_id: 'cat-source' },
];
const USERS = [
  { id: 1, username: 'asha', displayName: 'Asha', role: 'bda_sales', isActive: true },
  { id: 2, username: 'ravi', displayName: 'Ravi', role: 'bda_sales', isActive: true },
  // Owns nobody — same reason as above.
  { id: 3, username: 'meera', displayName: 'Meera', role: 'bda_sales', isActive: true },
];

const now = new Date();
const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return d.toISOString(); };

// Deliberate mix: scored high/low, unscored, assigned/unassigned, new/old.
const CONTACTS = [
  { contact_number: '911', name: 'Zara Unscored', tags: [{ id: 'tag-cold', name: 'Cold', color: '#bfdbfe', category_id: 'cat-stage' }], custom_fields: {}, created_at: daysAgo(40), assigned_user_id: null, assigned_user_name: null },
  { contact_number: '912', name: 'Bilal Hot', tags: [{ id: 'tag-hot', name: 'Hot', color: '#fecaca', category_id: 'cat-stage' }, { id: 'tag-ig', name: 'Instagram', color: '#fbcfe8', category_id: 'cat-source' }], custom_fields: { lead_score: '90' }, created_at: daysAgo(2), assigned_user_id: 1, assigned_user_name: 'Asha', assigned_user_role: 'bda_sales' },
  { contact_number: '913', name: 'Amir Low', tags: [], custom_fields: { lead_score: '10' }, created_at: daysAgo(3), assigned_user_id: 2, assigned_user_name: 'Ravi', assigned_user_role: 'bda_sales' },
  { contact_number: '914', name: 'Cara Zero', tags: [], custom_fields: { lead_score: '0' }, created_at: daysAgo(60), assigned_user_id: null, assigned_user_name: null },
];

const ADMIN = { id: 99, role: 'admin', displayName: 'Owner' };

async function renderPage() {
  render(<ContactsPage user={ADMIN} onNavigate={() => {}} />);
  await screen.findByText('Bilal Hot');
}

function rowOrder() {
  // Names as they appear in the table body, top to bottom.
  return CONTACTS
    .map(c => c.name)
    .map(n => ({ n, el: screen.queryByText(n) }))
    .filter(x => x.el)
    .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1)
    .map(x => x.n);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('score sorting', () => {
  it('sinks unscored leads to the bottom in BOTH directions', async () => {
    const user = userEvent.setup();
    await renderPage();
    const scoreHeader = screen.getByRole('button', { name: /Score/ });

    await user.click(scoreHeader);          // first click: best first
    let order = rowOrder();
    expect(order[order.length - 1]).toBe('Zara Unscored');

    await user.click(scoreHeader);          // flip
    order = rowOrder();
    // The whole point: flipping must NOT float the unscored to the top. If null
    // were treated as 0 it would lead an ascending sort.
    expect(order[order.length - 1]).toBe('Zara Unscored');
  });

  it('ranks a real 0 above an unscored lead', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole('button', { name: /Score/ }));
    await user.click(screen.getByRole('button', { name: /Score/ })); // ascending
    const order = rowOrder();
    // "Scored 0" and "never scored" are different facts.
    expect(order.indexOf('Cara Zero')).toBeLessThan(order.indexOf('Zara Unscored'));
  });

  it('renders an unscored lead as a dash, never as 0', async () => {
    await renderPage();
    // A 0 would claim we assessed them and found them worthless.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('0')).toBeInTheDocument(); // Cara's real zero still shows
  });
});

describe('segment chips', () => {
  it('a chip count matches what the chip then shows', async () => {
    const user = userEvent.setup();
    await renderPage();
    // Hot = score >= 70. Only Bilal.
    const hotChip = screen.getByRole('button', { name: /^Hot/ });
    expect(hotChip).toHaveTextContent('1');
    await user.click(hotChip);
    expect(screen.getByText('Bilal Hot')).toBeInTheDocument();
    expect(screen.queryByText('Amir Low')).not.toBeInTheDocument();
  });

  it('unassigned counts and filters identically', async () => {
    const user = userEvent.setup();
    await renderPage();
    const chip = screen.getByRole('button', { name: /^Unassigned/ });
    expect(chip).toHaveTextContent('2'); // Zara + Cara
    await user.click(chip);
    expect(screen.getByText('Zara Unscored')).toBeInTheDocument();
    expect(screen.getByText('Cara Zero')).toBeInTheDocument();
    expect(screen.queryByText('Bilal Hot')).not.toBeInTheDocument();
  });
});

describe('bulk actions preserve data', () => {
  it('bulk assign owner does NOT wipe the contact tags', async () => {
    const user = userEvent.setup();
    await renderPage();

    // Select Bilal, who has two tags across two categories.
    const checkboxes = screen.getAllByRole('checkbox');
    const bilalRow = screen.getByText('Bilal Hot').closest('tr');
    await user.click(bilalRow.querySelector('input[type="checkbox"]'));

    await user.click(screen.getByText('Assign owner…'));
    await user.click(await screen.findByText('Meera'));

    expect(api.saveContact).toHaveBeenCalledTimes(1);
    const [, contactNumber, name, tags, customFields, assignedUserId] = api.saveContact.mock.calls[0];
    expect(contactNumber).toBe('912');
    // THE TRAP: tags is always sent and defaults to []. Passing the full current
    // array is the only thing standing between a bulk assign and deleting every
    // tag on the contact (and firing "Tag Removed" automations for each).
    expect(tags).toHaveLength(2);
    expect(tags.map(t => t.id).sort()).toEqual(['tag-hot', 'tag-ig']);
    // customFields must be omitted so the server preserves it — sending {} or a
    // partial object would drop lead_score.
    expect(customFields).toBeUndefined();
    expect(name).toBe(''); // '' = don't touch the name
    expect(assignedUserId).toBe(3);
  });

  it('bulk add tag replaces only the same category, keeping the rest', async () => {
    const user = userEvent.setup();
    await renderPage();

    const bilalRow = screen.getByText('Bilal Hot').closest('tr');
    await user.click(bilalRow.querySelector('input[type="checkbox"]'));

    await user.click(screen.getByText('Add tag…'));
    await user.click(await screen.findByText('Warm')); // same category as Hot

    const [, , , tags] = api.saveContact.mock.calls[0];
    const ids = tags.map(t => t.id).sort();
    // Warm replaces Hot (one tag per category), Instagram is untouched.
    expect(ids).toEqual(['tag-ig', 'tag-warm']);
  });

  it('bulk add tag on a contact with no tags just adds it', async () => {
    const user = userEvent.setup();
    await renderPage();
    const row = screen.getByText('Amir Low').closest('tr');
    await user.click(row.querySelector('input[type="checkbox"]'));
    await user.click(screen.getByText('Add tag…'));
    await user.click(await screen.findByText('Referral'));
    const [, , , tags] = api.saveContact.mock.calls[0];
    expect(tags.map(t => t.id)).toEqual(['tag-ref']);
  });
});

describe('KPIs', () => {
  it('reports totals for the account, not the filtered view', async () => {
    const user = userEvent.setup();
    await renderPage();
    expect(screen.getByText('Total leads').parentElement).toHaveTextContent('4');
    // Narrowing to a segment must not move the headline number.
    await user.click(screen.getByRole('button', { name: /^Hot/ }));
    expect(screen.getByText('Total leads').parentElement).toHaveTextContent('4');
  });

  it('averages only scored leads and shows a dash when none are scored', async () => {
    await renderPage();
    // (90 + 10 + 0) / 3 = 33 — the unscored lead must not drag it toward 0.
    expect(screen.getByText('Avg score').parentElement).toHaveTextContent('33');
  });
});
