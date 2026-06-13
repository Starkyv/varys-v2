import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { folders, tests } from "@varys/db";
import type { FolderSummary } from "@varys/review-contract";
import { asc, eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

/** Postgres error code, whether the driver error is thrown bare or wrapped. */
function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

@Injectable()
export class FoldersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** All folders (alphabetical) with how many tests live in each. */
  async list(): Promise<FolderSummary[]> {
    return this.db
      .select({
        id: folders.id,
        name: folders.name,
        testCount: sql<number>`count(${tests.id})::int`,
      })
      .from(folders)
      .leftJoin(tests, eq(tests.folderId, folders.id))
      .groupBy(folders.id, folders.name)
      .orderBy(asc(folders.name));
  }

  async create(input: { name: string }): Promise<{ id: string }> {
    const name = input.name?.trim();
    if (!name) throw new ConflictException("folder name cannot be empty");
    try {
      const [row] = await this.db.insert(folders).values({ name }).returning({ id: folders.id });
      return { id: row.id };
    } catch (err) {
      if (pgCode(err) === "23505") {
        throw new ConflictException(`A folder named “${name}” already exists`);
      }
      throw err;
    }
  }

  async rename(id: string, input: { name: string }): Promise<{ ok: true }> {
    const name = input.name?.trim();
    if (!name) throw new ConflictException("folder name cannot be empty");
    let updated: { id: string }[];
    try {
      updated = await this.db
        .update(folders)
        .set({ name })
        .where(eq(folders.id, id))
        .returning({ id: folders.id });
    } catch (err) {
      if (pgCode(err) === "23505") {
        throw new ConflictException(`A folder named “${name}” already exists`);
      }
      throw err;
    }
    if (updated.length === 0) throw new NotFoundException(`Folder ${id} not found`);
    return { ok: true };
  }

  /** Delete a folder. Its tests are UNFILED, never deleted — the folder_id FK is
   *  ON DELETE SET NULL, so the unfiling is enforced by the database itself. */
  async delete(id: string): Promise<{ ok: true }> {
    const deleted = await this.db
      .delete(folders)
      .where(eq(folders.id, id))
      .returning({ id: folders.id });
    if (deleted.length === 0) throw new NotFoundException(`Folder ${id} not found`);
    return { ok: true };
  }
}
