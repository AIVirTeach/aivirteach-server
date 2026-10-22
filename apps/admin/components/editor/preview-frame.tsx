'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPreviewChannel } from './preview-channel';
export function PreviewFrame({ payload }: { payload: unknown }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState('正在连接预览…');
  const raw = process.env.NEXT_PUBLIC_CLIENT_ORIGIN;
  let origin: string | null = null;
  try {
    if (raw) {
      const url = new URL(raw);
      if (['http:', 'https:'].includes(url.protocol)) origin = url.origin;
    }
  } catch {}
  const channel = useMemo(
    () =>
      origin
        ? createPreviewChannel({
            clientOrigin: origin,
            getTarget: () => frame.current?.contentWindow ?? null,
          })
        : null,
    [origin],
  );
  useEffect(() => {
    if (!channel) return;
    const timer = setTimeout(
      () => setStatus('预览不可用，请检查预览服务和来源配置'),
      5000,
    );
    const listener = (event: MessageEvent) => {
      if (channel.receive(event)) {
        clearTimeout(timer);
        setStatus('已连接真实课时预览');
      }
    };
    window.addEventListener('message', listener);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', listener);
    };
  }, [channel]);
  useEffect(() => {
    channel?.post(payload);
  }, [channel, payload]);
  return (
    <section className="preview-panel">
      <div className="section-heading">
        <h2>课时预览</h2>
        <small role="status">{origin ? status : '未配置预览地址'}</small>
      </div>
      {origin && (
        <iframe
          ref={frame}
          title="真实课时预览"
          src={`${origin}/preview/lesson`}
        />
      )}
    </section>
  );
}
