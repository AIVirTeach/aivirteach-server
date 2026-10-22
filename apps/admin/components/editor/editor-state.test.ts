import { describe, it, expect } from 'vitest';
import { reduce, type EditorState } from './editor-state';
const empty = (): EditorState => ({
  blocks: [],
  selectedId: null,
  past: [],
  future: [],
  uploads: {},
});
describe('block editing', () => {
  it('creates independent copies, reorders, removes and restores with undo', () => {
    let s = reduce(empty(), { type: 'add', blockType: 'paragraph' }, () => 'a');
    s = reduce(s, { type: 'duplicate', id: 'a' }, () => 'b');
    expect(s.blocks.map((b) => b.id)).toEqual(['a', 'b']);
    s = reduce(s, { type: 'move', id: 'b', direction: -1 });
    expect(s.blocks.map((b) => b.id)).toEqual(['b', 'a']);
    s = reduce(s, { type: 'remove', id: 'b' });
    expect(s.selectedId).toBeNull();
    s = reduce(s, { type: 'undo' });
    expect(s.blocks.map((b) => b.id)).toEqual(['b', 'a']);
  });
  it('retains 50 undo states and invalidates redo on editing', () => {
    let s = reduce(empty(), { type: 'add', blockType: 'paragraph' }, () => 'a');
    for (let i = 0; i < 60; i++)
      s = reduce(s, { type: 'update', id: 'a', props: { text: String(i) } });
    expect(s.past).toHaveLength(50);
    s = reduce(s, { type: 'undo' });
    expect(s.future).toHaveLength(1);
    s = reduce(s, { type: 'update', id: 'a', props: { text: 'new' } });
    expect(s.future).toHaveLength(0);
  });
  it('blocks the 301st block and ignores out of range moves', () => {
    const s = {
      ...empty(),
      blocks: Array.from({ length: 300 }, (_, i) => ({
        id: String(i),
        type: 'divider',
        props: {},
      })),
    };
    expect(reduce(s, { type: 'add', blockType: 'divider' })).toBe(s);
    expect(reduce(s, { type: 'duplicate', id: '0' })).toBe(s);
    expect(reduce(s, { type: 'move', id: '0', direction: -1 })).toBe(s);
  });
});

it('applies an upload result only to assetId while preserving edits made during upload', () => {
  let state = reduce(
    empty(),
    { type: 'add', blockType: 'image' },
    () => 'image',
  );
  state = reduce(state, {
    type: 'update',
    id: 'image',
    props: { assetId: '', alt: 'new alt', caption: 'new caption' },
  });
  state = reduce(state, {
    type: 'patch',
    id: 'image',
    props: { assetId: 'uploaded' },
  });
  expect(state.blocks[0].props).toEqual({
    assetId: 'uploaded',
    alt: 'new alt',
    caption: 'new caption',
  });
});

describe('image upload ownership', () => {
  function uploading() {
    return reduce(
      reduce(empty(), { type: 'add', blockType: 'image' }, () => 'image'),
      { type: 'start-upload', id: 'image', requestId: 'old' },
    );
  }
  it('ignores a late upload after manual selection, including selecting the original value', () => {
    const state = reduce(uploading(), {
      type: 'patch',
      id: 'image',
      props: { assetId: '' },
    });
    expect(
      reduce(state, {
        type: 'finish-upload',
        id: 'image',
        requestId: 'old',
        assetId: 'late',
      }),
    ).toBe(state);
  });
  it('only accepts the newest upload and preserves caption edits', () => {
    let state = reduce(uploading(), {
      type: 'start-upload',
      id: 'image',
      requestId: 'new',
    });
    state = reduce(state, {
      type: 'update',
      id: 'image',
      props: { assetId: '', alt: 'diagram', caption: 'new caption' },
    });
    expect(
      reduce(state, {
        type: 'finish-upload',
        id: 'image',
        requestId: 'old',
        assetId: 'stale',
      }),
    ).toBe(state);
    state = reduce(state, {
      type: 'finish-upload',
      id: 'image',
      requestId: 'new',
      assetId: 'new-image',
    });
    expect(state.blocks[0].props).toEqual({
      assetId: 'new-image',
      alt: 'diagram',
      caption: 'new caption',
    });
    expect(state.uploads).toEqual({});
    state = reduce(state, { type: 'undo' });
    expect(state.blocks[0].props).toEqual({
      assetId: '',
      alt: 'diagram',
      caption: 'new caption',
    });
  });
  it('does not revive an upload when deletion is undone', () => {
    let state = reduce(uploading(), { type: 'remove', id: 'image' });
    state = reduce(state, { type: 'undo' });
    expect(state.blocks).toHaveLength(1);
    expect(
      reduce(state, {
        type: 'finish-upload',
        id: 'image',
        requestId: 'old',
        assetId: 'late',
      }),
    ).toBe(state);
  });
  it('clears upload ownership on undo and redo without adding upload steps to history', () => {
    let state = uploading();
    expect(state.past).toHaveLength(1);
    state = reduce(state, { type: 'undo' });
    state = reduce(state, { type: 'redo' });
    expect(
      reduce(state, {
        type: 'finish-upload',
        id: 'image',
        requestId: 'old',
        assetId: 'late',
      }),
    ).toBe(state);
  });
});
