import { Module } from "@nestjs/common";
import { LabsModule } from "../labs/labs.module";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { LabsAgentClient } from "./labs-agent.client";

@Module({ imports: [LabsModule], controllers: [ChatController], providers: [ChatService, LabsAgentClient] })
export class ChatModule {}
