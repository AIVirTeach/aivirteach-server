import {
  BLOCK_REGISTRY,
  type BlockType,
  type LessonBlock,
} from '@aivirteach/lesson-blocks';
export type EditorState = {
  blocks: LessonBlock[];
  selectedId: string | null;
  past: LessonBlock[][];
  future: LessonBlock[][];
};
export type EditorAction =
  | { type: 'add'; blockType: BlockType }
  | { type: 'duplicate' | 'remove' | 'select'; id: string }
  | { type: 'move'; id: string; direction: -1 | 1 }
  | { type: 'update'; id: string; props: unknown }
  | { type: 'patch'; id: string; props: Record<string, unknown> }
  | { type: 'undo' }
  | { type: 'redo' };
export function reduce(
  state: EditorState,
  action: EditorAction,
  ids = () => `b-${crypto.randomUUID()}`,
): EditorState {
  if (action.type === 'select') return { ...state, selectedId: action.id };
  if (action.type === 'undo' || action.type === 'redo') {
    const from = action.type === 'undo' ? state.past : state.future;
    if (!from.length) return state;
    return {
      ...state,
      blocks: from.at(-1)!,
      selectedId: null,
      past:
        action.type === 'undo'
          ? state.past.slice(0, -1)
          : [...state.past, state.blocks].slice(-50),
      future:
        action.type === 'redo'
          ? state.future.slice(0, -1)
          : [...state.future, state.blocks],
    };
  }
  let blocks = [...state.blocks];
  let selectedId = state.selectedId;
  if (action.type === 'add') {
    if (blocks.length >= 300) return state;
    const block = {
      id: ids(),
      type: action.blockType,
      props: BLOCK_REGISTRY[action.blockType].defaultProps(),
    };
    blocks.push(block);
    selectedId = block.id;
  } else {
    const index = blocks.findIndex((b) => b.id === action.id);
    if (index < 0) return state;
    if (action.type === 'duplicate') {
      if (blocks.length >= 300) return state;
      const copy = { ...structuredClone(blocks[index]), id: ids() };
      blocks.splice(index + 1, 0, copy);
      selectedId = copy.id;
    }
    if (action.type === 'remove') {
      blocks.splice(index, 1);
      if (selectedId === action.id) selectedId = null;
    }
    if (action.type === 'update')
      blocks[index] = { ...blocks[index], props: action.props };
    if (action.type === 'patch') {
      const current = blocks[index].props;
      blocks[index] = {
        ...blocks[index],
        props: {
          ...(typeof current === 'object' && current !== null ? current : {}),
          ...action.props,
        },
      };
    }
    if (action.type === 'move') {
      const next = index + action.direction;
      if (next < 0 || next >= blocks.length) return state;
      [blocks[index], blocks[next]] = [blocks[next], blocks[index]];
    }
  }
  return {
    blocks,
    selectedId,
    past: [...state.past, state.blocks].slice(-50),
    future: [],
  };
}
