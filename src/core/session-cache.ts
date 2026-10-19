import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Credentials } from "./credentials.js";
import { defaultConfigDirectory, writeJsonAtomically } from "./local-store.js";

const deriveKey = promisify(scrypt);
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function profileDirectory(profile: string, configDir = defaultConfigDirectory()): string {
  return join(configDir, "sessions", digest(profile));
}

/** Disposable, encrypted service cookies; passwords and encryption keys are never written here. */
export class SessionCache {
  private readonly path: string;
  private readonly scope: string;
  private expiresAt = Date.now() + MAX_AGE_MS;

  public constructor(
    private readonly credentials: Credentials,
    serviceUrl: string,
    configDir?: string,
  ) {
    const profile = credentials.profile ?? (process.env.SUSTECH_PROFILE?.trim() || "default");
    this.scope = JSON.stringify([profile, credentials.sid, serviceUrl]);
    this.path = join(profileDirectory(profile, configDir), `${digest(this.scope)}.json`);
  }

  public async load(): Promise<unknown | undefined> {
    try {
      const raw = await readFile(this.path, "utf8");
      if (raw.length > 128 * 1024) return undefined;
      const entry = JSON.parse(raw);
      if (entry.version !== 1) return undefined;
      const salt = Buffer.from(entry.salt, "base64");
      const iv = Buffer.from(entry.iv, "base64");
      const tag = Buffer.from(entry.tag, "base64");
      if (salt.length !== 32 || iv.length !== 12 || tag.length !== 16) return undefined;
      const key = await deriveKey(this.credentials.password, salt, 32) as Buffer;
      const cipher = createDecipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(this.scope));
      cipher.setAuthTag(tag);
      const payload = JSON.parse(Buffer.concat([
        cipher.update(Buffer.from(entry.encrypted, "base64")), cipher.final(),
      ]).toString("utf8"));
      if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()
        || payload.expiresAt > Date.now() + MAX_AGE_MS) return undefined;
      this.expiresAt = payload.expiresAt;
      return payload.cookies;
    } catch {
      // A missing, unreadable, corrupt or old-password cache is a cache miss.
      return undefined;
    }
  }

  public async save(cookies: unknown): Promise<void> {
    const salt = randomBytes(32);
    const iv = randomBytes(12);
    const key = await deriveKey(this.credentials.password, salt, 32) as Buffer;
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(this.scope));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify({ expiresAt: this.expiresAt, cookies }), "utf8"), cipher.final(),
    ]);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeJsonAtomically(this.path, {
      version: 1, salt: salt.toString("base64"), iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), encrypted: encrypted.toString("base64"),
    });
  }

  public async clear(): Promise<void> {
    this.expiresAt = Date.now() + MAX_AGE_MS;
    await rm(this.path, { force: true });
  }
}

export async function clearSessionCaches(profile: string, configDir?: string): Promise<void> {
  await rm(profileDirectory(profile, configDir), { recursive: true, force: true });
}
