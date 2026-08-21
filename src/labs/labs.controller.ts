import { Controller, Header, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { CurrentUserId } from "../common/current-user.decorator";
import { LabsService } from "./labs.service";

@Controller("me/lab")
export class LabsController {
  constructor(private readonly labs: LabsService) {}

  @Post("session")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "private, no-store")
  createSession(@CurrentUserId() userId: string) {
    return this.labs.createBrowserSession(userId);
  }
}
