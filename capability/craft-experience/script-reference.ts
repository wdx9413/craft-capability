import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CraftStore, JsonObject } from "craft-common-store-local/store";
import { stableDigest } from "craft-common-base/digest";

const MAX_SCRIPT_BYTES = 1_000_000;

/** Hash a bounded regular file through one descriptor and reject replacement or mutation. */
function readBoundedFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_SCRIPT_BYTES) throw new Error("Script must be a regular bounded file");
    const directoryEntry = lstatSync(path);
    if (!directoryEntry.isFile() || directoryEntry.isSymbolicLink() || directoryEntry.dev !== before.dev || directoryEntry.ino !== before.ino)
      throw new Error("Script changed during inspection");
    const buffer = Buffer.alloc(MAX_SCRIPT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    const currentEntry = lstatSync(path);
    if (length > MAX_SCRIPT_BYTES || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || currentEntry.isSymbolicLink() || currentEntry.dev !== before.dev || currentEntry.ino !== before.ino)
      throw new Error("Script changed during inspection");
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** Bind a script reference to one registered project and to its current bytes. */
export function captureScriptReference(store: CraftStore, scope: string, path: string): JsonObject {
  if (!isAbsolute(path)) throw new Error("script_path must be absolute");
  const scriptPath = resolve(path);
  if (lstatSync(scriptPath).isSymbolicLink()) throw new Error("Script must be a regular file");
  const realPath = realpathSync(scriptPath);
  if (scope === "global:global") {
    const scriptsDir = join(store.paths.experienceDir, "scripts");
    for (const directory of [store.paths.experienceDir, scriptsDir]) {
      const entry = lstatSync(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Global scripts directory must use regular directories");
    }
    const root = realpathSync(scriptsDir);
    const inside = relative(root, realPath);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Global script must be inside the global scripts directory");
  } else {
    const aliases = store.list("scope_alias", 10_000, item => item.status === "active" && item.alias_kind === "path"
      && (item.scope as JsonObject | undefined)?.kind === "project" && (item.scope as JsonObject | undefined)?.id === scope
      && typeof item.alias === "string" && item.alias_digest === stableDigest(item.alias));
    const roots = [...new Set(aliases.map(item => realpathSync(String(item.alias))))];
    if (roots.length !== 1) throw new Error("Script project root is unavailable or ambiguous");
    const inside = relative(roots[0]!, realPath);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Script must be inside its project");
  }
  const digest = `sha256:${createHash("sha256").update(readBoundedFile(realPath)).digest("hex")}`;
  if (realpathSync(scriptPath) !== realPath) throw new Error("Script changed during inspection");
  return { path: realPath, digest };
}

export function scriptReferenceStatus(reference: JsonObject): string {
  try {
    const path = String(reference.path);
    if (realpathSync(path) !== path) return "changed";
    const digest = `sha256:${createHash("sha256").update(readBoundedFile(path)).digest("hex")}`;
    return digest === reference.digest ? "current" : "changed";
  } catch { return "unavailable"; }
}

/** Require the cited excerpt to occur in the exact file revision being referenced. */
export function captureDocumentReference(store: CraftStore, scope: string, path: string, excerpt: string): JsonObject {
  if (!excerpt.trim() || excerpt.length > 4000) throw new Error("source_excerpt must be nonempty and bounded");
  const reference = captureScriptReference(store, scope, path);
  const body = readBoundedFile(String(reference.path));
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (digest !== reference.digest) throw new Error("Document changed during capture");
  const offset = body.toString("utf8").indexOf(excerpt);
  if (offset < 0) throw new Error("source_excerpt is not present in the document");
  return { ...reference, excerpt, character_offset: offset };
}
