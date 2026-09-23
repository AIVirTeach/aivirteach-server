import { parseSseStream } from './sse-parser';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const events: Array<{ event: string; data: string }> = [];
  for await (const event of parseSseStream(stream)) events.push(event);
  return events;
}

describe('parseSseStream', () => {
  it('解析单个 event+data 帧', async () => {
    const stream = streamFromChunks(['event: reasoning_started\ndata: {"turn":1}\n\n']);
    await expect(collect(stream)).resolves.toEqual([{ event: 'reasoning_started', data: '{"turn":1}' }]);
  });

  it('一个帧被拆成多个网络 chunk 时仍能正确拼接', async () => {
    const stream = streamFromChunks(['event: tool_st', 'arted\ndata: {"tool":"che', 'ck_disk"}\n\n']);
    await expect(collect(stream)).resolves.toEqual([{ event: 'tool_started', data: '{"tool":"check_disk"}' }]);
  });

  it('按 \\n\\n 边界拆分出多个帧，保持顺序', async () => {
    const stream = streamFromChunks(['event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n":2}\n\n']);
    await expect(collect(stream)).resolves.toEqual([
      { event: 'a', data: '{"n":1}' },
      { event: 'b', data: '{"n":2}' },
    ]);
  });

  it('忽略 keep-alive 注释行（以 : 开头）', async () => {
    const stream = streamFromChunks([': keep-alive\n\nevent: done\ndata: {"status":"completed"}\n\n']);
    await expect(collect(stream)).resolves.toEqual([{ event: 'done', data: '{"status":"completed"}' }]);
  });

  it('多行 data 用换行拼接', async () => {
    const stream = streamFromChunks(['event: result\ndata: {"a":1,\ndata: "b":2}\n\n']);
    await expect(collect(stream)).resolves.toEqual([{ event: 'result', data: '{"a":1,\n"b":2}' }]);
  });

  it('没有 data 行的帧被跳过', async () => {
    const stream = streamFromChunks(['event: ping\n\nevent: done\ndata: {}\n\n']);
    await expect(collect(stream)).resolves.toEqual([{ event: 'done', data: '{}' }]);
  });
});
