import { Global, Module } from "@nestjs/common";
import { LocalFsAdapter, type StorageAdapter } from "@varys/storage-adapter";

export const STORAGE = Symbol("STORAGE");

@Global()
@Module({
  providers: [
    {
      provide: STORAGE,
      useFactory: (): StorageAdapter =>
        new LocalFsAdapter(process.env.VARYS_STORAGE_DIR ?? "./.varys-artifacts"),
    },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
