import { Test } from '@nestjs/testing';
import express from 'express';
import { once } from 'node:events';
import { ENV } from '../config/env';
import { CheckTokenQuota } from '../token-usage/application/check-token-quota';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import type { SendChatMessageInput } from './chat.schemas';

const JWT_AUTH_GUARD_STUB = {
  provide: ENV,
  useValue: { JWT_SECRET: 'test-secret' },
};
// 控制器单测不经过 Guard 执行，只需要让 DI 能解析出 TokenQuotaGuard 的依赖。
const TOKEN_QUOTA_STUB = { provide: CheckTokenQuota, useValue: {} };
const AUTH_REQUEST = {
  auth: { userId: 'user_1', email: 'learner@example.com' },
};
const COMMAND: SendChatMessageInput = {
  requestId: '00000000-0000-4000-8000-000000000001',
  text: '你好',
  context: {
    courseVersionId: 'version_1',
    lessonId: 'lesson_1',
    generation: 0,
  },
};

describe('ChatController', () => {
  it('delivers assistant_delta over HTTP while the upstream result is still pending', async () => {
    let finishUpstream!: () => void;
    const upstreamPending = new Promise<void>((resolve) => {
      finishUpstream = resolve;
    });
    let upstreamFinished = false;
    const service = {
      prepareMessage: jest.fn().mockResolvedValue({ accepted: true }),
      streamPrepared: jest.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'progress',
            event: 'assistant_delta',
            data: { delta: '先检查网络' },
          };
          await upstreamPending;
          upstreamFinished = true;
          yield {
            type: 'complete',
            tutorMessage: { text: '先检查网络连接。' },
          };
        })(),
      ),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: service },
        JWT_AUTH_GUARD_STUB,
        TOKEN_QUOTA_STUB,
      ],
    }).compile();
    const app = express();
    app.post('/stream', async (request, response) => {
      await moduleRef
        .get(ChatController)
        .streamMessage(
          'enr_1',
          COMMAND,
          Object.assign(request, AUTH_REQUEST),
          response,
        );
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing HTTP port');
      const response = await fetch(`http://127.0.0.1:${address.port}/stream`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      if (!response.body) throw new Error('Missing SSE response body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = '';
      while (!received.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream ended before the delta');
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain('event: assistant_delta\n');
      expect(received).toContain('先检查网络');
      expect(received).not.toContain('event: complete');
      expect(upstreamFinished).toBe(false);

      finishUpstream();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain('event: complete\n');
      expect(received).toContain('先检查网络连接。');
      reader.releaseLock();
    } finally {
      finishUpstream();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await moduleRef.close();
    }
  });

  it('GET :enrollmentId/chat/messages 用认证用户的 userId 调用 service.getMessages', async () => {
    const service = { getMessages: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: service },
        JWT_AUTH_GUARD_STUB,
        TOKEN_QUOTA_STUB,
      ],
    }).compile();
    const controller = moduleRef.get(ChatController);

    await expect(
      controller.getMessages('enr_1', { generation: 0 }, AUTH_REQUEST as any),
    ).resolves.toEqual([]);
    expect(service.getMessages).toHaveBeenCalledWith('user_1', 'enr_1', 0);
  });

  it('POST :enrollmentId/chat/messages 用认证用户的 userId 和完整命令调用 service.sendMessage', async () => {
    const service = {
      sendMessage: jest.fn().mockResolvedValue({
        studentMessage: {
          id: 's1',
          userId: 'user_1',
          threadId: 'enr_1',
          role: 'student',
          text: '你好',
          createdAt: '2026-08-28T00:00:00.000Z',
        },
        tutorMessage: {
          id: 't1',
          userId: 'user_1',
          threadId: 'enr_1',
          role: 'tutor',
          text: '有什么可以帮你',
          createdAt: '2026-08-28T00:00:01.000Z',
        },
      }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: service },
        JWT_AUTH_GUARD_STUB,
        TOKEN_QUOTA_STUB,
      ],
    }).compile();
    const controller = moduleRef.get(ChatController);

    const result = await controller.sendMessage(
      'enr_1',
      COMMAND,
      AUTH_REQUEST as any,
    );

    expect(result.tutorMessage.text).toBe('有什么可以帮你');
    expect(service.sendMessage).toHaveBeenCalledWith(
      'user_1',
      'enr_1',
      COMMAND,
    );
  });

  it('POST :enrollmentId/chat/messages/stream 验证后才写 SSE 头并编码 progress/complete', async () => {
    const service = {
      prepareMessage: jest.fn().mockResolvedValue({ accepted: true }),
      streamPrepared: jest.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'progress',
            event: 'reasoning_started',
            data: { turn: 1 },
          };
          yield {
            type: 'complete',
            studentMessage: {
              id: 's1',
              userId: 'user_1',
              threadId: 'enr_1',
              role: 'student',
              text: '你好',
              createdAt: '2026-08-28T00:00:00.000Z',
            },
            tutorMessage: {
              id: 't1',
              userId: 'user_1',
              threadId: 'enr_1',
              role: 'tutor',
              text: '有什么可以帮你',
              createdAt: '2026-08-28T00:00:01.000Z',
            },
          };
        })(),
      ),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: service },
        JWT_AUTH_GUARD_STUB,
        TOKEN_QUOTA_STUB,
      ],
    }).compile();
    const controller = moduleRef.get(ChatController);

    const response = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      once: jest.fn(),
      removeListener: jest.fn(),
    };
    await controller.streamMessage(
      'enr_1',
      COMMAND,
      AUTH_REQUEST as any,
      response as any,
    );

    expect(response.flushHeaders).toHaveBeenCalledTimes(1);
    const encoded = response.write.mock.calls.map(([frame]) => {
      const [, event] = String(frame).match(/^event: (.+)$/m)!;
      const [, data] = String(frame).match(/^data: (.+)$/m)!;
      return { event, data: JSON.parse(data) };
    });
    expect(encoded).toEqual([
      {
        event: 'reasoning_started',
        data: {
          type: 'progress',
          event: 'reasoning_started',
          data: { turn: 1 },
        },
      },
      {
        event: 'complete',
        data: {
          type: 'complete',
          studentMessage: expect.objectContaining({ text: '你好' }),
          tutorMessage: expect.objectContaining({ text: '有什么可以帮你' }),
        },
      },
    ]);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(service.prepareMessage).toHaveBeenCalledWith(
      'user_1',
      'enr_1',
      COMMAND,
    );
    expect(service.streamPrepared).toHaveBeenCalledWith({ accepted: true });
  });

  it('encodes a persistence failure as error, never as complete', async () => {
    const failure = {
      type: 'error',
      code: 'REPLY_NOT_SAVED',
      message: '回复未能确认保存。',
    };
    const service = {
      prepareMessage: jest.fn().mockResolvedValue({ accepted: true }),
      streamPrepared: jest.fn().mockReturnValue(
        (async function* () {
          yield failure;
        })(),
      ),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: service },
        JWT_AUTH_GUARD_STUB,
        TOKEN_QUOTA_STUB,
      ],
    }).compile();
    const app = express();
    app.post('/stream', async (request, response) => {
      await moduleRef
        .get(ChatController)
        .streamMessage(
          'enr_1',
          COMMAND,
          Object.assign(request, AUTH_REQUEST),
          response,
        );
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing HTTP port');
      const response = await fetch(`http://127.0.0.1:${address.port}/stream`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
      expect(await response.text()).toBe(
        `event: error\ndata: ${JSON.stringify(failure)}\n\n`,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await moduleRef.close();
    }
  });

  it('准备阶段拒绝时保持 HTTP 响应未提交', async () => {
    const service = {
      prepareMessage: jest.fn().mockRejectedValue(new Error('invalid context')),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: service },
        JWT_AUTH_GUARD_STUB,
        TOKEN_QUOTA_STUB,
      ],
    }).compile();
    const response = {
      status: jest.fn(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
    };

    await expect(
      moduleRef
        .get(ChatController)
        .streamMessage('enr_1', COMMAND, AUTH_REQUEST as any, response as any),
    ).rejects.toThrow('invalid context');
    expect(response.flushHeaders).not.toHaveBeenCalled();
  });

  it('客户端断开后继续消费 Agent 结果以完成持久化和用量结算', async () => {
    let drained = false;
    let closeListener: (() => void) | undefined;
    const service = {
      prepareMessage: jest.fn().mockResolvedValue({ accepted: true }),
      streamPrepared: jest.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'progress',
            event: 'reasoning_started',
            data: { turn: 1 },
          };
          drained = true;
          yield { type: 'complete', studentMessage: {}, tutorMessage: {} };
        })(),
      ),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: service },
        JWT_AUTH_GUARD_STUB,
        TOKEN_QUOTA_STUB,
      ],
    }).compile();
    const response = {
      destroyed: false,
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(() => {
        closeListener?.();
        return false;
      }),
      end: jest.fn(),
      once: jest.fn((_event: string, listener: () => void) => {
        closeListener = listener;
      }),
      removeListener: jest.fn(),
    };

    await moduleRef
      .get(ChatController)
      .streamMessage('enr_1', COMMAND, AUTH_REQUEST as any, response as any);

    expect(drained).toBe(true);
    expect(response.write).toHaveBeenCalledTimes(1);
    expect(response.end).not.toHaveBeenCalled();
  });
});
