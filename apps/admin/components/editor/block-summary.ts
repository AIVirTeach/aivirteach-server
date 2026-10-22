import type { LessonBlock } from '@aivirteach/lesson-blocks';

export function blockSummary(block: LessonBlock): string {
  const p =
    typeof block.props === 'object' && block.props !== null
      ? (block.props as Record<string, unknown>)
      : {};
  for (const key of [
    'text',
    'title',
    'caption',
    'alt',
    'body',
    'code',
    'url',
  ]) {
    if (typeof p[key] === 'string' && p[key].trim())
      return p[key].replace(/\s+/g, ' ').slice(0, 100);
  }
  if (Array.isArray(p.items)) return `${p.items.length} 个列表项`;
  if (Array.isArray(p.columns))
    return `${p.columns.length} 列 · ${Array.isArray(p.rows) ? p.rows.length : 0} 行`;
  if (Array.isArray(p.steps)) return `${p.steps.length} 个步骤`;
  if (Array.isArray(p.nodes)) return `${p.nodes.length} 个节点`;
  if (block.type === 'divider') return '分隔上下内容';
  if (block.type === 'image')
    return p.assetId ? '已选择图片' : '选择或上传图片';
  return '点击编辑内容';
}
