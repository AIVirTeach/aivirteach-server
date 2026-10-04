import type { Nodes, PhrasingContent } from 'mdast';
import type { LessonContent, LessonBlock } from '@aivirteach/lesson-blocks';
import { validateLessonContent } from '@aivirteach/lesson-blocks';
import { inlineToMarkdownSubset } from './inline';
import { storeConversionComparisonMetadata } from './comparison-metadata';

export type ConversionIssue = {
  level: 'warning' | 'error';
  code: string;
  message: string;
  line?: number;
};

export type ConversionResult = {
  content: LessonContent;
  report: ConversionIssue[];
  dropped: string[];
};

type Context = { assetIdsByFilename: ReadonlyMap<string, string> };

export async function convertMarkdownToBlocks(
  markdown: string,
  ctx: Context,
): Promise<ConversionResult> {
  // Keep parser packages out of API startup; they are loaded only for conversion.
  const [
    { unified },
    { default: remarkParse },
    { default: remarkGfm },
    { toString },
  ] = await Promise.all([
    import('unified'),
    import('remark-parse'),
    import('remark-gfm'),
    import('mdast-util-to-string'),
  ]);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const report: ConversionIssue[] = [];
  const dropped: string[] = [];
  const generatedTextByBlockId: Record<string, string[]> = {};
  const blocks: LessonBlock[] = [];
  const append = (type: string, props: unknown) => {
    const id = `b-${String(blocks.length + 1).padStart(3, '0')}`;
    blocks.push({ id, type, props });
    return id;
  };
  const plainText = (node: Nodes) => toString(node).trim();
  const withoutImages = (
    node: PhrasingContent,
  ): PhrasingContent | undefined => {
    if (node.type === 'image' || node.type === 'imageReference')
      return undefined;
    if ('children' in node) {
      return {
        ...node,
        children: node.children
          .map((child) => withoutImages(child))
          .filter(Boolean),
      } as PhrasingContent;
    }
    return node;
  };
  const inline = (children: PhrasingContent[]) =>
    inlineToMarkdownSubset(
      children
        .map(withoutImages)
        .filter((child): child is PhrasingContent => child !== undefined),
      report,
    );
  const assetDefinitions = new Map(
    tree.children.flatMap((node) =>
      node.type === 'definition' ? [[node.identifier, node.url] as const] : [],
    ),
  );
  type ImageNode = Extract<Nodes, { type: 'image' | 'imageReference' }>;
  const imageBlock = (
    node: ImageNode,
    options: { altRetainedInParent?: boolean; relocated?: boolean } = {},
  ) => {
    const url =
      node.type === 'image'
        ? node.url
        : (assetDefinitions.get(node.identifier) ?? node.identifier);
    const filename = url.split(/[\\/]/).filter(Boolean).at(-1) || url;
    if (options.relocated) {
      report.push({
        level: 'warning',
        code: 'image-relocated',
        message: `表格单元格只能保存文字，图片已移至表格之后：${filename}`,
        line: node.position?.start.line,
      });
    }
    const sourceAlt = node.alt?.trim() ?? '';
    const generatedAlt = !sourceAlt;
    const alt = sourceAlt || filename;
    if (generatedAlt) {
      report.push({
        level: 'warning',
        code: 'empty-alt-defaulted',
        message: `图片缺少替代文字，已使用文件名：${filename}`,
        line: node.position?.start.line,
      });
    }
    const assetId = ctx.assetIdsByFilename.get(filename);
    if (!assetId) {
      report.push({
        level: 'warning',
        code: 'missing-asset',
        message: `找不到图片素材：${filename}`,
        line: node.position?.start.line,
      });
      const label = `[图片缺失：${filename}]`;
      const placeholderId = append('paragraph', {
        text: `${label}${alt && !options.altRetainedInParent ? ` ${alt}` : ''}`,
      });
      generatedTextByBlockId[placeholderId] = [
        label,
        ...(generatedAlt && !options.altRetainedInParent ? [` ${alt}`] : []),
      ];
      return;
    }
    const imageId = append('image', { assetId, alt });
    if (generatedAlt || options.altRetainedInParent)
      generatedTextByBlockId[imageId] = [alt];
  };
  const nestedImages = (node: Nodes): ImageNode[] => {
    if (node.type === 'image' || node.type === 'imageReference') return [node];
    if ('children' in node)
      return node.children.flatMap((child) => nestedImages(child as Nodes));
    return [];
  };
  type PhrasingUnit =
    | { kind: 'inline'; node: PhrasingContent }
    | { kind: 'image'; node: ImageNode };
  const splitPhrasing = (node: PhrasingContent): PhrasingUnit[] => {
    if (node.type === 'image' || node.type === 'imageReference')
      return [{ kind: 'image', node }];
    if (!('children' in node)) return [{ kind: 'inline', node }];
    const units: PhrasingUnit[] = [];
    let segment: PhrasingContent[] = [];
    const flush = () => {
      if (segment.length)
        units.push({
          kind: 'inline',
          node: { ...node, children: segment } as PhrasingContent,
        });
      segment = [];
    };
    for (const child of node.children) {
      for (const unit of splitPhrasing(child)) {
        if (unit.kind === 'image') {
          flush();
          units.push(unit);
        } else {
          segment.push(unit.node);
        }
      }
    }
    flush();
    return units;
  };
  const emitNestedImages = (node: Nodes) =>
    nestedImages(node).forEach((image) => imageBlock(image));
  type ContentUnit =
    { kind: 'text'; text: string } | { kind: 'image'; node: ImageNode };
  const phrasingUnits = (children: PhrasingContent[]): ContentUnit[] =>
    children
      .flatMap(splitPhrasing)
      .map((unit) =>
        unit.kind === 'image'
          ? { kind: 'image', node: unit.node }
          : { kind: 'text', text: inline([unit.node]) },
      );
  const contentUnits = (node: Nodes): ContentUnit[] => {
    if (node.type === 'paragraph' || node.type === 'heading')
      return phrasingUnits(node.children);
    if (node.type === 'code')
      return node.value ? [{ kind: 'text', text: node.value }] : [];
    if (node.type === 'html') {
      const text = node.value.replace(/<[^>]*>/g, '').trim();
      return text ? [{ kind: 'text', text }] : [];
    }
    if (node.type === 'table') {
      return node.children.flatMap((row, rowIndex) => [
        ...(rowIndex ? [{ kind: 'text' as const, text: '\n' }] : []),
        ...row.children.flatMap((cell, cellIndex) => [
          ...(cellIndex ? [{ kind: 'text' as const, text: ' | ' }] : []),
          ...phrasingUnits(cell.children),
        ]),
      ]);
    }
    if ('children' in node)
      return node.children.flatMap((child, index) => [
        ...(index ? [{ kind: 'text' as const, text: '\n' }] : []),
        ...contentUnits(child as Nodes),
      ]);
    const text = plainText(node);
    return text ? [{ kind: 'text', text }] : [];
  };
  const unmappedText = (node: Nodes) => {
    const text =
      node.type === 'html'
        ? node.value.replace(/<[^>]*>/g, '').trim()
        : plainText(node);
    // 纯标签的原始 HTML（如 Notion 导出的 <aside>）没有可见文字：不生成块，也不塞原文里没有的占位文字。
    if (text || node.type !== 'html') {
      append('paragraph', { text: text || '（未映射内容）' });
    }
    report.push({
      level: 'warning',
      code: 'unmapped-node',
      message: `未映射的 Markdown 节点：${node.type}`,
      line: node.position?.start.line,
    });
  };

  for (const node of tree.children) {
    if (node.type === 'heading') {
      const text = inline(node.children).trim();
      if (node.depth === 1) {
        dropped.push(text);
        report.push({
          level: 'warning',
          code: 'h1-dropped',
          message: '一级标题不会转换为课时内容块。',
          line: node.position?.start.line,
        });
      } else {
        append('heading', { level: node.depth === 2 ? 2 : 3, text });
      }
      emitNestedImages(node);
    } else if (node.type === 'thematicBreak') {
      append('divider', {});
    } else if (node.type === 'code') {
      const language = node.lang || undefined;
      const terminalLanguages = new Set([
        'bash',
        'sh',
        'shell',
        'console',
        'zsh',
      ]);
      append('code', {
        kind:
          language && terminalLanguages.has(language) ? 'terminal' : 'plain',
        code: node.value,
        ...(language ? { language } : {}),
      });
    } else if (node.type === 'table') {
      // Table cells cannot contain blocks: keep alt text at its original cell position and place media immediately after this table.
      const rows = node.children.map((row) =>
        row.children.map((cell) =>
          inlineToMarkdownSubset(cell.children, report).trim(),
        ),
      );
      append('table', { columns: rows[0] ?? [], rows: rows.slice(1) });
      nestedImages(node).forEach((image) =>
        imageBlock(image, { altRetainedInParent: true, relocated: true }),
      );
    } else if (node.type === 'list') {
      type ListUnit =
        { kind: 'item'; text: string } | { kind: 'image'; node: ImageNode };
      const units: ListUnit[] = [];
      let flattenedNestedList = false;
      const addParagraph = (children: PhrasingContent[]) => {
        let text = '';
        const flushText = () => {
          if (text.trim()) units.push({ kind: 'item', text: text.trim() });
          text = '';
        };
        for (const unit of phrasingUnits(children)) {
          if (unit.kind === 'image') {
            flushText();
            units.push(unit);
          } else {
            text += unit.text;
          }
        }
        flushText();
      };
      const visitListItem = (item: Extract<Nodes, { type: 'listItem' }>) => {
        for (const child of item.children) {
          if (child.type === 'list') {
            flattenedNestedList = true;
            child.children.forEach(visitListItem);
          } else if (child.type === 'paragraph') {
            addParagraph(child.children);
          } else {
            for (const unit of contentUnits(child)) {
              if (unit.kind === 'image') units.push(unit);
              else if (unit.text.trim())
                units.push({ kind: 'item', text: unit.text.trim() });
            }
          }
        }
      };
      node.children.forEach(visitListItem);
      let items: string[] = [];
      const flushItems = () => {
        if (items.length)
          append(node.ordered ? 'numberedList' : 'bulletList', { items });
        items = [];
      };
      for (const unit of units) {
        if (unit.kind === 'image') {
          flushItems();
          report.push({
            level: 'warning',
            code: 'list-image-split',
            message:
              '列表中的图片无法嵌入列表项，将转换为独立图片块或缺图占位段落；列表结构可能变化。',
            line: unit.node.position?.start.line,
          });
          imageBlock(unit.node);
        } else {
          items.push(unit.text);
        }
      }
      flushItems();
      if (flattenedNestedList) {
        report.push({
          level: 'warning',
          code: 'nested-list-flattened',
          message: '嵌套列表已拍平。',
          line: node.position?.start.line,
        });
      }
    } else if (node.type === 'paragraph') {
      let phrasing: PhrasingContent[] = [];
      const flush = (preserveBoundaryWhitespace = false) => {
        const inlineText = inline(phrasing);
        const text = preserveBoundaryWhitespace
          ? inlineText
          : inlineText.trim();
        if (text.trim()) append('paragraph', { text });
        phrasing = [];
      };
      for (const unit of node.children.flatMap(splitPhrasing)) {
        if (unit.kind === 'image') {
          flush(true);
          imageBlock(unit.node);
        } else {
          phrasing.push(unit.node);
        }
      }
      flush();
    } else if (node.type === 'blockquote') {
      let body = '';
      const flushCallout = () => {
        const text = body.trim();
        if (text) append('callout', { variant: 'note', body: text });
        body = '';
      };
      for (const unit of contentUnits(node)) {
        if (unit.kind === 'image') {
          flushCallout();
          imageBlock(unit.node);
        } else {
          body += unit.text;
        }
      }
      flushCallout();
    } else if (node.type === 'definition') {
      continue;
    } else if (node.type === 'html') {
      unmappedText(node);
    } else {
      unmappedText(node);
    }
  }

  const content: LessonContent = { schemaVersion: 1, blocks };
  const validation = validateLessonContent(content, {
    courseAssetIds: new Set(ctx.assetIdsByFilename.values()),
  });
  for (const problem of validation.errors)
    report.push({
      level: 'error',
      code: 'invalid-output',
      message: problem.message,
    });
  const result: ConversionResult = { content, report, dropped };
  storeConversionComparisonMetadata(result, generatedTextByBlockId);
  return result;
}
