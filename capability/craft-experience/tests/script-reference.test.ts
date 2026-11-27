import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { stableDigest } from "craft-common-base/digest";
import type { CraftStore } from "craft-common-store-local/store";
import { captureDocumentReference, captureScriptReference, scriptReferenceStatus } from "../script-reference.ts";

test("script reference is scoped to the registered project and detects changes", () => {
  const root = mkdtempSync(join(tmpdir(), "experience-script-"));
  try {
    const project = join(root, "project"); mkdirSync(project);
    const path = join(project, "check.sh"); writeFileSync(path, "first");
    const alias = { status: "active", alias_kind: "path", alias: project, alias_digest: stableDigest(project), scope: { kind: "project", id: "project:p" } };
    const store = { list(_kind: string, _limit: number, predicate: (value: unknown) => boolean) { return [alias].filter(predicate); } } as unknown as CraftStore;
    const reference = captureScriptReference(store, "project:p", path);
    assert.equal(scriptReferenceStatus(reference), "current");
    writeFileSync(path, "second");
    assert.equal(scriptReferenceStatus(reference), "changed");
    rmSync(path);
    assert.equal(scriptReferenceStatus(reference), "unavailable");
    const outside = join(root, "outside"); writeFileSync(outside, "data");
    assert.throws(() => captureScriptReference(store, "project:p", outside), /inside its project/u);
    const outsideDir = join(root, "other"); mkdirSync(outsideDir);
    const outsideScript = join(outsideDir, "script.sh"); writeFileSync(outsideScript, "outside");
    const linkDir = join(project, "linked"); symlinkSync(outsideDir, linkDir);
    assert.throws(() => captureScriptReference(store, "project:p", join(linkDir, "script.sh")), /inside its project/u);
    symlinkSync(outside, path);
    assert.throws(() => captureScriptReference(store, "project:p", path), /regular file/u);
    assert.throws(() => captureScriptReference(store, "project:other", outside), /unavailable or ambiguous/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("script inspection works when the platform lacks O_NOFOLLOW", () => {
  const root = mkdtempSync(join(tmpdir(), "experience-no-nofollow-"));
  try {
    const file = join(root, "script"); writeFileSync(file, "source");
    const shim = join(root, "fs-shim.mjs"), loader = join(root, "loader.mjs"), entry = join(root, "entry.mjs");
    writeFileSync(shim, 'export * from "node:fs"; import { constants as original } from "node:fs"; export const constants = { ...original, O_NOFOLLOW: undefined };');
    writeFileSync(loader, `export async function resolve(specifier, context, next) { if (specifier === "node:fs" && context.parentURL?.endsWith("script-reference.ts")) return { url: ${JSON.stringify(pathToFileURL(shim).href)}, shortCircuit: true }; return next(specifier, context); }`);
    const moduleUrl = new URL("../script-reference.ts", import.meta.url).href;
    writeFileSync(entry, `import { captureScriptReference } from ${JSON.stringify(moduleUrl)}; import { createHash } from "node:crypto"; const root = ${JSON.stringify(root)}, file = ${JSON.stringify(file)}; const digest = "sha256:" + createHash("sha256").update(JSON.stringify(root)).digest("hex"); const store = { list: (_k,_n,p) => [{ status:"active", alias_kind:"path", alias:root, alias_digest:digest, scope:{kind:"project",id:"project:p"} }].filter(p) }; if (!captureScriptReference(store,"project:p",file).digest) throw Error("missing digest");`);
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-loader", loader, entry], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("script and document capture rejects replacement and mutation during inspection", () => {
  const root = mkdtempSync(join(tmpdir(), "experience-source-race-"));
  const originals = { lstatSync: fs.lstatSync, fstatSync: fs.fstatSync, realpathSync: fs.realpathSync, openSync: fs.openSync };
  try {
    const file = join(root, "guide"); writeFileSync(file, "first");
    const alias = { status: "active", alias_kind: "path", alias: root, alias_digest: stableDigest(root), scope: { kind: "project", id: "project:p" } };
    const store = { list(_kind: string, _limit: number, predicate: (value: unknown) => boolean) { return [alias].filter(predicate); } } as unknown as CraftStore;
    let calls = 0;
    Object.assign(fs, { lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
      const result = originals.lstatSync(...args)!; calls++;
      return calls === 2 ? Object.assign(result, { ino: Number(result.ino) + 1 }) : result;
    }) as typeof fs.lstatSync }); syncBuiltinESMExports();
    assert.throws(() => captureScriptReference(store, "project:p", file), /changed during inspection/u);
    Object.assign(fs, { lstatSync: originals.lstatSync }); calls = 0;
    fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
      const result = originals.fstatSync(...args); calls++;
      return calls === 2 ? Object.assign(result, { size: Number(result.size) + 1 }) : result;
    }) as typeof fs.fstatSync; syncBuiltinESMExports();
    assert.throws(() => captureScriptReference(store, "project:p", file), /changed during inspection/u);
    fs.fstatSync = originals.fstatSync; calls = 0;
    fs.realpathSync = ((...args: Parameters<typeof fs.realpathSync>) => {
      const result = originals.realpathSync(...args); calls++;
      return calls === 3 ? `${String(result)}-replaced` : result;
    }) as typeof fs.realpathSync; syncBuiltinESMExports();
    assert.throws(() => captureScriptReference(store, "project:p", file), /changed during inspection/u);
    fs.realpathSync = originals.realpathSync; calls = 0;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      calls++; if (calls === 2) writeFileSync(file, "other");
      return originals.openSync(...args);
    }) as typeof fs.openSync; syncBuiltinESMExports();
    assert.throws(() => captureDocumentReference(store, "project:p", file, "first"), /changed during capture/u);
  } finally {
    Object.assign(fs, originals); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true });
  }
});

test("script and document source boundaries reject invalid input and unsafe global roots", () => {
  const root = mkdtempSync(join(tmpdir(), "experience-source-boundaries-"));
  try {
    const project = join(root, "project"), experience = join(root, "experience"), scripts = join(experience, "scripts");
    mkdirSync(project); mkdirSync(experience); mkdirSync(scripts);
    const alias = { status: "active", alias_kind: "path", alias: project, alias_digest: stableDigest(project), scope: { kind: "project", id: "project:p" } };
    const store = { paths: { experienceDir: experience }, list(_kind: string, _limit: number, predicate: (value: unknown) => boolean) { return [alias].filter(predicate); } } as unknown as CraftStore;
    const file = join(project, "guide.md"); writeFileSync(file, "useful evidence");
    assert.throws(() => captureScriptReference(store, "project:p", "relative"), /absolute/u);
    assert.throws(() => captureScriptReference(store, "project:p", project), /inside its project/u);
    assert.throws(() => captureDocumentReference(store, "project:p", file, " "), /nonempty/u);
    assert.throws(() => captureDocumentReference(store, "project:p", file, "x".repeat(4001)), /bounded/u);
    assert.throws(() => captureDocumentReference(store, "project:p", file, "missing"), /not present/u);
    assert.equal(captureDocumentReference(store, "project:p", file, "evidence").character_offset, 7);
    const big = join(project, "big"); writeFileSync(big, Buffer.alloc(1_000_001));
    assert.throws(() => captureScriptReference(store, "project:p", big), /bounded/u);
    const global = join(scripts, "global.sh"); writeFileSync(global, "check");
    assert.equal(scriptReferenceStatus(captureScriptReference(store, "global:global", global)), "current");
    assert.throws(() => captureScriptReference(store, "global:global", file), /global scripts directory/u);
    rmSync(global); rmSync(scripts, { recursive: true }); symlinkSync(project, scripts);
    assert.throws(() => captureScriptReference(store, "global:global", file), /regular directories/u);
    assert.equal(scriptReferenceStatus({ path: scripts, digest: "invalid" }), "changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
