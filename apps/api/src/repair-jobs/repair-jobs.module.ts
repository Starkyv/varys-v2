import { Module } from "@nestjs/common";
import { RepairJobsController } from "./repair-jobs.controller";
import { RepairJobsService } from "./repair-jobs.service";

@Module({
  controllers: [RepairJobsController],
  providers: [RepairJobsService],
  exports: [RepairJobsService],
})
export class RepairJobsModule {}
