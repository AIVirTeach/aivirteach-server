import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  check() {
    return { status: "ok", service: "aivirteach-backend", version: "0.1.0", storage: process.env.DATABASE_URL ? "postgresql" : "in-memory", timestamp: new Date().toISOString() };
  }
}
