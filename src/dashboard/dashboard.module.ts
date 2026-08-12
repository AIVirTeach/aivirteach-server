import { Module } from "@nestjs/common";
import { LearningModule } from "../learning/learning.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";

@Module({ imports: [LearningModule], controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
