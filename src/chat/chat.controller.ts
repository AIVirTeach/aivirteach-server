import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { IsString, MaxLength, MinLength } from "class-validator";
import { CurrentUserId } from "../common/current-user.decorator";
import { ChatService } from "./chat.service";

class SendChatMessageDto {
  @IsString() @MinLength(1) @MaxLength(4000) text: string;
}

@Controller("chat/threads/:threadId/messages")
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  list(@CurrentUserId() userId: string, @Param("threadId") threadId: string) { return this.chat.list(userId, threadId); }

  @Post()
  send(@CurrentUserId() userId: string, @Param("threadId") threadId: string, @Body() input: SendChatMessageDto) { return this.chat.send(userId, threadId, input.text.trim()); }
}
