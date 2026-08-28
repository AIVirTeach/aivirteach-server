import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SendChatMessageSchema, type SendChatMessageInput } from './chat.schemas';
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
    @Req() request: AuthenticatedRequest,
  ): Promise<ChatMessage[]> {
    return this.chatService.getMessages(request.auth!.userId, enrollmentId);
  }

  @Post(':enrollmentId/chat/messages')
  @HttpCode(200)
  sendMessage(
    @Param('enrollmentId') enrollmentId: string,
    @Body(new ZodValidationPipe(SendChatMessageSchema)) body: SendChatMessageInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ studentMessage: ChatMessage; tutorMessage: ChatMessage }> {
    return this.chatService.sendMessage(request.auth!.userId, enrollmentId, body.text);
  }
}
