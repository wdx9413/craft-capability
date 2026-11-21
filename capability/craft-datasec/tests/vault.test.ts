import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { isPrivateDirectory, isPrivateFile, TokenVault } from "../vault.ts";

test("node:sqlite is available to the vault", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
  database.close();
});

function directory(): string {
  return mkdtempSync(join(tmpdir(), "craft-datasec-vault-"));
}

test("privacy checks enforce POSIX ownership and modes", () => {
  const stat = (mode: number, isDir: boolean, link = false) => ({
    mode,
    uid: 1000,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => link,
  });
  assert.equal(isPrivateDirectory(stat(0o700, true), "linux", 1000), true);
  assert.equal(isPrivateDirectory(stat(0o750, true), "linux", 1000), false);
  assert.equal(isPrivateDirectory(stat(0o700, true), "linux", 1001), false);
  assert.equal(isPrivateDirectory(stat(0o755, false), "win32", 1000), false);
  assert.equal(isPrivateDirectory(stat(0o777, true, true), "linux", 1000), false);
  assert.equal(isPrivateFile(stat(0o600, false), "linux", 1000), true);
  assert.equal(isPrivateFile(stat(0o640, false), "linux", 1000), false);
  assert.equal(isPrivateFile(stat(0o600, false), "linux", undefined), false);
  assert.equal(isPrivateFile(stat(0o755, true), "linux", 1000), false);
});

test("default uid lookup is used when the caller does not pass one", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  try {
    const stat = { mode: 0o700, uid: 1000, isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false };
    assert.equal(isPrivateDirectory(stat, "linux"), true);
    assert.equal(isPrivateFile(stat, "linux"), true);
  } finally {
    if (descriptor) Object.defineProperty(process, "getuid", descriptor);
    else delete (process as unknown as Record<string, unknown>).getuid;
  }
});

test("tokens round-trip immediately and persist across vault instances", () => {
  const root = directory();
  try {
    const first = new TokenVault(root, "session-a");
    const token = first.token("phone", "13812345678");
    assert.equal(first.token("phone", "13812345678"), token);
    assert.match(token, /^\[CRAFT_DATASEC_phone_[a-f0-9]{32}\]$/u);
    assert.equal(first.restore(token), "13812345678");
    first.flush();
    first.flush();
    first.close();
    const second = new TokenVault(root, "session-a");
    assert.equal(second.restore(`call ${token} now`), "call 13812345678 now");
    assert.equal(second.token("phone", "13812345678"), token);
    second.flush();
    second.close();
    assert.equal(readdirSync(root).filter(name => name !== "publish").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore rejects unknown, edited and malformed placeholders", () => {
  const root = directory();
  const vault = new TokenVault(root, "session-b");
  try {
    assert.throws(() => vault.restore("[CRAFT_DATASEC_phone_0123456789abcdef0123456789abcdef]"), /Unknown mapping/u);
    const token = vault.token("phone", "synthetic-value");
    vault.flush();
    assert.equal(vault.restore(token), "synthetic-value");
    const forged = token.replace(/phone_[a-f0-9]{32}/u, `phone_${"f".repeat(32)}`);
    assert.throws(() => vault.restore(forged), /Unknown mapping/u);
    assert.throws(() => vault.restore("[CRAFT_DATASEC_phone_broken"), /Unknown placeholder/u);
    assert.equal(vault.restore("no tokens here"), "no tokens here");
  } finally {
    vault.close();
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("vault construction validates sessions, keys and safe directories", () => {
  const root = directory();
  try {
    assert.throws(() => new TokenVault(root, ""), /Missing session/u);
    const directoryPath = join(root, "not-a-directory");
    writeFileSync(directoryPath, "x");
    assert.throws(() => new TokenVault(directoryPath, "s"));
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link, "junction");
    assert.throws(() => new TokenVault(link, "s"), /Unsafe vault directory/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vault refuses unsafe key files and rolls back failed flushes", () => {
  const root = directory();
  const { createHash } = process.getBuiltinModule("node:crypto") as typeof import("node:crypto");
  try {
    const key = join(root, createHash("sha256").update("session-c").digest("hex"), "key");
    const first = new TokenVault(root, "session-c");
    first.close();
    writeFileSync(key, "short");
    assert.throws(() => new TokenVault(root, "session-c"), /Invalid vault key/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const failureRoot = directory();
  const vault = new TokenVault(failureRoot, "session-d");
  const link = mock.method(fs, "linkSync", () => { throw new Error("disk full"); });
  syncBuiltinESMExports();
  try {
    const token = vault.token("fixture", "synthetic-value");
    assert.throws(() => vault.flush(), /disk full/u);
    assert.equal(vault.restore(token), "synthetic-value");
    link.mock.restore(); syncBuiltinESMExports();
    vault.flush();
    assert.equal(vault.restore(token), "synthetic-value");
  } finally {
    link.mock.restore(); syncBuiltinESMExports();
    vault.close(); rmSync(failureRoot, {recursive:true,force:true});
  }

});

test("file and publication errors close descriptors and surface the original failure", () => {
  const root = directory();
  try {
    const vault = new TokenVault(root, "io");
    vault.close();
    const key = join(root, createHash("sha256").update("io").digest("hex"), "key");
    const descriptor = mock.method(fs, "fstatSync", () => ({ isFile: () => false, mode: 0o600, uid: 0 }));
    syncBuiltinESMExports();
    try {
      assert.throws(() => new TokenVault(root, "io"), /Unsafe vault file/u);
    } finally {
      descriptor.mock.restore();
      syncBuiltinESMExports();
    }
    const throwing = mock.method(fs, "fstatSync", () => { throw new Error("fstat failure"); });
    syncBuiltinESMExports();
    try {
      assert.throws(() => new TokenVault(root, "io"), /fstat failure/u);
    } finally {
      throwing.mock.restore();
      syncBuiltinESMExports();
    }
    const link = mock.method(fs, "linkSync", () => { throw Object.assign(new Error("publication failure"), { code: "EIO" }); });
    syncBuiltinESMExports();
    try {
      assert.throws(() => new TokenVault(root, "publish"), /publication failure/u);
    } finally {
      link.mock.restore();
      syncBuiltinESMExports();
    }
    const published = join(root, createHash("sha256").update("publish").digest("hex"));
    assert.equal(readdirSync(root).length, 2);
    assert.deepEqual(readdirSync(published), []);
    void key;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt mapping database is closed before the constructor rethrows", () => {
  const root = directory();
  try {
    const vault = new TokenVault(root, "corrupt");
    vault.close();
    const database = join(root, createHash("sha256").update("corrupt").digest("hex"), "mappings.sqlite");
    writeFileSync(database, "not a sqlite database", { mode: 0o600 });
    assert.throws(() => new TokenVault(root, "corrupt"), /file is not a database|not a database/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
