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

// 链接标签/目标的最大扫描长度：没有上限时，大量未闭合的 `[` 会让每个 `[` 都扫到文末，整体变成二次复杂度。
const MAX_LINK_LABEL = 500;
const MAX_LINK_TARGET = 2000;
// 单个字符串里所有链接扫描的总步数预算；正常内容远用不完，病态输入（成千上万个未闭合的 `[`）超出后
// 不再识别链接，并标记 exceeded，由校验当作错误处理，保证耗时有上界。
const LINK_SCAN_BUDGET = 50_000;

type LinkScan = { links?: string[]; budget: number; exceeded: boolean; fieldPath?: (string | number)[] };

function findLinkEnd(value: string, start: number, scan: LinkScan): { labelEnd: number; end: number } | undefined {
  let labelEnd = -1;
  for (let index = start + 1; index < Math.min(value.length, start + 1 + MAX_LINK_LABEL);) {
    if (--scan.budget < 0) { scan.exceeded = true; return undefined; }
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
  for (let index = labelEnd + 2; index < Math.min(value.length, labelEnd + 2 + MAX_LINK_TARGET);) {
    if (--scan.budget < 0) { scan.exceeded = true; return undefined; }
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

function plain(value: string, scan: LinkScan): string {
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
      const link = findLinkEnd(value, index, scan);
      if (link) {
        scan.links?.push(value.slice(link.labelEnd + 2, link.end - 1));
        output += plain(value.slice(index + 1, link.labelEnd), scan);
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
        output += plain(value.slice(index + delimiter.length, end), scan);
        index = end + delimiter.length;
        continue;
      }
    }
    output += char;
    index++;
  }
  return output;
}

function blockLines(type: BlockType, props: Record<string, unknown>, scans?: LinkScan[]): string[] {
  const lines: string[] = [];
  const add = (value: unknown, fieldPath: (string | number)[]) => {
    if (typeof value !== 'string') return;
    const scan: LinkScan = { links: scans ? [] : undefined, budget: LINK_SCAN_BUDGET, exceeded: false, fieldPath };
    lines.push(plain(value, scan));
    scans?.push(scan);
  };
  const addRaw = (value: unknown) => { if (typeof value === 'string') lines.push(value); };
  const field = (key: string) => add(props[key], [key]);
  switch (type) {
    case 'heading': case 'paragraph': field('text'); break;
    case 'bulletList': case 'numberedList':
      if (Array.isArray(props.items)) props.items.forEach((value, index) => add(value, ['items', index]));
      break;
    case 'code': addRaw(props.code); field('description'); break;
    case 'step': field('title'); field('body'); break;
    case 'callout': field('title'); field('body'); break;
    case 'table':
      if (Array.isArray(props.columns)) props.columns.forEach((value, index) => add(value, ['columns', index]));
      if (Array.isArray(props.rows)) props.rows.forEach((row, rowIndex) => { if (Array.isArray(row)) row.forEach((value, columnIndex) => add(value, ['rows', rowIndex, columnIndex])); });
      break;
    case 'image': field('alt'); field('caption'); break;
    case 'resourceLink': field('title'); field('description'); break;
    case 'divider': break;
    case 'annotatedCode':
      field('title'); field('fileLabel');
      if (Array.isArray(props.steps)) props.steps.forEach((step, index) => {
        if (typeof step === 'object' && step !== null) {
          const item = step as Record<string, unknown>;
          add(item.label, ['steps', index, 'label']); addRaw(item.code);
          add(item.explanationTitle, ['steps', index, 'explanationTitle']); add(item.explanation, ['steps', index, 'explanation']);
          if (Array.isArray(item.terms)) item.terms.forEach((term, termIndex) => {
            if (typeof term === 'object' && term !== null) {
              const value = term as Record<string, unknown>;
              add(value.term, ['steps', index, 'terms', termIndex, 'term']);
              add(value.description, ['steps', index, 'terms', termIndex, 'description']);
            }
          });
        }
      });
      break;
    case 'diagram':
      field('title');
      if (Array.isArray(props.nodes)) props.nodes.forEach((node, index) => {
        if (typeof node === 'object' && node !== null) {
          const value = node as Record<string, unknown>;
          add(value.title, ['nodes', index, 'title']); add(value.description, ['nodes', index, 'description']);
        }
      });
      if (Array.isArray(props.connections)) props.connections.forEach((connection, index) => {
        if (typeof connection === 'object' && connection !== null) add((connection as Record<string, unknown>).label, ['connections', index, 'label']);
      });
      break;
  }
  return lines;
}

export function blocksToPlainText(content: unknown): string {
  return validBlocks(content).flatMap(({ type, props }) => blockLines(type, props)).join('\n');
}

/**
 * 一个块的行内文本里出现的 Markdown 链接目标（代码片段内的不算）。
 * complete=false 表示某个字符串的链接扫描超出了预算，目标列表可能不全，调用方应当按错误处理。
 */
export function collectInlineLinkTargets(type: BlockType, props: Record<string, unknown>): {
  targets: string[];
  sources: { target: string; fieldPath: (string | number)[] }[];
  incompleteFieldPaths: (string | number)[][];
  complete: boolean;
} {
  const scans: LinkScan[] = [];
  blockLines(type, props, scans);
  return {
    targets: scans.flatMap((scan) => scan.links ?? []),
    sources: scans.flatMap((scan) => (scan.links ?? []).map((target) => ({ target, fieldPath: scan.fieldPath ?? [] }))),
    incompleteFieldPaths: scans.filter((scan) => scan.exceeded).map((scan) => scan.fieldPath ?? []),
    complete: scans.every((scan) => !scan.exceeded),
  };
}
