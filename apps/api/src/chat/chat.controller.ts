import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TokenQuotaGuard } from '../token-usage/interface/token-quota.guard';
import {
  ChatGenerationQuerySchema,
  SendChatMessageSchema,
  type SendChatMessageInput,
} from './chat.schemas';
import { ChatService, type ChatMessage } from './chat.service';

@ApiTags('Chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('workspaces')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get(':enrollmentId/chat/messages')
  getMessages(
    @Param('enrollmentId') enrollmentId: string,
    @Query(new ZodValidationPipe(ChatGenerationQuerySchema))
    query: { generation: number },
    @Req() request: AuthenticatedRequest,
  ): Promise<ChatMessage[]> {
    return this.chatService.getMessages(
      request.auth!.userId,
      enrollmentId,
      query.generation,
    );
  }

  // 额度检查放在 JwtAuthGuard 之后的 Guard 中，两条 POST 路由都会在处理前返回 HTTP 429。
  @Post(':enrollmentId/chat/messages')
  @HttpCode(200)
  @UseGuards(TokenQuotaGuard)
  sendMessage(
    @Param('enrollmentId') enrollmentId: string,
    @Body(new ZodValidationPipe(SendChatMessageSchema))
    body: SendChatMessageInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ studentMessage: ChatMessage; tutorMessage: ChatMessage }> {
    return this.chatService.sendMessage(
      request.auth!.userId,
      enrollmentId,
      body,
    );
  }

  // Validate and persist before committing SSE headers so invalid requests retain HTTP errors.
  @Post(':enrollmentId/chat/messages/stream')
  @HttpCode(200)
  @UseGuards(TokenQuotaGuard)
  async streamMessage(
    @Param('enrollmentId') enrollmentId: string,
    @Body(new ZodValidationPipe(SendChatMessageSchema))
    body: SendChatMessageInput,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const accepted = await this.chatService.prepareMessage(
      request.auth!.userId,
      enrollmentId,
      body,
    );
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();

    const iterator = this.chatService
      .streamPrepared(accepted)
      [Symbol.asyncIterator]();
    let clientDisconnected = false;
    const closeStream = () => {
      clientDisconnected = true;
    };
    response.once('close', closeStream);
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const event = next.value;
        const type = event.type === 'progress' ? event.event : 'complete';
        if (!clientDisconnected && !response.destroyed) {
          response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      }
    } catch {
      if (!clientDisconnected && !response.destroyed) {
        response.write(
          `event: error\ndata: ${JSON.stringify({ message: '助教暂时不可用，请稍后再试。' })}\n\n`,
        );
      }
    } finally {
      response.removeListener('close', closeStream);
      if (!clientDisconnected && !response.destroyed) response.end();
    }
  }
}
