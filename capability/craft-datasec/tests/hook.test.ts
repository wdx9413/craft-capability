import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { blank, blankResult, FAILURE, handleHook, hidden, type Event, type HookInput, type Host } from "../hook.ts";
import { DEFAULT_RULES, type Json, type Rule } from "../rules.ts";
import { TokenVault } from "../vault.ts";

const PHONE = ["138", "1234", "5678"].join("");
const TOKEN = /\[CRAFT_DATASEC_[a-z0-9_]+_[a-f0-9]{32}\]/gu;

function fixture(): { root: string; close(): void } {
  const temp = mkdtempSync(join(tmpdir(), "craft-datasec-hook-"));
  return { root: join(temp, "vault"), close() { rmSync(temp, { recursive: true, force: true }); } };
}

function sessionDirectory(root: string, session: string): string {
  return join(root, createHash("sha256").update(session).digest("hex"));
}

function run(host: Host, event: Event, input: HookInput, root: string, rules: readonly Rule[] = DEFAULT_RULES): Record<string, any> {
  return handleHook(host, event, { hook_event_name: event, session_id: "fixture-session", ...input }, root, rules) as Record<string, any>;
}

test("UserPromptSubmit never inspects, sanitizes or creates the vault", () => {
  const f = fixture();
  try {
    assert.deepEqual(run("claude", "UserPromptSubmit", { prompt: PHONE }, f.root), {});
    assert.deepEqual(run("codex", "UserPromptSubmit", { hook_event_name: "wrong" }, f.root, []), {});
    assert.equal(existsSync(f.root), false);
  } finally {
    f.close();
  }
});

test("hidden and blank produce closed host-shaped fallbacks", () => {
  const replacement = { stdout: "safe" };
  assert.deepEqual(hidden("claude", "why", replacement), {
    systemMessage: "why",
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: replacement },
  });
  assert.deepEqual(hidden("codex", "why", replacement), {
    decision: "block",
    reason: JSON.stringify(replacement),
    systemMessage: "why",
  });
  assert.deepEqual(blankResult({
    text: "text",
    image: "image",
    base64: "base64",
    file: "file",
    resource: "resource",
    tool_result: "tool_result",
    other: "secret",
    number: Number(PHONE),
    flag: false,
    nil: null,
    list: ["text", "secret", 3],
    "bad key": { inner: "secret" },
  }), {
    text: "text",
    image: "image",
    base64: "base64",
    file: "file",
    resource: "resource",
    tool_result: "tool_result",
    other: "",
    number: 0,
    flag: false,
    nil: null,
    list: ["text", "", 0],
    hidden_11: { inner: "" },
  });
  assert.equal(blank(true), true);
  let deep: Json = PHONE;
  for (let index = 0; index < 70; index += 1) deep = index % 2 === 0 ? { child: deep } : [deep];
  assert(!JSON.stringify(blankResult(deep)).includes(PHONE));
});

test("PreToolUse denies sensitive arguments before any vault is created", () => {
  const f = fixture();
  try {
    assert.equal(run("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: `echo ${PHONE}` } }, f.root)
      .hookSpecificOutput.permissionDecision, "deny");
    assert.equal(run("codex", "PreToolUse", { tool_name: "mcp__remote__send", tool_input: { nested: [PHONE] } }, f.root)
      .hookSpecificOutput.permissionDecision, "deny");
    assert.equal(existsSync(f.root), false);
  } finally {
    f.close();
  }
});

test("binary Read targets are refused and every other safe shape passes through", () => {
  const f = fixture();
  try {
    const payloads: Array<[string, Json | undefined]> = [
      ["Read", undefined], ["Read", null], ["Read", []], ["Read", "text"], ["Read", {}],
      ["Read", { file_path: 42 }], ["Read", { file_path: "safe.java" }], ["Read", { file_path: "notes.txt" }],
      ["", {}], ["Write", { file_path: "plain.md" }],
    ];
    for (const [tool_name, tool_input] of payloads) {
      assert.deepEqual(run("claude", "PreToolUse", { tool_name, tool_input }, f.root), {});
    }
    for (const path of ["data.XLSX", "archive .ZIP", "clip.mp4", "sound.WAV"]) {
      assert.equal(run("codex", "PreToolUse", { tool_name: "Read", tool_input: { file_path: path } }, f.root)
        .hookSpecificOutput.permissionDecision, "deny", path);
    }
    for (const path of ["report.pdf.txt", "README.md", "plain"]) {
      assert.deepEqual(run("codex", "PreToolUse", { tool_name: "Read", tool_input: { file_path: path } }, f.root), {}, path);
    }
  } finally {
    f.close();
  }
});

test("PostToolUse sanitizes values, flushes once and restores only through local edit tools", () => {
  const f = fixture();
  const temp = join(f.root, "..");
  try {
    const response: Json = { type: "text", stdout: `call ${PHONE}`, count: 2, nested: [PHONE, { password: "hunter2" }] };
    const posted = run("codex", "PostToolUse", { tool_name: "Bash", tool_response: response }, f.root);
    assert.match(posted.systemMessage, /已在本地脱敏/u);
    const safe = JSON.parse(posted.reason) as Json;
    const serialized = JSON.stringify(safe);
    assert(!serialized.includes(PHONE));
    const tokens = [...new Set(serialized.match(TOKEN) ?? [])];
    assert.equal(tokens.length, 1);
    const token = tokens[0];
    const database = sessionDirectory(join(f.root, "codex"), "fixture-session");
    assert(!existsSync(join(database, "mappings.sqlite")));
    assert(readdirSync(database).some(name => name.endsWith(".json")));

    const edit = run("codex", "PreToolUse", {
      tool_name: "Edit",
      tool_input: { old_string: `old ${token}`, new_string: [token, { [token]: token }] },
    }, f.root);
    assert.deepEqual(edit.hookSpecificOutput, {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { old_string: `old ${PHONE}`, new_string: [PHONE, { [PHONE]: PHONE }] },
    });
    for (const tool of ["Write", "MultiEdit", "NotebookEdit", "apply_patch"]) {
      assert.equal(run("codex", "PreToolUse", { tool_name: tool, tool_input: { content: token } }, f.root)
        .hookSpecificOutput.permissionDecision, "allow", tool);
    }
    assert.equal(run("codex", "PreToolUse", { tool_name: "Bash", tool_input: { command: token } }, f.root)
      .hookSpecificOutput.permissionDecision, "deny");
    assert.equal(run("codex", "PreToolUse", { tool_input: { content: token } }, f.root)
      .hookSpecificOutput.permissionDecision, "deny");
    assert.equal(run("codex", "PreToolUse", { tool_name: "Write", tool_input: { content: "[CRAFT_DATASEC_unknown]" } }, f.root)
      .hookSpecificOutput.permissionDecision, "deny");
    const scalars = run("codex", "PreToolUse", {
      tool_name: "Write",
      tool_input: { content: token, count: 2, enabled: true, nested: null },
    }, f.root);
    assert.deepEqual(scalars.hookSpecificOutput.updatedInput, { content: PHONE, count: 2, enabled: true, nested: null });

    const second = run("codex", "PostToolUse", { tool_name: "Bash", tool_response: { stdout: `again ${PHONE}` } }, f.root);
    assert.equal(second.decision, "block");
    assert.match(JSON.parse(second.reason).stdout, /again /u);
    assert(!second.reason.includes(PHONE));

    const restored = new TokenVault(f.root, "fixture-session", "codex");
    try {
      const postedToken = run("claude", "PostToolUse", { tool_response: { stdout: PHONE } }, f.root)
        .hookSpecificOutput.updatedToolOutput.stdout as string;
      restored.flush();
      const foreign = run("codex", "PostToolUse", { tool_response: { stdout: PHONE } }, f.root);
      assert.equal(foreign.decision, "block");
      const forged = postedToken.replace(/\[CRAFT_DATASEC_phone_[a-f0-9]{32}\]/u,
        `[CRAFT_DATASEC_phone_${"e".repeat(32)}]`);
      const unconsumed = run("claude", "PostToolUse", { tool_response: `${PHONE} ${forged} ${forged}` }, f.root);
      assert.match(unconsumed.hookSpecificOutput.updatedToolOutput, /eeee/u);
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});

test("safe results and results without PII are returned unchanged", () => {
  const f = fixture();
  try {
    assert.deepEqual(run("claude", "PostToolUse", { tool_response: "nothing sensitive" }, f.root), {});
    assert.deepEqual(run("codex", "PostToolUse", { tool_response: { stdout: "still safe" } }, f.root), {});
    assert.deepEqual(run("codex", "PostToolUse", { tool_response: null }, f.root), {});
  } finally {
    f.close();
  }
});

test("event mismatch and missing results fall back without leaking input", () => {
  const f = fixture();
  try {
    const mismatch = run("claude", "PreToolUse", { hook_event_name: "PostToolUse", tool_input: { command: PHONE } }, f.root);
    assert.equal(mismatch.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(mismatch.hookSpecificOutput.permissionDecisionReason, FAILURE);

    const missing = run("codex", "PostToolUse", {}, f.root);
    assert.equal(missing.continue, false);
    assert.equal(missing.stopReason, FAILURE);
    assert.equal(JSON.parse(missing.reason), null);

    const malformed = run("claude", "PostToolUse", { session_id: undefined, tool_response: { stdout: PHONE, count: 12 } }, f.root);
    assert.equal(malformed.continue, false);
    assert.equal(malformed.hookSpecificOutput.updatedToolOutput.stdout, "");
    assert(!JSON.stringify(malformed).includes(PHONE));
  } finally {
    f.close();
  }
});

test("rejected rules and an unwritable vault map to closed failure responses", () => {
  const f = fixture();
  const temp = join(f.root, "..");
  try {
    const noRules = run("claude", "PostToolUse", { tool_response: PHONE }, f.root, []);
    assert.equal(noRules.continue, false);
    assert(!JSON.stringify(noRules).includes(PHONE));
    const withRules = run("codex", "PostToolUse", { tool_response: PHONE }, f.root, DEFAULT_RULES);
    assert.equal(withRules.decision, "block");

    const blockedRoot = join(temp, "not-a-directory");
    writeFileSync(blockedRoot, "x");
    const blocked = run("claude", "PostToolUse", { tool_response: { stdout: PHONE } }, blockedRoot);
    assert.equal(blocked.continue, false);
    assert(!JSON.stringify(blocked).includes(PHONE));
    const restoreFailed = run("claude", "PreToolUse", { tool_name: "Edit", tool_input: { content: "[CRAFT_DATASEC_phone_broken]" } }, blockedRoot);
    assert.equal(restoreFailed.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(restoreFailed.hookSpecificOutput.permissionDecisionReason, FAILURE);
    const denied = run("claude", "PreToolUse", { tool_name: "Edit", tool_input: { content: "[CRAFT_DATASEC_phone_broken]" } }, blockedRoot);
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    f.close();
  }
});

test("pending tokens can be flushed when an existing vault already holds other mappings", () => {
  const f = fixture();
  try {
    const vault = new TokenVault(f.root, "fixture-session", "codex");
    vault.token("identity", ["110105", "19900307", "6754"].join(""));
    vault.flush();
    vault.close();
    const posted = run("codex", "PostToolUse", { tool_response: { stdout: PHONE } }, f.root);
    assert.equal(posted.decision, "block");
    assert.equal(readdirSync(sessionDirectory(join(f.root, "codex"), "fixture-session")).filter(name => name.startsWith(".write-")).length, 0);
  } finally {
    f.close();
  }
});


test("session mappings remain available for a resumed session", () => {
  const f = fixture();
  try {
    run("codex", "PostToolUse", {tool_response: PHONE}, f.root);
    const directory = sessionDirectory(join(f.root, "codex"), "fixture-session");
    assert.equal(existsSync(directory), true);
    assert.deepEqual(run("codex", "UserPromptSubmit", { prompt: "resume" }, f.root), {});
    assert.equal(existsSync(directory), true);
  } finally { f.close(); }
});
