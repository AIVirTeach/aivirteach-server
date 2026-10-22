import { fireEvent, render, screen } from '@testing-library/react';
import { vi, it, expect } from 'vitest';
import { Button } from './button';
import { ConfirmAction } from './confirm-action';

it('cancels without mutation and respects a lock acquired while the dialog is open', () => {
  const onConfirm = vi.fn();
  const view = (disabled: boolean) => (
    <ConfirmAction
      title="删除课时？"
      description="不能恢复"
      disabled={disabled}
      onConfirm={onConfirm}
    >
      <Button>删除课时</Button>
    </ConfirmAction>
  );
  const { rerender } = render(view(false));
  fireEvent.click(screen.getByRole('button', { name: '删除课时' }));
  expect(screen.getByRole('alertdialog')).toHaveAccessibleName('删除课时？');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '删除课时' }));
  rerender(view(true));
  expect(screen.getByRole('button', { name: '确认删除' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(onConfirm).not.toHaveBeenCalled();
  rerender(view(false));
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(onConfirm).toHaveBeenCalledOnce();
});
