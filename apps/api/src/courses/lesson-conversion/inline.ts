import type { PhrasingContent } from 'mdast';
import type { ConversionIssue } from './markdown-to-blocks';

const escapeLiteral = (value: string) => value.replace(/[\\*`[\]=]/g, '\\$&');

function textOf(node: PhrasingContent): string {
  if (
    node.type === 'text' ||
    node.type === 'inlineCode' ||
    node.type === 'html'
  )
    return node.value;
  if (node.type === 'image' || node.type === 'imageReference')
    return node.alt ?? '';
  if (node.type === 'footnoteReference') return node.label ?? node.identifier;
  if ('children' in node)
    return node.children.map((child) => textOf(child)).join('');
  return '';
}

function convertNode(node: PhrasingContent): string {
  switch (node.type) {
    case 'text': {
      const parts: string[] = [];
      const highlight = /==([^=\n]+)==/g;
      let cursor = 0;
      for (const match of node.value.matchAll(highlight)) {
        const start = match.index ?? 0;
        parts.push(
          escapeLiteral(node.value.slice(cursor, start)),
          `**${escapeLiteral(match[1])}**`,
        );
        cursor = start + match[0].length;
      }
      parts.push(escapeLiteral(node.value.slice(cursor)));
      return parts.join('');
    }
    case 'strong':
      return `**${node.children.map(convertNode).join('')}**`;
    case 'emphasis':
      return `*${node.children.map(convertNode).join('')}*`;
    case 'inlineCode': {
      const ticks = '`'.repeat(
        Math.max(
          1,
          Math.max(
            0,
            ...[...node.value.matchAll(/`+/g)].map((match) => match[0].length),
          ) + 1,
        ),
      );
      return `${ticks}${node.value}${ticks}`;
    }
    case 'link': {
      const label = node.children.map(convertNode).join('');
      return /^(https?:|mailto:)/i.test(node.url)
        ? `[${label}](${node.url})`
        : node.children.map((child) => escapeLiteral(textOf(child))).join('');
    }
    case 'break':
      return '\n';
    default:
      return escapeLiteral(textOf(node));
  }
}

export function inlineToMarkdownSubset(
  nodes: PhrasingContent[],
  report: ConversionIssue[],
): string {
  void report;
  return nodes.map(convertNode).join('');
}
