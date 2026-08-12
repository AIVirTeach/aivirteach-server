import { Controller, Get } from "@nestjs/common";
import { CurrentUserId } from "../common/current-user.decorator";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get(@CurrentUserId() userId: string) { return this.dashboard.get(userId); }
}
