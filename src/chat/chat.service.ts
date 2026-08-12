import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InMemoryDatabaseService } from "../data/in-memory-database.service";
import { DatabaseRepository } from "../data/database-repository";

@Injectable()
export class ChatService {
  constructor(@Inject("DATABASE_REPOSITORY") private readonly db: DatabaseRepository) {}

  async list(userId: string, threadId: string) {
    return this.db.listChatMessages(userId, threadId);
  }

  async send(userId: string, threadId: string, text: string) {
    if (!await this.db.findUser(userId)) throw new NotFoundException("Learner not found");
    const createdAt = new Date().toISOString();
    const studentMessage = { id: `message_${crypto.randomUUID()}`, userId, threadId, role: "student" as const, text, createdAt };
    const tutorMessage = { id: `message_${crypto.randomUUID()}`, userId, threadId, role: "tutor" as const, text: this.mockTutorReply(text), createdAt: new Date().toISOString() };
    await this.db.saveChatMessages([studentMessage, tutorMessage]);
    return { studentMessage, tutorMessage, provider: "mock" };
  }

  private mockTutorReply(text: string) {
    const normalized = text.toLowerCase();
    if (normalized.includes("filter") || normalized.includes("dataframe")) return "Try boolean indexing: build the condition first, then use it inside df[condition].";
    if (normalized.includes("error")) return "Read the final line of the error first. It usually identifies the exception and the value that caused it.";
    if (normalized.includes("hint")) return "Break the task into one small transformation, run it, and inspect the output before continuing.";
    return "Tell me what you expected to happen and what happened instead, and we can work through the next step together.";
  }
}
