import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module";
import { RunsController } from "./runs.controller";
import { RunsService } from "./runs.service";

@Module({
  imports: [QueueModule],
  controllers: [RunsController],
  providers: [RunsService],
  // Exported so a suite-run fan-out creates children through the SAME
  // single-run path (version pin + enqueue) instead of duplicating it.
  exports: [RunsService],
})
export class RunsModule {}
