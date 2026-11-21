import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TokenVault } from "../vault.ts";

const secret = "synthetic-sensitive-fixture";

test("new mapping files retain authenticated ciphertext and survive reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-file-vault-"));
  const session = "file-fixture";
  try {
    const first = new TokenVault(root, session);
    const token = first.token("fixture", secret);
    first.flush(); first.close();
    const directory = join(root, createHash("sha256").update(session).digest("hex"));
    assert(!existsSync(join(directory, "mappings.sqlite")));
    const files = readdirSync(directory).filter(file => file.endsWith(".json"));
    assert.equal(files.length, 1);
    const data = readFileSync(join(directory, files[0]!), "utf8");
    assert(!data.includes(secret));
    const second = new TokenVault(root, session);
    assert.equal(second.restore(token), secret);
    second.close();
    const envelope = JSON.parse(data);
    envelope.tag = Buffer.alloc(16).toString("base64");
    writeFileSync(join(directory, files[0]!), JSON.stringify(envelope));
    const altered = new TokenVault(root, session);
    assert.throws(() => altered.restore(token));
    altered.close();
  } finally { rmSync(root, {recursive:true,force:true}); }
});


test("host boundaries and session-end cleanup keep unrelated mappings isolated", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-host-vault-"));
  try {
    const claude = new TokenVault(root, "same-session", "claude");
    const codex = new TokenVault(root, "same-session", "codex");
    const first = claude.token("fixture", secret);
    const second = codex.token("fixture", secret);
    claude.flush(); codex.flush();
    assert.notEqual(first, second);
    assert.throws(() => codex.restore(first), /Unknown mapping/u);
    assert.throws(() => claude.restore(second), /Unknown mapping/u);
    claude.close(); codex.close();
    TokenVault.removeSession(root, "same-session", "claude");
    TokenVault.removeSession(root, "same-session", "claude");
    const remaining = new TokenVault(root, "same-session", "codex");
    assert.equal(remaining.restore(second), secret);
    remaining.close();
    TokenVault.removeSession(root, "same-session", "codex");
    TokenVault.removeSession(root, "missing", "codex");
    assert.throws(() => TokenVault.removeSession(root, ""), /Missing session/u);
    assert.throws(() => TokenVault.removeSession(root, "session", "invalid" as "codex"), /Invalid vault Host/u);
    assert.throws(() => new TokenVault(root, "session", "invalid" as "codex"), /Invalid vault Host/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
  TokenVault.removeSession(root, "missing", "codex");
});

test("legacy SQLite mappings remain read compatible without claiming a Host", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-legacy-vault-"));
  try {
    const original = new TokenVault(root, "legacy-session");
    const token = original.token("fixture", secret);
    original.close();
    const directory = join(root, createHash("sha256").update("legacy-session").digest("hex"));
    const file = join(directory, "mappings.sqlite");
    writeFileSync(file, "", { mode: 0o600 });
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE mappings (token TEXT PRIMARY KEY, name TEXT NOT NULL, value TEXT NOT NULL)");
    database.prepare("INSERT INTO mappings VALUES (?, ?, ?)").run(token, "fixture", secret);
    database.close();
    const before = readFileSync(file);
    const legacy = new TokenVault(root, "legacy-session");
    assert.equal(legacy.restore(token), secret);
    const fresh = legacy.token("fixture", "synthetic-new-value");
    legacy.flush(); legacy.close();
    assert.deepEqual(readFileSync(file), before);
    const hosted = new TokenVault(root, "legacy-session", "codex");
    assert.throws(() => hosted.restore(token), /Unknown mapping/u);
    hosted.close();
    const reopened = new TokenVault(root, "legacy-session");
    assert.equal(reopened.restore(fresh), "synthetic-new-value");
    reopened.close();
    assert.equal(statSync(join(directory, "key")).mode & 0o777, 0o600);
    for (const name of readdirSync(directory).filter(name => name.endsWith(".json"))) {
      assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an interrupted zero-byte legacy database is treated as having no mappings", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-empty-legacy-vault-"));
  try {
    const original = new TokenVault(root, "interrupted-session");
    const token = original.token("fixture", secret);
    original.flush(); original.close();
    const directory = join(root, createHash("sha256").update("interrupted-session").digest("hex"));
    for (const name of readdirSync(directory).filter(name => name.endsWith(".json"))) unlinkSync(join(directory, name));
    writeFileSync(join(directory, "mappings.sqlite"), "", { mode: 0o600 });
    const recovered = new TokenVault(root, "interrupted-session");
    assert.throws(() => recovered.restore(token), /Unknown mapping/u);
    recovered.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("invalid encrypted records and unsafe cleanup targets fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-invalid-vault-"));
  try {
    const vault = new TokenVault(root, "session");
    const token = vault.token("fixture", secret);
    vault.flush();
    const directory = join(root, createHash("sha256").update("session").digest("hex"));
    const file = join(directory, createHash("sha256").update(token).digest("hex") + ".json");
    const key = readFileSync(join(directory, "key"));
    const envelope = (value: unknown) => {
      const nonce = Buffer.alloc(12, 1);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(token));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return JSON.stringify({ schema: "craft.datasec.mapping.v1", nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
    };
    writeFileSync(file, JSON.stringify({schema:"wrong"}));
    assert.throws(() => vault.restore(token), /Invalid mapping envelope/u);
    writeFileSync(file, envelope({name: 1, value: secret}));
    assert.throws(() => vault.restore(token), /Invalid mapping content/u);
    writeFileSync(file, envelope({name: "fixture", value: "changed"}));
    assert.throws(() => vault.restore(token), /Invalid mapping/u);
    vault.token("fixture", secret);
    vault.close();
    const retry = new TokenVault(root, "session");
    retry.token("fixture", secret);
    assert.throws(() => retry.flush(), /Mapping publication conflict/u);
    retry.close();
    TokenVault.removeSession(root, "none", "codex");
    if (process.platform !== "win32") {
      chmodSync(directory, 0o755);
      assert.throws(() => TokenVault.removeSession(root, "session"), /Unsafe vault directory/u);
      chmodSync(directory, 0o700);
      mkdirSync(join(root, "codex"), {mode:0o755});
      assert.throws(() => TokenVault.removeSession(root, "session", "codex"), /Unsafe vault directory/u);
      chmodSync(root, 0o755);
      assert.throws(() => TokenVault.removeSession(root, "session"), /Unsafe vault directory/u);
      chmodSync(root, 0o700);
    }
  } finally { rmSync(root, {recursive:true,force:true}); }
});
