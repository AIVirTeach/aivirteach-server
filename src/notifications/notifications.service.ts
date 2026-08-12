import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InMemoryDatabaseService } from "../data/in-memory-database.service";
import { DatabaseRepository } from "../data/database-repository";

@Injectable()
export class NotificationsService {
  constructor(@Inject("DATABASE_REPOSITORY") private readonly db: DatabaseRepository) {}

  async list(userId: string) {
    return (await this.db.userNotifications(userId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async markRead(userId: string, notificationId: string) {
    const notification = await this.db.markNotificationRead(userId, notificationId);
    if (!notification) throw new NotFoundException("Notification not found");
    notification.readAt ??= new Date().toISOString();
    return notification;
  }

  async markAllRead(userId: string) {
    const readAt = new Date().toISOString();
    const updated = await this.db.markAllNotificationsRead(userId, readAt);
    return { updated, readAt };
  }
}
