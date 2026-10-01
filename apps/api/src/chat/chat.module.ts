import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgentClient } from './agent-client';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [AuthModule],
  controllers: [ChatController],
  providers: [ChatService, AgentClient],
})
export class ChatModule {}
