// Manage Tags — the four UI traps, each a real bug that only rendering catches.
//
//  1. A nested form modal bubbles its backdrop click and closes the parent.
//  2. A form that resets on a refetched array wipes what the user is typing.
//  3. `saving` cleared only in the error path leaves the form dead after a
//     successful save (and returning null does NOT unmount it).
//  4. A filter select with no explicit "All" can't be undone.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api.js', () => ({
  api: {
    tags: { create: vi.fn(() => Promise.resolve({ id: 'tag-new' })), update: vi.fn(() => Promise.resolve({})), delete: vi.fn(() => Promise.resolve({})) },
    categories: { create: vi.fn(() => Promise.resolve({ id: 'cat-new', name: 'Fresh' })) },
  },
}));

import ManageTagsModal from '../ManageTagsModal.jsx';
import CreateCategoryModal from '../CreateCategoryModal.jsx';
import { api } from '../../api.js';

const CATEGORIES = [{ id: 'cat-stage', name: 'Stage' }, { id: 'cat-source', name: 'Lead Source' }];
const TAGS = [
  { id: 'tag-hot', name: 'Hot', color: '#fecaca', category_id: 'cat-stage' },
  { id: 'tag-ig', name: 'Instagram', color: '#fbcfe8', category_id: 'cat-source' },
];

beforeEach(() => vi.clearAllMocks());

describe('ManageTagsModal', () => {
  it('groups tags under their category', () => {
    render(<ManageTagsModal categories={CATEGORIES} tags={TAGS} onClose={() => {}} onChanged={() => {}} onCreateCategory={() => {}} />);
    expect(screen.getByText('Stage')).toBeInTheDocument();
    expect(screen.getByText('Lead Source')).toBeInTheDocument();
    expect(screen.getByText('Hot')).toBeInTheDocument();
  });

  it('creates a tag with its category — a tag cannot exist without one', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(<ManageTagsModal categories={CATEGORIES} tags={TAGS} onClose={() => {}} onChanged={onChanged} onCreateCategory={() => {}} />);
    await user.click(screen.getByRole('button', { name: /New tag/ }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'Warm');
    await user.selectOptions(screen.getByLabelText('Category'), 'cat-stage');
    await user.click(screen.getByRole('button', { name: /Create/ }));
    expect(api.tags.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Warm', categoryId: 'cat-stage' }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('refuses to create a tag with no category', async () => {
    const user = userEvent.setup();
    render(<ManageTagsModal categories={CATEGORIES} tags={TAGS} onClose={() => {}} onChanged={() => {}} onCreateCategory={() => {}} />);
    await user.click(screen.getByRole('button', { name: /New tag/ }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'Orphan');
    await user.selectOptions(screen.getByLabelText('Category'), '');
    await user.click(screen.getByRole('button', { name: /Create/ }));
    // tags.category_id is NOT NULL — the DB would reject it anyway, but with a
    // 500 instead of a sentence.
    expect(api.tags.create).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/category/i);
  });

  // TRAP 3
  it('re-enables the form after a SUCCESSFUL save', async () => {
    const user = userEvent.setup();
    render(<ManageTagsModal categories={CATEGORIES} tags={TAGS} onClose={() => {}} onChanged={() => {}} onCreateCategory={() => {}} />);
    await user.click(screen.getByRole('button', { name: /New tag/ }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'Warm');
    await user.selectOptions(screen.getByLabelText('Category'), 'cat-stage');
    await user.click(screen.getByRole('button', { name: /Create/ }));
    // Re-open: a `saving` flag cleared only in the catch would leave this
    // permanently disabled, and hiding the form by returning null does not
    // unmount it, so the stale flag would survive.
    await user.click(screen.getByRole('button', { name: /New tag/ }));
    expect(screen.getByRole('button', { name: /Create/ })).toBeEnabled();
  });

  it('re-enables the form after a FAILED save, and says why', async () => {
    api.tags.create.mockRejectedValueOnce(new Error('Name already exists'));
    const user = userEvent.setup();
    render(<ManageTagsModal categories={CATEGORIES} tags={TAGS} onClose={() => {}} onChanged={() => {}} onCreateCategory={() => {}} />);
    await user.click(screen.getByRole('button', { name: /New tag/ }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'Hot');
    await user.selectOptions(screen.getByLabelText('Category'), 'cat-stage');
    await user.click(screen.getByRole('button', { name: /Create/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Name already exists');
    expect(screen.getByRole('button', { name: /Create/ })).toBeEnabled();
  });

  // TRAP 2
  it('does NOT wipe a half-typed name when the tag list is refetched', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ManageTagsModal categories={CATEGORIES} tags={TAGS} onClose={() => {}} onChanged={() => {}} onCreateCategory={() => {}} />
    );
    await user.click(screen.getByRole('button', { name: /New tag/ }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'Half typed');

    // Exactly what creating a category inline does: the parent refetches and
    // passes NEW array identities. A reset keyed on `tags`/`categories` would
    // blank the field mid-typing.
    rerender(
      <ManageTagsModal
        categories={[...CATEGORIES, { id: 'cat-new', name: 'Fresh' }]}
        tags={[...TAGS]}
        onClose={() => {}} onChanged={() => {}} onCreateCategory={() => {}}
      />
    );
    expect(screen.getByPlaceholderText('Tag name')).toHaveValue('Half typed');
  });

  it('asks the parent to open the category form — never renders it itself', async () => {
    const user = userEvent.setup();
    const onCreateCategory = vi.fn();
    render(<ManageTagsModal categories={CATEGORIES} tags={TAGS} onClose={() => {}} onChanged={() => {}} onCreateCategory={onCreateCategory} />);
    await user.click(screen.getByRole('button', { name: /New category/ }));
    // TRAP 1: nested, this modal's backdrop click would bubble and close the tag
    // manager underneath. The parent renders it as a sibling instead.
    expect(onCreateCategory).toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'New category' })).not.toBeInTheDocument();
  });

  it('blocks New tag when there are no categories, and says why', () => {
    render(<ManageTagsModal categories={[]} tags={[]} onClose={() => {}} onChanged={() => {}} onCreateCategory={() => {}} />);
    expect(screen.getByRole('button', { name: /New tag/ })).toBeDisabled();
    expect(screen.getByText(/A tag has to live in one/)).toBeInTheDocument();
  });

  it('deletes a tag only after confirming', async () => {
    const user = userEvent.setup();
    render(<ManageTagsModal categories={CATEGORIES} tags={TAGS} onClose={() => {}} onChanged={() => {}} onCreateCategory={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Delete Hot' }));
    expect(api.tags.delete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete tag' }));
    expect(api.tags.delete).toHaveBeenCalledWith('tag-hot');
  });
});

describe('CreateCategoryModal', () => {
  it('creates and hands the category back', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<CreateCategoryModal onClose={() => {}} onCreated={onCreated} />);
    await user.type(screen.getByPlaceholderText('e.g. Lead Source'), 'Industry');
    await user.click(screen.getByRole('button', { name: /Create/ }));
    expect(api.categories.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Industry' }));
    expect(onCreated).toHaveBeenCalled();
  });

  it('re-enables after a failure', async () => {
    api.categories.create.mockRejectedValueOnce(new Error('nope'));
    const user = userEvent.setup();
    render(<CreateCategoryModal onClose={() => {}} onCreated={() => {}} />);
    await user.type(screen.getByPlaceholderText('e.g. Lead Source'), 'Industry');
    await user.click(screen.getByRole('button', { name: /Create/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create/ })).toBeEnabled();
  });

  it('requires a name', async () => {
    const user = userEvent.setup();
    render(<CreateCategoryModal onClose={() => {}} onCreated={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Create/ }));
    expect(api.categories.create).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
