import { Module } from "@nestjs/common";
import { ArtifactsModule } from "./artifacts/artifacts.module";
import { DbModule } from "./db/db.module";
import { EnvironmentsModule } from "./environments/environments.module";
import { FoldersModule } from "./folders/folders.module";
import { RunsModule } from "./runs/runs.module";
import { StorageModule } from "./storage/storage.module";
import { SuitesModule } from "./suites/suites.module";
import { TestsModule } from "./tests/tests.module";

@Module({
  imports: [
    DbModule,
    StorageModule,
    TestsModule,
    RunsModule,
    ArtifactsModule,
    EnvironmentsModule,
    FoldersModule,
    SuitesModule,
  ],
})
export class AppModule {}
