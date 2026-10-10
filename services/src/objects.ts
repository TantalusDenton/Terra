import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { keccak256, type Hex } from 'viem';
import { json } from './types.js';

export interface ObjectStorage {
  put(bytes: Uint8Array, mime: string): Promise<Hex>;
  get(hash: Hex): Promise<{ bytes: Buffer; mime: string }>;
}
export class FileObjectStorage implements ObjectStorage {
  constructor(private directory: string) {}
  private path(hash: Hex): string {
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid object hash');
    return resolve(this.directory, hash.slice(2, 4), hash.slice(2));
  }
  async put(bytes: Uint8Array, mime: string): Promise<Hex> {
    const hash = keccak256(bytes);
    const path = this.path(hash);
    await mkdir(resolve(path, '..'), { recursive: true });
    try { await writeFile(path, bytes, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const metadataPath = `${path}.json`;
    try { await writeFile(metadataPath, json({ hash, mime, size: bytes.length }), { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    // Existing bytes are verified too; storage corruption must never be silently accepted.
    const stored = await this.get(hash);
    if (stored.bytes.length !== bytes.length) throw new Error('Object collision or corruption');
    return hash;
  }
  async get(hash: Hex): Promise<{ bytes: Buffer; mime: string }> {
    const path = this.path(hash);
    const [bytes, metadata] = await Promise.all([readFile(path), readFile(`${path}.json`, 'utf8')]);
    if (keccak256(bytes) !== hash) throw new Error('Object integrity verification failed');
    return { bytes, mime: String(JSON.parse(metadata).mime) };
  }
}

export async function validateLogo(bytes: Buffer): Promise<{ mime: string; width: number; height: number }> {
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) throw new Error('Logo must be at most 2 MiB');
  const image = sharp(bytes, { limitInputPixels: 4096 * 4096, failOn: 'warning' });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096 || (metadata.pages ?? 1) !== 1) throw new Error('Logo dimensions must be at most 4096 × 4096; animated logos are unsupported');
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new Error('Logo must be PNG, JPEG, or WebP');
  // Decode to detect corrupt/truncated data; original bytes alone are retained.
  await image.raw().toBuffer();
  return { mime: metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`, width: metadata.width, height: metadata.height };
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, json(value));
  await rename(temporary, path);
}
