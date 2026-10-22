'use client';
import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { courseMutation } from '@/app/(app)/courses/actions';
import { resultMessage, settleAction } from '@/lib/action-result';
import { useDepartureGuard } from '@/components/editor/use-departure-guard';
export function MutationForm({
  slug,
  path,
  method = 'PATCH',
  children,
  build,
  onDirty,
  label = '保存',
  afterSave,
}: {
  slug: string;
  path: string;
  method?: 'POST' | 'PATCH';
  children: ReactNode;
  build: (form: FormData) => unknown;
  onDirty?: (dirty: boolean) => void;
  label?: string;
  afterSave?: () => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const locked = busy || refreshing;
  const [message, setMessage] = useState('');
  const router = useRouter();
  useDepartureGuard(dirty || locked);
  return (
    <form
      className="edit-form"
      onChange={() => {
        setDirty(true);
        onDirty?.(true);
        setMessage('');
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (locked) return;
        const form = e.currentTarget;
        setBusy(true);
        onDirty?.(true);
        setMessage('');
        try {
          const result = await settleAction(
            courseMutation(slug, path, method, build(new FormData(form))),
          );
          if (result.status === 'ok') {
            if (method === 'POST') form.reset();
            startRefresh(() => {
              setDirty(false);
              onDirty?.(false);
              setMessage('已保存');
              afterSave?.();
              router.refresh();
            });
          } else setMessage(resultMessage(result));
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={locked}>{children}</fieldset>
      <div className="form-footer">
        <button className="primary" disabled={locked} type="submit">
          {locked ? '保存中…' : label}
        </button>
        <span role="status">{message || (dirty ? '有未保存改动' : '')}</span>
        {message.includes('登录已过期') && (
          <a href="/login" target="_blank" rel="noreferrer">
            重新登录
          </a>
        )}
      </div>
    </form>
  );
}
export const text = (f: FormData, key: string) => String(f.get(key) ?? '');
export const lines = (f: FormData, key: string) =>
  text(f, key)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
export function TextField({
  name,
  label,
  value = '',
  required = false,
  multiline = false,
  type = 'text',
}: {
  name: string;
  label: string;
  value?: string | number;
  required?: boolean;
  multiline?: boolean;
  type?: string;
}) {
  return (
    <label className="field">
      {label}
      {multiline ? (
        <textarea
          name={name}
          defaultValue={value}
          rows={3}
          required={required}
        />
      ) : (
        <input
          name={name}
          defaultValue={value}
          type={type}
          min={type === 'number' ? 0 : undefined}
          required={required}
        />
      )}
    </label>
  );
}
