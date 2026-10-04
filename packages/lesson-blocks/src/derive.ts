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

const escapableInlineChars = new Set('\\`*{}[]()#+-.!_>=');

function countRun(value: string, start: number, char: string): number {
  let end = start;
  while (value[end] === char) end++;
  return end - start;
}

function findInlineCodeEnd(value: string, start: number, delimiterLength: number): number {
  for (let index = start; index < value.length;) {
    if (value[index] === '`') {
      const runLength = countRun(value, index, '`');
      if (runLength === delimiterLength) return index;
      index += runLength;
      continue;
    }
    index++;
  }
  return -1;
}

function findLinkEnd(value: string, start: number): { labelEnd: number; end: number } | undefined {
  let labelEnd = -1;
  for (let index = start + 1; index < value.length;) {
    if (value[index] === '\\') {
      const runLength = countRun(value, index, '\\');
      index += runLength;
      if (runLength % 2 === 1) index++;
      continue;
    }
    if (value[index] === '`') {
      const runLength = countRun(value, index, '`');
      const codeEnd = findInlineCodeEnd(value, index + runLength, runLength);
      index = codeEnd < 0 ? index + runLength : codeEnd + runLength;
      continue;
    }
    if (value[index] === ']') { labelEnd = index; break; }
    index++;
  }
  if (labelEnd < 0 || value[labelEnd + 1] !== '(') return undefined;
  let depth = 1;
  for (let index = labelEnd + 2; index < value.length;) {
    if (value[index] === '\\') {
      const runLength = countRun(value, index, '\\');
      index += runLength;
      if (runLength % 2 === 1) index++;
      continue;
    }
    if (value[index] === '(') depth++;
    if (value[index] === ')' && --depth === 0) return { labelEnd, end: index + 1 };
    index++;
  }
  return undefined;
}

function findMarkEnd(value: string, delimiter: string, start: number): number {
  for (let index = start; index < value.length;) {
    if (value[index] === '\\') {
      const runLength = countRun(value, index, '\\');
      index += runLength;
      if (runLength % 2 === 1) index++;
      continue;
    }
    if (value[index] === '`') {
      const runLength = countRun(value, index, '`');
      const closing = findInlineCodeEnd(value, index + runLength, runLength);
      index = closing < 0 ? index + runLength : closing + runLength;
      continue;
    }
    if (value.startsWith(delimiter, index)) return index;
    index++;
  }
  return -1;
}

function plain(value: string, links?: string[]): string {
  let output = '';
  for (let index = 0; index < value.length;) {
    const char = value[index];
    if (char === '\\') {
      const runLength = countRun(value, index, '\\');
      output += '\\'.repeat(Math.floor(runLength / 2));
      index += runLength;
      if (runLength % 2 === 1) {
        if (index < value.length && escapableInlineChars.has(value[index])) output += value[index++];
        else output += '\\';
      }
      continue;
    }
    if (char === '`') {
      const delimiterLength = countRun(value, index, '`');
      const end = findInlineCodeEnd(value, index + delimiterLength, delimiterLength);
      if (end >= 0) {
        output += value.slice(index + delimiterLength, end);
        index = end + delimiterLength;
        continue;
      }
      output += '`'.repeat(delimiterLength);
      index += delimiterLength;
      continue;
    }
    if (char === '[') {
      const link = findLinkEnd(value, index);
      if (link) {
        links?.push(value.slice(link.labelEnd + 2, link.end - 1));
        output += plain(value.slice(index + 1, link.labelEnd), links);
        index = link.end;
        continue;
      }
    }
    const delimiter = value.startsWith('**', index) ? '**'
      : value.startsWith('==', index) ? '=='
        : char === '*' && value[index + 1] !== '*' && (index === 0 || value[index - 1] !== '*') ? '*'
          : undefined;
    if (delimiter) {
      const end = findMarkEnd(value, delimiter, index + delimiter.length);
      if (end >= 0) {
        output += plain(value.slice(index + delimiter.length, end), links);
        index = end + delimiter.length;
        continue;
      }
    }
    output += char;
    index++;
  }
  return output;
}

function blockLines(type: BlockType, props: Record<string, unknown>, links?: string[]): string[] {
  const lines: string[] = [];
  const add = (value: unknown) => { if (typeof value === 'string') lines.push(plain(value, links)); };
  const addRaw = (value: unknown) => { if (typeof value === 'string') lines.push(value); };
  switch (type) {
    case 'heading': case 'paragraph': add(props.text); break;
    case 'bulletList': case 'numberedList':
      if (Array.isArray(props.items)) props.items.forEach(add);
      break;
    case 'code': addRaw(props.code); add(props.description); break;
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
          add(item.label); addRaw(item.code); add(item.explanationTitle); add(item.explanation);
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
  return lines;
}

export function blocksToPlainText(content: unknown): string {
  return validBlocks(content).flatMap(({ type, props }) => blockLines(type, props)).join('\n');
}

/** 一个块的行内文本里出现的 Markdown 链接目标（代码片段内的不算）。 */
export function collectInlineLinkTargets(type: BlockType, props: Record<string, unknown>): string[] {
  const links: string[] = [];
  blockLines(type, props, links);
  return links;
}
