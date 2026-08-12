import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InMemoryDatabaseService } from "../data/in-memory-database.service";
import { DatabaseRepository } from "../data/database-repository";

@Injectable()
export class UsersService {
  constructor(@Inject("DATABASE_REPOSITORY") private readonly db: DatabaseRepository) {}

  async listDemoUsers() {
    return (await this.db.listUsers()).map(({ id, name, email, role, plan, level }) => ({ id, name, email, role, plan, level }));
  }

  async getById(id: string) {
    const user = await this.db.findUser(id);
    if (!user) throw new NotFoundException("Learner not found");
    return user;
  }

  async update(id: string, input: { name?: string; role?: string; timezone?: string }) {
    const user = await this.getById(id);
    if (input.name !== undefined) user.name = input.name.trim();
    if (input.role !== undefined) user.role = input.role.trim();
    if (input.timezone !== undefined) user.timezone = input.timezone.trim();
    return this.db.saveUser(user);
  }

  async createDemo(input: { name: string; email: string }) {
    const email = input.email.trim().toLowerCase();
    if ((await this.db.listUsers()).some((user) => user.email.toLowerCase() === email)) throw new ConflictException("A learner with this email already exists");

    const user = {
      id: "learner_" + crypto.randomUUID(),
      name: input.name.trim(),
      email,
      role: "AI Learner",
      plan: "Free" as const,
      level: 1,
      timezone: "Asia/Kuala_Lumpur",
      joinedAt: new Date().toISOString().slice(0, 10),
      streakDays: 0,
      skillsMastered: 0,
      tasksCompleted: 0,
    };
    await this.db.saveUser(user);
    await this.db.saveNotification({ id: "notification_" + crypto.randomUUID(), userId: user.id, message: "Welcome! Your first learning path is ready.", createdAt: new Date().toISOString(), readAt: null });
    return user;
  }

  async reset(id: string) {
    const user = await this.db.resetUser(id);
    if (!user) throw new NotFoundException("Only seeded demo learners can be reset");
    return user;
  }
}
