import {
  Global,
  Inject,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { type Boss, createBoss, startBoss } from "@varys/queue";

export const BOSS = Symbol("BOSS");

@Global()
@Module({
  providers: [
    {
      provide: BOSS,
      useFactory: (): Boss => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) throw new Error("DATABASE_URL is not set");
        return createBoss(connectionString);
      },
    },
  ],
  exports: [BOSS],
})
export class QueueModule implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(BOSS) private readonly boss: Boss) {}

  async onModuleInit(): Promise<void> {
    await startBoss(this.boss);
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop();
  }
}
