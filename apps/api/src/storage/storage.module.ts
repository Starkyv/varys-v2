import { Global, Module } from "@nestjs/common";
import { createStorageFromEnv, type StorageAdapter } from "@varys/storage-adapter";

export const STORAGE = Symbol("STORAGE");

@Global()
@Module({
  providers: [
    {
      provide: STORAGE,
      // local FS (default) or Azure Blob, selected by VARYS_STORAGE_DRIVER — same
      // logic the worker uses, so API + worker always agree on the backend.
      useFactory: (): StorageAdapter => createStorageFromEnv(),
    },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
