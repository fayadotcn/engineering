import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

// StorageProvider interface — LocalStorage now, S3-compatible later.

export interface StorageProvider {
  put(buffer: Buffer, ext: string): Promise<string>;
  get(storageKey: string): Promise<Buffer>;
  resolve(storageKey: string): string;
  delete(storageKey: string): Promise<void>;
}

const root = () => path.resolve(process.cwd(), process.env.STORAGE_DIR ?? "./storage");
/** 键必须落在存储根内——防 ../ 逃逸（键来自 DB，理论上自己生成，仍做纵深防御） */
const safePath = (storageKey: string) => {
  const full = path.resolve(root(), storageKey);
  if (full !== root() && !full.startsWith(root() + path.sep)) throw new Error("非法存储键");
  return full;
};

export class LocalStorage implements StorageProvider {
  async put(buffer: Buffer, ext: string): Promise<string> {
    const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${ext}`;
    const full = safePath(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buffer);
    return key;
  }
  async get(storageKey: string): Promise<Buffer> {
    return readFile(safePath(storageKey));
  }
  resolve(storageKey: string): string {
    return safePath(storageKey);
  }
  async delete(storageKey: string): Promise<void> {
    await unlink(safePath(storageKey)).catch(() => {});
  }
}

export const storage: StorageProvider = new LocalStorage();
