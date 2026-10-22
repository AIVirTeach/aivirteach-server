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
  uploads: Record<string, string>;
};
export type EditorAction =
  | { type: 'add'; blockType: BlockType }
  | { type: 'duplicate' | 'remove' | 'select'; id: string }
  | { type: 'move'; id: string; direction: -1 | 1 }
  | { type: 'update'; id: string; props: unknown }
  | { type: 'patch'; id: string; props: Record<string, unknown> }
  | { type: 'start-upload'; id: string; requestId: string }
  | {
      type: 'finish-upload';
      id: string;
      requestId: string;
      assetId: string | null;
    }
  | { type: 'undo' }
  | { type: 'redo' };
export function reduce(
  state: EditorState,
  action: EditorAction,
  ids = () => `b-${crypto.randomUUID()}`,
): EditorState {
  if (action.type === 'start-upload') {
    if (
      !state.blocks.some(
        (block) => block.id === action.id && block.type === 'image',
      )
    )
      return state;
    return {
      ...state,
      uploads: { ...state.uploads, [action.id]: action.requestId },
    };
  }
  if (action.type === 'finish-upload') {
    if (state.uploads[action.id] !== action.requestId) return state;
    const uploads = { ...state.uploads };
    delete uploads[action.id];
    const next = { ...state, uploads };
    return action.assetId === null
      ? next
      : reduce(next, {
          type: 'patch',
          id: action.id,
          props: { assetId: action.assetId },
        });
  }
  if (action.type === 'select') return { ...state, selectedId: action.id };
  if (action.type === 'undo' || action.type === 'redo') {
    const from = action.type === 'undo' ? state.past : state.future;
    if (!from.length) return state;
    return {
      ...state,
      blocks: from.at(-1)!,
      uploads: {},
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
  const uploads = { ...state.uploads };
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
      delete uploads[action.id];
      blocks.splice(index, 1);
      if (selectedId === action.id) selectedId = null;
    }
    if (action.type === 'update') {
      if (
        blocks[index].type === 'image' &&
        assetId(blocks[index].props) !== assetId(action.props)
      )
        delete uploads[action.id];
      blocks[index] = { ...blocks[index], props: action.props };
    }
    if (action.type === 'patch') {
      if (Object.hasOwn(action.props, 'assetId')) delete uploads[action.id];
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
    uploads,
    blocks,
    selectedId,
    past: [...state.past, state.blocks].slice(-50),
    future: [],
  };
}

function assetId(props: unknown): unknown {
  return typeof props === 'object' && props !== null && 'assetId' in props
    ? props.assetId
    : undefined;
}
