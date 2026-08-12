import { Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { CurrentUserId } from "../common/current-user.decorator";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUserId() userId: string) { return this.notifications.list(userId); }

  @Patch(":notificationId/read")
  markRead(@CurrentUserId() userId: string, @Param("notificationId") notificationId: string) { return this.notifications.markRead(userId, notificationId); }

  @Post("read-all")
  markAllRead(@CurrentUserId() userId: string) { return this.notifications.markAllRead(userId); }
}
