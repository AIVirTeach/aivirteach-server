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

  it('CRLF（\\r\\n）换行的帧也能正确切分', async () => {
    const stream = streamFromChunks(['event: a\r\ndata: {"n":1}\r\n\r\nevent: b\r\ndata: {"n":2}\r\n\r\n']);
    await expect(collect(stream)).resolves.toEqual([
      { event: 'a', data: '{"n":1}' },
      { event: 'b', data: '{"n":2}' },
    ]);
  });

  it('消费方提前结束迭代（客户端断开）时取消底层 stream，不让上游连接空转', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: a\ndata: {"n":1}\n\n'));
        // 不 close：模拟上游还在推数据，consumer 却提前走人的场景。
      },
      cancel() {
        cancelled = true;
      },
    });

    const iterator = parseSseStream(stream);
    await iterator.next();
    await iterator.return(undefined);

    expect(cancelled).toBe(true);
  });
});
