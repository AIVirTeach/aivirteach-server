import "reflect-metadata";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

if (existsSync(".env")) loadEnvFile(".env");

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3001";

  app.setGlobalPrefix("api/v1");
  app.enableCors({ origin: frontendOrigin, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen(port, host);
  console.log(`AIVirTeach Backend V1 running at http://${host}:${port}/api/v1`);
}

void bootstrap();
