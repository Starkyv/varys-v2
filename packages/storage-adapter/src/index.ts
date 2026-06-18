import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ContainerClient, RestError } from "@azure/storage-blob";

/**
 * Artifact storage seam. Two implementations live behind this interface: local
 * filesystem (dev / single-box) and Azure Blob (hosted). `getUrl` returns the
 * API's authed artifact route in BOTH — the API streams the bytes from whichever
 * backend is configured (it never hands a raw blob/SAS URL to the browser), so the
 * web app, auth, and the trace-viewer CORS story are identical regardless of driver.
 */
export interface StorageAdapter {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  getUrl(key: string): string;
  delete(key: string): Promise<void>;
}

/** The token-addressed, API-proxied URL for an artifact key. Shared by every adapter:
 *  `/artifacts/:token` is served by ArtifactsController, which calls `get(key)`. */
function artifactRoute(key: string): string {
  return `/artifacts/${Buffer.from(key).toString("base64url")}`;
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
    return artifactRoute(key);
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export interface AzureBlobConfig {
  /** Storage account name, e.g. `varysprod`. */
  account: string;
  /** Container name within the account, e.g. `artifacts`. */
  container: string;
  /** A SAS token (the query string; a leading `?` is tolerated). Needs r/a/c/w/d
   *  permissions on the container — read, add, create, write, delete. */
  sasToken: string;
  /** Blob endpoint override, e.g. `https://varysprod.blob.core.windows.net`.
   *  Defaults to the public `<account>.blob.core.windows.net` host. */
  endpoint?: string;
}

/**
 * Azure Blob backend. Authenticates with a container/account SAS — no account key
 * is held by the process. `getUrl` returns the SAME API-proxied route as local
 * (see `artifactRoute`): the API downloads the blob and streams it, so no Azure
 * CORS config is needed and the SAS never reaches the browser.
 */
export class AzureBlobAdapter implements StorageAdapter {
  private readonly container: ContainerClient;

  constructor(cfg: AzureBlobConfig) {
    const endpoint = (cfg.endpoint ?? `https://${cfg.account}.blob.core.windows.net`).replace(
      /\/+$/,
      "",
    );
    const sas = cfg.sasToken.replace(/^\?/, "");
    this.container = new ContainerClient(`${endpoint}/${cfg.container}?${sas}`);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    await this.container.getBlockBlobClient(key).uploadData(bytes);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await this.container.getBlockBlobClient(key).downloadToBuffer();
    } catch (err) {
      // A missing blob is a normal "not found" (callers handle null); anything else
      // (auth/SAS/network) must surface rather than masquerade as a 404.
      if (err instanceof RestError && err.statusCode === 404) return null;
      throw err;
    }
  }

  getUrl(key: string): string {
    return artifactRoute(key);
  }

  async delete(key: string): Promise<void> {
    await this.container.getBlockBlobClient(key).deleteIfExists();
  }
}

/**
 * Build the storage adapter from the environment — the single selection point used
 * by BOTH the API (StorageModule) and the worker, so they always agree on backend.
 *
 *   VARYS_STORAGE_DRIVER=local  (default) → LocalFsAdapter(VARYS_STORAGE_DIR)
 *   VARYS_STORAGE_DRIVER=azure            → AzureBlobAdapter(AZURE_STORAGE_*)
 *
 * Local stays the default so dev and the docker-compose stack work with zero new
 * vars; set the driver to `azure` (plus the three AZURE_STORAGE_* vars) in prod.
 */
export function createStorageFromEnv(): StorageAdapter {
  const driver = (process.env.VARYS_STORAGE_DRIVER ?? "local").trim().toLowerCase();

  if (driver === "azure") {
    const account = process.env.AZURE_STORAGE_ACCOUNT;
    const container = process.env.AZURE_STORAGE_CONTAINER;
    const sasToken = process.env.AZURE_STORAGE_SAS_TOKEN;
    if (!account || !container || !sasToken) {
      throw new Error(
        "VARYS_STORAGE_DRIVER=azure requires AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_CONTAINER and AZURE_STORAGE_SAS_TOKEN",
      );
    }
    return new AzureBlobAdapter({
      account,
      container,
      sasToken,
      endpoint: process.env.AZURE_STORAGE_BLOB_ENDPOINT,
    });
  }

  if (driver !== "local") {
    throw new Error(`Unknown VARYS_STORAGE_DRIVER "${driver}" (expected "local" or "azure")`);
  }
  return new LocalFsAdapter(process.env.VARYS_STORAGE_DIR ?? "./.varys-artifacts");
}
