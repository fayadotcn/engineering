import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

// StorageProvider interface — LocalStorage now, S3-compatible later.

export interface StorageProvider {
  put(buffer: Buffer, ext: string): Promise<string>;
  get(storageKey: string): Promise<Buffer>;
  resolve(storageKey: string): string;
}

const root = () => path.resolve(process.cwd(), process.env.STORAGE_DIR ?? "./storage");

export class LocalStorage implements StorageProvider {
  async put(buffer: Buffer, ext: string): Promise<string> {
    const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${ext}`;
    const full = path.join(root(), key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buffer);
    return key;
  }
  async get(storageKey: string): Promise<Buffer> {
    return readFile(path.join(root(), storageKey));
  }
  resolve(storageKey: string): string {
    return path.join(root(), storageKey);
  }
}

export const storage: StorageProvider = new LocalStorage();
