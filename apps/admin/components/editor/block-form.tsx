'use client';
import { z } from 'zod';
import {
  BLOCK_REGISTRY,
  type BlockType,
  type LessonBlock,
} from '@aivirteach/lesson-blocks';
import type { CourseAsset } from '@aivirteach/admin-contract';
import { AssetPicker } from './asset-picker';
type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
  const?: unknown;
  required?: string[];
  maxItems?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};
const names: Record<string, string> = {
  text: '文字',
  level: '标题级别',
  items: '列表项',
  kind: '代码类型',
  code: '代码',
  language: '语言',
  label: '标签',
  description: '说明',
  number: '步骤编号',
  title: '标题',
  body: '正文',
  variant: '提示类型',
  alt: '替代文字',
  caption: '图片说明',
  url: '链接地址',
  steps: '步骤',
  terms: '术语',
  term: '术语名称',
  explanationTitle: '批注标题',
  explanation: '批注说明',
  fileLabel: '文件标签',
  nodes: '节点',
  connections: '连接',
  id: '标识',
  from: '起点',
  to: '终点',
};
const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function initial(schema: Schema): unknown {
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return schema.anyOf[0].const ?? initial(schema.anyOf[0]);
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([k]) => schema.required?.includes(k))
        .map(([k, v]) => [k, initial(v)]),
    );
  if (schema.type === 'array') return [];
  if (schema.type === 'number' || schema.type === 'integer')
    return schema.minimum ?? 0;
  return '';
}
function Field({
  schema,
  value,
  name,
  onChange,
}: {
  schema: Schema;
  value: unknown;
  name: string;
  onChange: (value: unknown) => void;
}) {
  const options =
    schema.enum ??
    (schema.anyOf?.every((s) => s.const !== undefined)
      ? schema.anyOf.map((s) => s.const)
      : undefined);
  if (options)
    return (
      <label className="field">
        {name}
        <select
          value={String(value ?? '')}
          onChange={(e) =>
            onChange(options.find((v) => String(v) === e.target.value))
          }
        >
          {options.map((v) => (
            <option key={String(v)} value={String(v)}>
              {String(v)}
            </option>
          ))}
        </select>
      </label>
    );
  if (schema.type === 'object') {
    const object = asObject(value);
    return (
      <fieldset className="nested-fields">
        <legend>{name}</legend>
        {Object.entries(schema.properties ?? {}).map(([key, child]) => (
          <Field
            key={key}
            schema={child}
            name={`${name} · ${names[key] ?? key}`}
            value={object[key]}
            onChange={(next) => onChange({ ...object, [key]: next })}
          />
        ))}
      </fieldset>
    );
  }
  if (schema.type === 'array') {
    const values: unknown[] = Array.isArray(value) ? value : [];
    const item = schema.items ?? {};
    return (
      <fieldset className="nested-fields">
        <legend>{name}</legend>
        {values.map((v, i) => (
          <div key={i} className="array-item">
            <Field
              schema={item}
              value={v}
              name={`${name} ${i + 1}`}
              onChange={(next) =>
                onChange(values.map((x, j) => (i === j ? next : x)))
              }
            />
            <button
              type="button"
              onClick={() => onChange(values.filter((_, j) => i !== j))}
            >
              删除第 {i + 1} 项
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={values.length >= (schema.maxItems ?? Infinity)}
          onClick={() => onChange([...values, initial(item)])}
        >
          添加{name}
        </button>
      </fieldset>
    );
  }
  if (schema.type === 'integer' || schema.type === 'number')
    return (
      <label className="field">
        {name}
        <input
          type="number"
          min={schema.minimum}
          max={schema.maximum}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) =>
            onChange(e.target.value === '' ? undefined : Number(e.target.value))
          }
        />
      </label>
    );
  return (
    <label className="field">
      {name}
      <textarea
        rows={name.includes('代码') ? 6 : 3}
        maxLength={schema.maxLength}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
function TableForm({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (v: unknown) => void;
}) {
  const columns = Array.isArray(value.columns) ? value.columns.map(String) : [];
  const rows = Array.isArray(value.rows)
    ? value.rows.map((r) => (Array.isArray(r) ? r.map(String) : []))
    : [];
  return (
    <div className="table-edit">
      <p>列名与单元格</p>
      {columns.map((column, i) => (
        <div className="inline" key={i}>
          <label className="field">
            列 {i + 1}
            <input
              value={column}
              onChange={(e) =>
                onChange({
                  columns: columns.map((c, j) =>
                    i === j ? e.target.value : c,
                  ),
                  rows,
                })
              }
            />
          </label>
          <button
            type="button"
            disabled={columns.length <= 1}
            onClick={() =>
              onChange({
                columns: columns.filter((_, j) => j !== i),
                rows: rows.map((r) => r.filter((_, j) => j !== i)),
              })
            }
          >
            删列
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={columns.length >= 8}
        onClick={() =>
          onChange({
            columns: [...columns, ''],
            rows: rows.map((r) => [...r, '']),
          })
        }
      >
        添加列
      </button>
      {rows.map((row, i) => (
        <fieldset key={i}>
          <legend>第 {i + 1} 行</legend>
          {columns.map((_, j) => (
            <label className="field" key={j}>
              单元格 {i + 1}-{j + 1}
              <input
                value={row[j] ?? ''}
                onChange={(e) =>
                  onChange({
                    columns,
                    rows: rows.map((r, k) =>
                      k === i
                        ? columns.map((_, c) =>
                            c === j ? e.target.value : (r[c] ?? ''),
                          )
                        : r,
                    ),
                  })
                }
              />
            </label>
          ))}
          <button
            type="button"
            onClick={() =>
              onChange({ columns, rows: rows.filter((_, k) => k !== i) })
            }
          >
            删除行
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={rows.length >= 50}
        onClick={() =>
          onChange({ columns, rows: [...rows, columns.map(() => '')] })
        }
      >
        添加行
      </button>
    </div>
  );
}
export function BlockForm({
  block,
  slug,
  assets,
  onAssets,
  onBusy,
  onPatch,
  onChange,
}: {
  block: LessonBlock;
  slug: string;
  assets: CourseAsset[];
  onAssets: (a: CourseAsset) => void;
  onBusy: (v: boolean) => void;
  onPatch: (props: Record<string, unknown>) => void;
  onChange: (value: unknown) => void;
}) {
  if (!Object.hasOwn(BLOCK_REGISTRY, block.type))
    return <p role="alert">未知块类型。可删除该块后重新添加。</p>;
  const entry = BLOCK_REGISTRY[block.type as BlockType];
  const schema = z.toJSONSchema(entry.schema) as Schema;
  const value = asObject(block.props);
  return (
    <section className="property-panel">
      <h3>{entry.label}属性</h3>
      {block.type === 'table' ? (
        <TableForm value={value} onChange={onChange} />
      ) : (
        Object.entries(schema.properties ?? {}).map(([key, field]) =>
          key === 'assetId' && block.type === 'image' ? (
            <AssetPicker
              key={key}
              slug={slug}
              assets={assets}
              value={typeof value.assetId === 'string' ? value.assetId : ''}
              onAssets={onAssets}
              onBusy={onBusy}
              onChange={(id) => onPatch({ assetId: id })}
            />
          ) : (
            <Field
              key={key}
              schema={field}
              value={value[key]}
              name={names[key] ?? key}
              onChange={(next) => onChange({ ...value, [key]: next })}
            />
          ),
        )
      )}
      {block.type === 'divider' && (
        <p className="muted">分隔线没有可编辑属性。</p>
      )}
    </section>
  );
}
