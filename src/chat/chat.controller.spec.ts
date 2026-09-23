import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

const JWT_AUTH_GUARD_STUB = { provide: ENV, useValue: { JWT_SECRET: 'test-secret' } };
const AUTH_REQUEST = { auth: { userId: 'user_1', email: 'learner@example.com' } };

describe('ChatController', () => {
  it('GET :enrollmentId/chat/messages 用认证用户的 userId 调用 service.getMessages', async () => {
    const service = { getMessages: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(ChatController);

    await expect(controller.getMessages('enr_1', AUTH_REQUEST as any)).resolves.toEqual([]);
    expect(service.getMessages).toHaveBeenCalledWith('user_1', 'enr_1');
  });

  it('POST :enrollmentId/chat/messages 用认证用户的 userId 和 body.text 调用 service.sendMessage', async () => {
    const service = {
      sendMessage: jest.fn().mockResolvedValue({
        studentMessage: { id: 's1', userId: 'user_1', threadId: 'enr_1', role: 'student', text: '你好', createdAt: '2026-08-28T00:00:00.000Z' },
        tutorMessage: { id: 't1', userId: 'user_1', threadId: 'enr_1', role: 'tutor', text: '有什么可以帮你', createdAt: '2026-08-28T00:00:01.000Z' },
      }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(ChatController);

    const result = await controller.sendMessage('enr_1', { text: '你好' }, AUTH_REQUEST as any);

    expect(result.tutorMessage.text).toBe('有什么可以帮你');
    expect(service.sendMessage).toHaveBeenCalledWith('user_1', 'enr_1', '你好');
  });

  it('POST :enrollmentId/chat/messages/stream 把 service 的 progress/complete 事件映射成 SSE MessageEvent', async () => {
    const service = {
      streamMessage: jest.fn().mockReturnValue(
        (async function* () {
          yield { type: 'progress', event: 'reasoning_started', data: { turn: 1 } };
          yield {
            type: 'complete',
            studentMessage: { id: 's1', userId: 'user_1', threadId: 'enr_1', role: 'student', text: '你好', createdAt: '2026-08-28T00:00:00.000Z' },
            tutorMessage: { id: 't1', userId: 'user_1', threadId: 'enr_1', role: 'tutor', text: '有什么可以帮你', createdAt: '2026-08-28T00:00:01.000Z' },
          };
        })(),
      ),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(ChatController);

    const events: unknown[] = [];
    await new Promise<void>((resolve) => {
      controller.streamMessage('enr_1', { text: '你好' }, AUTH_REQUEST as any).subscribe({
        next: (event) => events.push(event),
        complete: resolve,
      });
    });

    expect(events).toEqual([
      { type: 'reasoning_started', data: { type: 'progress', event: 'reasoning_started', data: { turn: 1 } } },
      {
        type: 'complete',
        data: {
          type: 'complete',
          studentMessage: expect.objectContaining({ text: '你好' }),
          tutorMessage: expect.objectContaining({ text: '有什么可以帮你' }),
        },
      },
    ]);
    expect(service.streamMessage).toHaveBeenCalledWith('user_1', 'enr_1', '你好');
  });
});
