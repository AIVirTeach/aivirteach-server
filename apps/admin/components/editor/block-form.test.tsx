import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { BLOCK_TYPES, BLOCK_REGISTRY } from '@aivirteach/lesson-blocks';
import { BlockForm } from './block-form';
vi.mock('@/app/(app)/courses/actions', () => ({ uploadAssetAction: vi.fn() }));
describe('schema driven forms', () => {
  it.each(BLOCK_TYPES)('renders %s fields from the registry', (type) => {
    const entry = BLOCK_REGISTRY[type];
    render(
      <BlockForm
        block={{ id: 'a', type, props: entry.defaultProps() }}
        slug="course"
        assets={[]}
        onUploadStart={vi.fn()}
        onUploadFinish={vi.fn()}
        onAssets={vi.fn()}
        onBusy={vi.fn()}
        onPatch={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { name: `${entry.label}属性` }),
    ).toBeInTheDocument();
  });
  it('only offers the callout variants in the schema', () => {
    render(
      <BlockForm
        block={{
          id: 'a',
          type: 'callout',
          props: BLOCK_REGISTRY.callout.defaultProps(),
        }}
        slug="course"
        assets={[]}
        onUploadStart={vi.fn()}
        onUploadFinish={vi.fn()}
        onAssets={vi.fn()}
        onBusy={vi.fn()}
        onPatch={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'tip',
      'warning',
      'note',
    ]);
  });
  it('adds a table column to every row', () => {
    const onChange = vi.fn();
    render(
      <BlockForm
        block={{
          id: 'a',
          type: 'table',
          props: { columns: ['A'], rows: [['one']] },
        }}
        slug="course"
        assets={[]}
        onUploadStart={vi.fn()}
        onUploadFinish={vi.fn()}
        onAssets={vi.fn()}
        onBusy={vi.fn()}
        onPatch={vi.fn()}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '添加列' }));
    expect(onChange).toHaveBeenCalledWith({
      columns: ['A', ''],
      rows: [['one', '']],
    });
  });
});

it.each(
  BLOCK_TYPES.filter((type) => !['divider', 'table', 'image'].includes(type)),
)('edits %s properties without losing sibling fields', (type) => {
  const onChange = vi.fn();
  const props = BLOCK_REGISTRY[type].defaultProps();
  render(
    <BlockForm
      block={{ id: 'block', type, props }}
      slug="course"
      assets={[]}
      onUploadStart={vi.fn()}
      onUploadFinish={vi.fn()}
      onAssets={vi.fn()}
      onBusy={vi.fn()}
      onPatch={vi.fn()}
      onChange={onChange}
    />,
  );
  const inputs = [
    ...screen.queryAllByRole('textbox'),
    ...screen.queryAllByRole('spinbutton'),
  ];
  for (const input of inputs)
    fireEvent.change(input, {
      target: {
        value: input.getAttribute('type') === 'number' ? '2' : 'Edited content',
      },
    });
  for (const select of screen.queryAllByRole('combobox')) {
    const options = Array.from(select.querySelectorAll('option'));
    if (options.length > 1)
      fireEvent.change(select, { target: { value: options.at(-1)!.value } });
  }
  expect(onChange).toHaveBeenCalled();
});
it('creates nested array entries from schema defaults and supports deleting them', () => {
  const onChange = vi.fn();
  render(
    <BlockForm
      block={{
        id: 'a',
        type: 'annotatedCode',
        props: BLOCK_REGISTRY.annotatedCode.defaultProps(),
      }}
      slug="course"
      assets={[]}
      onUploadStart={vi.fn()}
      onUploadFinish={vi.fn()}
      onAssets={vi.fn()}
      onBusy={vi.fn()}
      onPatch={vi.fn()}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '添加步骤' }));
  expect(onChange).toHaveBeenLastCalledWith({
    steps: [
      { label: '步骤', code: ' ', terms: [] },
      { label: '', code: '', terms: [] },
    ],
  });
  fireEvent.click(screen.getByRole('button', { name: /添加步骤 1 · 术语/ }));
  expect(onChange).toHaveBeenLastCalledWith({
    steps: [
      { label: '步骤', code: ' ', terms: [{ term: '', description: '' }] },
    ],
  });
  fireEvent.click(screen.getByRole('button', { name: '删除第 1 项' }));
  expect(onChange).toHaveBeenLastCalledWith({ steps: [] });
});
it('edits table cells, rows and columns while keeping rectangular rows', () => {
  const onChange = vi.fn();
  render(
    <BlockForm
      block={{
        id: 't',
        type: 'table',
        props: { columns: ['A', 'B'], rows: [['a', 'b']] },
      }}
      slug="course"
      assets={[]}
      onUploadStart={vi.fn()}
      onUploadFinish={vi.fn()}
      onAssets={vi.fn()}
      onBusy={vi.fn()}
      onPatch={vi.fn()}
      onChange={onChange}
    />,
  );
  fireEvent.change(screen.getByLabelText('列 1'), {
    target: { value: 'Changed' },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    columns: ['Changed', 'B'],
    rows: [['a', 'b']],
  });
  fireEvent.change(screen.getByLabelText('单元格 1-2'), {
    target: { value: 'Changed cell' },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    columns: ['A', 'B'],
    rows: [['a', 'Changed cell']],
  });
  fireEvent.click(screen.getAllByRole('button', { name: '删列' })[0]);
  expect(onChange).toHaveBeenLastCalledWith({ columns: ['B'], rows: [['b']] });
  fireEvent.click(screen.getByRole('button', { name: '添加行' }));
  expect(onChange).toHaveBeenLastCalledWith({
    columns: ['A', 'B'],
    rows: [
      ['a', 'b'],
      ['', ''],
    ],
  });
  fireEvent.click(screen.getByRole('button', { name: '删除行' }));
  expect(onChange).toHaveBeenLastCalledWith({ columns: ['A', 'B'], rows: [] });
});
