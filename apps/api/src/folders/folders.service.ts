import {
  BadRequestException,
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

  /** All folders (alphabetical) with parent + how many tests live DIRECTLY in each. The web
   *  builds the tree from `parentId`. */
  async list(): Promise<FolderSummary[]> {
    return this.db
      .select({
        id: folders.id,
        name: folders.name,
        parentId: folders.parentId,
        testCount: sql<number>`count(${tests.id})::int`,
      })
      .from(folders)
      .leftJoin(tests, eq(tests.folderId, folders.id))
      .groupBy(folders.id, folders.name, folders.parentId)
      .orderBy(asc(folders.name));
  }

  async create(input: { name: string; parentId?: string | null }): Promise<{ id: string }> {
    const name = input.name?.trim();
    if (!name) throw new ConflictException("folder name cannot be empty");
    const parentId = input.parentId ?? null;
    if (parentId) await this.requireFolder(parentId);
    try {
      const [row] = await this.db
        .insert(folders)
        .values({ name, parentId })
        .returning({ id: folders.id });
      return { id: row.id };
    } catch (err) {
      if (pgCode(err) === "23505") {
        throw new ConflictException(`A folder named “${name}” already exists here`);
      }
      throw err;
    }
  }

  /** Move a folder under a new parent (null = root). Rejects a cycle (a folder can't become
   *  its own descendant) and a missing target. */
  async move(id: string, parentId: string | null): Promise<{ ok: true }> {
    await this.requireFolder(id);
    if (parentId) {
      if (parentId === id) throw new BadRequestException("A folder can't be its own parent");
      await this.requireFolder(parentId);
      if (await this.isDescendant(parentId, id)) {
        throw new BadRequestException("Can't move a folder into one of its own subfolders");
      }
    }
    try {
      await this.db.update(folders).set({ parentId }).where(eq(folders.id, id));
    } catch (err) {
      if (pgCode(err) === "23505") {
        throw new ConflictException("A folder with that name already exists in the target");
      }
      throw err;
    }
    return { ok: true };
  }

  /** True when `candidate` is `ancestor` or lives somewhere below it (walks parent links). */
  private async isDescendant(candidate: string, ancestor: string): Promise<boolean> {
    const rows = await this.db.select({ id: folders.id, parentId: folders.parentId }).from(folders);
    const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
    let cur: string | null = candidate;
    // Bounded by the folder count — no infinite loop even if data were somehow cyclic.
    for (let i = 0; cur && i <= rows.length; i++) {
      if (cur === ancestor) return true;
      cur = parentOf.get(cur) ?? null;
    }
    return false;
  }

  private async requireFolder(id: string): Promise<void> {
    const [row] = await this.db.select({ id: folders.id }).from(folders).where(eq(folders.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Folder ${id} not found`);
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
        throw new ConflictException(`A folder named “${name}” already exists here`);
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
