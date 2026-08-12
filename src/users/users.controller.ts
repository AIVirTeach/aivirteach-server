import { Body, Controller, Get, Patch, Post } from "@nestjs/common";
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { CurrentUserId } from "../common/current-user.decorator";
import { UsersService } from "./users.service";

class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(120) role?: string;
  @IsOptional() @IsString() @MaxLength(80) timezone?: string;
}

class CreateDemoUserDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsEmail() @MaxLength(160) email: string;
}

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get("demo/users")
  listDemoUsers() { return this.users.listDemoUsers(); }

  @Post("demo/users")
  createDemoUser(@Body() input: CreateDemoUserDto) { return this.users.createDemo(input); }

  @Get("me")
  getMe(@CurrentUserId() userId: string) { return this.users.getById(userId); }

  @Patch("me")
  updateMe(@CurrentUserId() userId: string, @Body() input: UpdateProfileDto) { return this.users.update(userId, input); }

  @Post("me/reset")
  resetMe(@CurrentUserId() userId: string) { return this.users.reset(userId); }
}
