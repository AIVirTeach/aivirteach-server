export type SseFrame = { event: string; data: string };

function parseFrame(raw: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

// Labs 用 `event: ...\ndata: ...\n\n` 编码每一帧（见 agent-service/aivirteach_agent/app.py 的
// _sse_event），帧之间以空行分隔；网络 chunk 边界跟帧边界无关，必须先按 \n\n 重新切帧再解析。
export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // 规范里帧内换行允许 \r\n；统一转成 \n 再找 \n\n 边界，否则 CRLF 流永远匹配不到边界。
      // 在整个 buffer（而不是单个 chunk）上 replace，避免 \r\n 被拆到两个 chunk 里漏转换。
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
