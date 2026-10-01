import { LessonEnvelopeSchema } from './envelope';
import { BLOCK_REGISTRY } from './registry';
import type { BlockType } from './index.js';

const knownBlockType = (type: string): type is BlockType => Object.hasOwn(BLOCK_REGISTRY, type);
function validBlocks(input: unknown): Array<{ type: BlockType; props: Record<string, unknown> }> {
  try {
    const parsed = LessonEnvelopeSchema.safeParse(input);
    if (!parsed.success) return [];
    return parsed.data.blocks.flatMap((block) => {
      if (!knownBlockType(block.type)) return [];
      const props = BLOCK_REGISTRY[block.type].schema.safeParse(block.props);
      return props.success ? [{ type: block.type, props: props.data as Record<string, unknown> }] : [];
    });
  } catch {
    return [];
  }
}

export function countRenderableBlocks(content: unknown): number {
  return validBlocks(content).filter(({ type, props }) => {
    if (type === 'heading') return typeof props.text === 'string' && props.text.trim().length > 0;
    if (type === 'bulletList' || type === 'numberedList') {
      return Array.isArray(props.items) && props.items.some((item) => typeof item === 'string' && item.trim().length > 0);
    }
    return true;
  }).length;
}

export function collectImageAssetIds(content: unknown): string[] {
  const ids = new Set<string>();
  for (const { type, props } of validBlocks(content)) {
    if (type === 'image' && typeof props.assetId === 'string') ids.add(props.assetId);
  }
  return [...ids];
}

function plain(value: string): string {
  const escaped: string[] = [];
  const protectedValue = value.replace(/\\([\\`*{}\[\]()#+\-.!_>=])/g, (_match, char: string) => {
    const token = `\u0000${escaped.length}\u0000`;
    escaped.push(char);
    return token;
  });
  return protectedValue
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/gs, '$1')
    .replace(/\*(.*?)\*/gs, '$1')
    .replace(/==(.*?)==/gs, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => escaped[Number(index)] ?? '');
}

export function blocksToPlainText(content: unknown): string {
  const lines: string[] = [];
  for (const { type, props } of validBlocks(content)) {
    const add = (value: unknown) => { if (typeof value === 'string') lines.push(plain(value)); };
    switch (type) {
      case 'heading': case 'paragraph': add(props.text); break;
      case 'bulletList': case 'numberedList':
        if (Array.isArray(props.items)) props.items.forEach(add);
        break;
      case 'code': add(props.code); add(props.description); break;
      case 'step': add(props.title); add(props.body); break;
      case 'callout': add(props.title); add(props.body); break;
      case 'table':
        if (Array.isArray(props.columns)) props.columns.forEach(add);
        if (Array.isArray(props.rows)) props.rows.forEach((row) => { if (Array.isArray(row)) row.forEach(add); });
        break;
      case 'image': add(props.alt); add(props.caption); break;
      case 'resourceLink': add(props.title); add(props.description); break;
      case 'divider': break;
      case 'annotatedCode':
        add(props.title); add(props.fileLabel);
        if (Array.isArray(props.steps)) props.steps.forEach((step) => {
          if (typeof step === 'object' && step !== null) {
            const item = step as Record<string, unknown>;
            add(item.label); add(item.code); add(item.explanationTitle); add(item.explanation);
            if (Array.isArray(item.terms)) item.terms.forEach((term) => {
              if (typeof term === 'object' && term !== null) { add((term as Record<string, unknown>).term); add((term as Record<string, unknown>).description); }
            });
          }
        });
        break;
      case 'diagram':
        add(props.title);
        if (Array.isArray(props.nodes)) props.nodes.forEach((node) => {
          if (typeof node === 'object' && node !== null) { add((node as Record<string, unknown>).title); add((node as Record<string, unknown>).description); }
        });
        if (Array.isArray(props.connections)) props.connections.forEach((connection) => {
          if (typeof connection === 'object' && connection !== null) add((connection as Record<string, unknown>).label);
        });
        break;
    }
  }
  return lines.join('\n');
}
