import { z } from 'zod';

export const TablePropsSchema = z.object({
  columns: z.array(z.string().max(300, '表格列名不能超过 300 个字符'))
    .min(1, '表格至少需要 1 列')
    .max(8, '表格不能超过 8 列'),
  rows: z.array(z.array(z.string().max(300, '表格单元格不能超过 300 个字符')))
    .max(50, '表格不能超过 50 行'),
}).superRefine((value, ctx) => {
  value.rows.forEach((row, index) => {
    if (row.length !== value.columns.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['rows', index],
        message: '表格每行单元格数必须与列数一致',
      });
    }
  });
});

export const ImagePropsSchema = z.object({
  assetId: z.string().min(1, '图片 assetId 不能为空'),
  alt: z.string().min(1, '图片 alt 不能为空').max(300, '图片 alt 不能超过 300 个字符'),
  caption: z.string().max(300, '图片说明不能超过 300 个字符').optional(),
});

export const ResourceLinkPropsSchema = z.object({
  url: z.string().min(1, '资源链接 URL 不能为空').refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
    } catch {
      return false;
    }
  }, '资源链接 URL 只允许 http、https 或 mailto'),
  title: z.string().min(1, '资源链接标题不能为空').max(120, '资源链接标题不能超过 120 个字符'),
  description: z.string().max(300, '资源链接说明不能超过 300 个字符').optional(),
});

const AnnotatedCodeTermSchema = z.object({
  term: z.string().max(60, '术语不能超过 60 个字符'),
  description: z.string().max(300, '术语说明不能超过 300 个字符'),
});

const AnnotatedCodeStepSchema = z.object({
  label: z.string().min(1, '批注代码步骤标签不能为空').max(80, '批注代码步骤标签不能超过 80 个字符'),
  code: z.string().min(1, '批注代码不能为空').max(10000, '批注代码不能超过 10000 个字符'),
  explanationTitle: z.string().max(80, '批注标题不能超过 80 个字符').optional(),
  explanation: z.string().max(1000, '批注说明不能超过 1000 个字符').optional(),
  terms: z.array(AnnotatedCodeTermSchema).max(10, '术语不能超过 10 项'),
});

export const AnnotatedCodePropsSchema = z.object({
  title: z.string().max(120, '批注代码标题不能超过 120 个字符').optional(),
  fileLabel: z.string().max(80, '文件标签不能超过 80 个字符').optional(),
  steps: z.array(AnnotatedCodeStepSchema)
    .min(1, '批注代码至少需要 1 步')
    .max(20, '批注代码不能超过 20 步'),
});

const DiagramNodeSchema = z.object({
  id: z.string().min(1, '流程图节点 id 不能为空').max(64, '流程图节点 id 不能超过 64 个字符'),
  title: z.string().max(60, '流程图节点标题不能超过 60 个字符'),
  description: z.string().max(200, '流程图节点说明不能超过 200 个字符').optional(),
});

const DiagramConnectionSchema = z.object({
  from: z.string().min(1, '连接起点不能为空').max(64, '连接起点不能超过 64 个字符'),
  to: z.string().min(1, '连接终点不能为空').max(64, '连接终点不能超过 64 个字符'),
  label: z.string().max(40, '连接标签不能超过 40 个字符').optional(),
});

export const DiagramPropsSchema = z.object({
  title: z.string().max(120, '流程图标题不能超过 120 个字符').optional(),
  nodes: z.array(DiagramNodeSchema)
    .min(2, '流程图至少需要 2 个节点')
    .max(12, '流程图不能超过 12 个节点'),
  connections: z.array(DiagramConnectionSchema),
}).superRefine((value, ctx) => {
  const nodeIds = new Set<string>();
  value.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) {
      ctx.addIssue({ code: 'custom', path: ['nodes', index, 'id'], message: '流程图节点 id 不能重复' });
    }
    nodeIds.add(node.id);
  });

  value.connections.forEach((connection, index) => {
    if (!nodeIds.has(connection.from)) {
      ctx.addIssue({ code: 'custom', path: ['connections', index, 'from'], message: '连接起点必须引用现有节点' });
    }
    if (!nodeIds.has(connection.to)) {
      ctx.addIssue({ code: 'custom', path: ['connections', index, 'to'], message: '连接终点必须引用现有节点' });
    }
  });
});
