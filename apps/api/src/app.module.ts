import { Module } from "@nestjs/common";
import { ArtifactsModule } from "./artifacts/artifacts.module";
import { AuthModule } from "./auth/auth.module";
import { AuthoringModule } from "./authoring/authoring.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { DbModule } from "./db/db.module";
import { EnvironmentsModule } from "./environments/environments.module";
import { FoldersModule } from "./folders/folders.module";
import { HealthModule } from "./health/health.module";
import { RunsModule } from "./runs/runs.module";
import { SettingsModule } from "./settings/settings.module";
import { StorageModule } from "./storage/storage.module";
import { SuiteRunsModule } from "./suite-runs/suite-runs.module";
import { SuitesModule } from "./suites/suites.module";
import { TestsModule } from "./tests/tests.module";

@Module({
  imports: [
    // AuthModule registers the global auth guard (deny-by-default) — first so its
    // APP_GUARD covers every other module's routes.
    AuthModule,
    HealthModule,
    DbModule,
    StorageModule,
    TestsModule,
    RunsModule,
    ArtifactsModule,
    EnvironmentsModule,
    FoldersModule,
    SuitesModule,
    SuiteRunsModule,
    DashboardModule,
    AuthoringModule,
    SettingsModule,
  ],
})
export class AppModule {}
