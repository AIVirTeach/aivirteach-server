import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { CurrentUserId } from "../common/current-user.decorator";
import { ChatService } from "./chat.service";

class SendChatMessageDto {
  @IsString() @MinLength(1) @MaxLength(4000) @Matches(/\S/) text: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) @Matches(/\S/) courseId?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) @Matches(/\S/) lessonId?: string;
}

@Controller("chat/threads/:threadId/messages")
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  list(@CurrentUserId() userId: string, @Param("threadId") threadId: string) { return this.chat.list(userId, threadId); }

  @Post()
  send(@CurrentUserId() userId: string, @Param("threadId") threadId: string, @Body() input: SendChatMessageDto) {
    return this.chat.send(userId, threadId, input.text.trim(), {
      courseId: input.courseId?.trim(),
      lessonId: input.lessonId?.trim(),
    });
  }
}
