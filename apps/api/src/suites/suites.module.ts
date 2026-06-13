import { Module } from "@nestjs/common";
import { TestsModule } from "../tests/tests.module";
import { SuitesController } from "./suites.controller";
import { SuitesService } from "./suites.service";

@Module({
  imports: [TestsModule],
  controllers: [SuitesController],
  providers: [SuitesService],
})
export class SuitesModule {}
