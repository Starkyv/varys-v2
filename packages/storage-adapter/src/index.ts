import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Artifact storage seam. Local FS for MVP; Azure Blob / S3 implementations land
 * later behind this same interface. `getUrl` returns a signed blob URL in the
 * cloud, or (for local) the API's authed artifact route.
 */
export interface StorageAdapter {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  getUrl(key: string): string;
  delete(key: string): Promise<void>;
}

export class LocalFsAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const p = resolve(this.root, key);
    if (p !== this.root && !p.startsWith(`${this.root}/`)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return p;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }

  getUrl(key: string): string {
    return `/artifacts/${Buffer.from(key).toString("base64url")}`;
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
