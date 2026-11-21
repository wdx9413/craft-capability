import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TOKEN = /\[CRAFT_DATASEC_[a-z0-9_]+_[a-f0-9]{32}\]/g;
type PrivateStat = { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean; mode: number; uid: number };

/** POSIX mode/uid checks are meaningless on Windows, where they are not enforced. */
export function isPrivateDirectory(stat: Pick<PrivateStat, "isDirectory" | "isSymbolicLink" | "mode" | "uid">,
  platform: NodeJS.Platform = process.platform, uid: number | undefined = process.getuid?.()): boolean {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  return platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === uid);
}

export function isPrivateFile(stat: Pick<PrivateStat, "isFile" | "mode" | "uid">,
  platform: NodeJS.Platform = process.platform, uid: number | undefined = process.getuid?.()): boolean {
  if (!stat.isFile()) return false;
  return platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === uid);
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!isPrivateDirectory(stat)) throw new Error("Unsafe vault directory");
}
function openPrivate(path: string, flags = constants.O_RDONLY): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!isPrivateFile(stat)) throw new Error("Unsafe vault file");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function readPrivate(path: string): Buffer {
  const fd = openPrivate(path);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
/** Publish a complete immutable record. Readers never see a half-written key or mapping. */
function publish(directory: string, name: string, value: Buffer | string): void {
  const temp = mkdtempSync(join(directory, ".write-"));
  try {
    const source = join(temp, "record");
    writeFileSync(source, value, { mode: 0o600 });
    try { linkSync(source, join(directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
export class TokenVault {
  private readonly directory: string;
  private readonly key: Buffer;
  private readonly database: DatabaseSync | undefined;
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<string, { name: string; value: string }>();
  private closed = false;
  constructor(root: string, session: string, host?: "claude" | "codex") {
    if (!session) throw new Error("Missing session identity");
    privateDirectory(root);
    if (host !== undefined) {
      if (host !== "claude" && host !== "codex") throw new Error("Invalid vault Host");
      root = join(root, host);
      privateDirectory(root);
    }
    this.directory = join(root, createHash("sha256").update(session).digest("hex"));
    privateDirectory(this.directory);
    publish(this.directory, "key", randomBytes(32));
    this.key = readPrivate(join(this.directory, "key"));
    if (this.key.length !== 32) throw new Error("Invalid vault key");
    const file = join(this.directory, "mappings.sqlite");
    if (existsSync(file)) {
      closeSync(openPrivate(file));
      this.database = new DatabaseSync(file, { readOnly: true });
      try { this.database.prepare("SELECT token, name, value FROM mappings LIMIT 0").all(); }
      catch (error) { this.database.close(); throw error; }
    }
  }

  private filename(token: string): string {
    return `${createHash("sha256").update(token).digest("hex")}.json`;
  }

  private readMapping(token: string): { name: string; value: string } | undefined {
    const file = join(this.directory, this.filename(token));
    if (!existsSync(file)) return this.database?.prepare("SELECT name, value FROM mappings WHERE token = ?").get(token) as { name: string; value: string } | undefined;
    const record = JSON.parse(readPrivate(file).toString("utf8"));
    if (record.schema !== "craft.datasec.mapping.v1" || typeof record.nonce !== "string"
      || typeof record.ciphertext !== "string" || typeof record.tag !== "string") throw new Error("Invalid mapping envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.nonce, "base64"));
    decipher.setAAD(Buffer.from(token));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
    const value = JSON.parse(plaintext.toString("utf8"));
    if (typeof value.name !== "string" || typeof value.value !== "string") throw new Error("Invalid mapping content");
    return value;
  }

  private publishMapping(token: string, record: { name: string; value: string }): void {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(token));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
    publish(this.directory, this.filename(token), JSON.stringify({ schema: "craft.datasec.mapping.v1",
      nonce: nonce.toString("base64"), ciphertext: encrypted.toString("base64"), tag: cipher.getAuthTag().toString("base64") }));
    const saved = this.readMapping(token);
    if (saved?.name !== record.name || saved.value !== record.value) throw new Error("Mapping publication conflict");
  }

  token(name: string, value: string): string {
    const cacheKey = `${name}\0${value}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const digest = createHmac("sha256", this.key).update(`${name}\0${value}`).digest("hex").slice(0, 32);
    const token = `[CRAFT_DATASEC_${name}_${digest}]`;
    this.pending.set(token, { name, value });
    this.cache.set(cacheKey, token);
    return token;
  }
  /** Immutable authenticated files are safe to publish concurrently and retry. */
  flush(): void {
    for (const [token, record] of this.pending) {
      this.publishMapping(token, record);
      this.pending.delete(token);
    }
  }
  close(): void {
    if (!this.closed) {
      this.database?.close();
      this.pending.clear();
      this.cache.clear();
      this.key.fill(0);
      this.closed = true;
    }
  }

  /** Session-end cleanup removes the mapping and key together. */
  static removeSession(root: string, session: string, host?: "claude" | "codex"): void {
    if (!session) throw new Error("Missing session identity");
    if (!existsSync(root)) return;
    if (!isPrivateDirectory(lstatSync(root))) throw new Error("Unsafe vault directory");
    if (host !== undefined) {
      if (host !== "claude" && host !== "codex") throw new Error("Invalid vault Host");
      root = join(root, host);
      if (!existsSync(root)) return;
      if (!isPrivateDirectory(lstatSync(root))) throw new Error("Unsafe vault directory");
    }
    const directory = join(root, createHash("sha256").update(session).digest("hex"));
    if (!existsSync(directory)) return;
    if (!isPrivateDirectory(lstatSync(directory))) throw new Error("Unsafe vault directory");
    rmSync(directory, { recursive: true });
  }

  restore(text: string): string {
    const restored = text.replace(TOKEN, token => {
      const record = this.pending.get(token) ?? this.readMapping(token);
      if (!record) throw new Error("Unknown mapping");
      const expected = `[CRAFT_DATASEC_${record.name}_${createHmac("sha256", this.key).update(`${record.name}\0${record.value}`).digest("hex").slice(0, 32)}]`;
      if (expected !== token) throw new Error("Invalid mapping");
      return record.value;
    });
    // Reject truncated/edited placeholders instead of silently writing them into a source file.
    if (restored.includes("[CRAFT_DATASEC_")) throw new Error("Unknown placeholder");
    return restored;
  }
}
