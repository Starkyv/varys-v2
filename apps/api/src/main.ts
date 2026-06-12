import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { AppModule } from "./app.module";
import { DDL } from "./db/schema";

async function bootstrap() {
  // Apply schema (walking-skeleton stand-in for migrations).
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(DDL);
  await pool.end();

  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
