import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Pool } from "pg";
import { AppModule } from "./app.module";
import { DDL } from "./db/schema";

async function bootstrap() {
  // Apply schema (walking-skeleton stand-in for migrations).
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(DDL);
  await pool.end();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // A recording's definition is structured JSON (no image bytes), but a long session
  // with many richly-fingerprinted steps can still exceed body-parser's 100 KB default.
  app.useBodyParser("json", { limit: "5mb" });
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
