'use client';
import { useState } from 'react';
import type { CourseAsset } from '@aivirteach/admin-contract';
import { uploadAssetAction } from '@/app/(app)/courses/actions';
import { resultMessage, settleAction } from '@/lib/action-result';
export function AssetPicker({
  slug,
  assets,
  value,
  onChange,
  onAssets,
  onBusy,
}: {
  slug: string;
  assets: CourseAsset[];
  value: string;
  onChange: (id: string) => void;
  onAssets: (asset: CourseAsset) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <label className="field">
        课程图片
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">请选择图片</option>
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.altText || a.id}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        上传图片
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            e.target.value = '';
            setError('');
            if (
              !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
                file.type,
              )
            ) {
              setError('仅支持 PNG、JPEG、WebP、GIF 图片');
              return;
            }
            if (file.size > 5 * 1024 * 1024) {
              setError('图片大小不能超过 5 MiB');
              return;
            }
            const form = new FormData();
            form.set('file', file);
            form.set('altText', file.name);
            setBusy(true);
            onBusy(true);
            try {
              const result = await settleAction(uploadAssetAction(slug, form));
              if (result.status === 'ok') {
                onAssets(result.data);
                onChange(result.data.id);
              } else setError(resultMessage(result));
            } finally {
              setBusy(false);
              onBusy(false);
            }
          }}
        />
      </label>
      <small>PNG、JPEG、WebP、GIF，最大 5 MiB</small>
      {busy && <p role="status">正在上传…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
