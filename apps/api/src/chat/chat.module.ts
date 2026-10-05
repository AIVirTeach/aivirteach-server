import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TokenUsageModule } from '../token-usage/token-usage.module';
import { AgentClient } from './agent-client';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [AuthModule, TokenUsageModule],
  controllers: [ChatController],
  providers: [ChatService, AgentClient],
})
export class ChatModule {}
