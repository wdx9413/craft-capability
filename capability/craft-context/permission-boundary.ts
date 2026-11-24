/** Craft Context plugin permission & data boundary model for the Codex host. */

import type { JsonObject } from 'craft-common-store-local/store';
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const PERMISSION_SCHEMA_VERSION = "craft-context.permission.v1";

export type PermissionEffect = "allow" | "deny";

export interface PermissionRule {
  /** Stable, human-readable rule id. */
  readonly id: string;
  /** Member this rule applies to: knowledge | memory | experience | codebase | notes | all. */
  readonly member: string;
  /** Effect applied when the rule matches. */
  readonly effect: PermissionEffect;
  /** Explicit canonical realpath filesystem root. Resolve symlinks before calling decidePermission; empty prefixes never grant access. */
  readonly path_prefix?: string;
  /** Whether the rule covers write operations (file/edit/write/apply/patch). */
  readonly writes?: boolean;
  /** Whether the rule covers read operations (read/search/index/resolve). */
  readonly reads?: boolean;
  /** Whether the rule covers execution (run command / invoke procedure / verify). */
  readonly executes?: boolean;
  /** Optional justification recorded in audit output. */
  readonly reason?: string;
}

export interface PermissionModel {
  readonly schema_version: string;
  readonly host: "codex";
  readonly rules: PermissionRule[];
  /** When true, no data may leave the local machine; remote sync is disabled. */
  readonly local_only: boolean;
  /** Credentials and secrets must never be persisted by this plugin. */
  readonly no_credentials: boolean;
  /** Default effect when no rule matches. */
  readonly default_effect: PermissionEffect;
}

const SECRET_MARKER = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;

/** The default permission surface shipped with the craft-context Codex plugin.
 *
 * A deny-by-default policy. The runtime must add canonical workspace and data
 * roots before any path can be allowed; this static model cannot infer them.
 * Credentials are never persisted.
 * Codebase is read-only; execution is not granted by default.
 */
export const DEFAULT_PERMISSION_MODEL: PermissionModel = {
  schema_version: PERMISSION_SCHEMA_VERSION,
  host: "codex",
  local_only: true,
  no_credentials: true,
  default_effect: "deny",
  rules: [
    { id: "deny-codebase-write", member: "codebase", effect: "deny", writes: true, executes: true, reason: "Codebase member is read-only" },
  ],
};

function isRemotePath(path: string): boolean {
  if (/^(?:\\\\|\/\/)/u.test(path)) return true;
  if (/^file:\/\//iu.test(path)) {
    try { return /^(?:\\\\|\/\/)[^\\/]/u.test(fileURLToPath(path)); }
    catch { return true; }
  }
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(path);
}

function globMatchPrefix(target: string, prefix: string): boolean {
  let targetPath = target, prefixPath = prefix;
  try {
    if (/^file:\/\//iu.test(targetPath)) targetPath = fileURLToPath(targetPath);
    if (/^file:\/\//iu.test(prefixPath)) prefixPath = fileURLToPath(prefixPath);
  } catch { return false; }
  const isWindowsAbsolute = (value: string): boolean => /^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\]/u.test(value);
  const windowsPath = isWindowsAbsolute(targetPath) || isWindowsAbsolute(prefixPath);
  if (windowsPath) {
    if (!isWindowsAbsolute(targetPath) || !isWindowsAbsolute(prefixPath)) return false;
    const remainder = win32.relative(win32.resolve(prefixPath), win32.resolve(targetPath));
    return remainder === "" || (!win32.isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${win32.sep}`));
  }
  if (!isAbsolute(targetPath) || !isAbsolute(prefixPath)) return false;
  const remainder = relative(resolve(prefixPath), resolve(targetPath));
  return remainder === "" || (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

function operationMatches(rule: PermissionRule, operation: "read" | "write" | "execute"): boolean {
  return operation === "read" ? rule.reads === true : operation === "write" ? rule.writes === true : rule.executes === true;
}

export interface PermissionDecision {
  readonly allowed: boolean;
  readonly rule_id: string | null;
  readonly reason: string;
}

export function decidePermission(model: PermissionModel, member: string, path: string, operation: "read" | "write" | "execute"): PermissionDecision {
  // This pure lexical check requires callers to resolve symlinks for both the
  // operation target and configured roots before asking for a decision. The
  // filesystem operation must still enforce the same root without TOCTOU gaps.
  // A local-only policy cannot read or mutate a remote surface.
  if (model.local_only && isRemotePath(path)) {
    return { allowed: false, rule_id: "deny-remote-surface", reason: "remote surface not permitted" };
  }

  const applicable: PermissionRule[] = [];
  for (const rule of model.rules) {
    if (rule.member !== "all" && rule.member !== member) continue;
    if (rule.path_prefix === undefined || !rule.path_prefix.trim()) {
      if (rule.effect !== "deny") continue;
    } else if (!globMatchPrefix(path, rule.path_prefix)) continue;
    if (!operationMatches(rule, operation)) continue;
    applicable.push(rule);
  }

  if (applicable.length === 0) return { allowed: model.default_effect === "allow", rule_id: null, reason: "no matching rule" };

  // Deny rules win over allow rules (most restrictive).
  const deny = applicable.find((rule) => rule.effect === "deny");
  if (deny) return { allowed: false, rule_id: deny.id, reason: deny.reason ?? "denied by rule" };

  const allow = applicable[0];
  return { allowed: true, rule_id: allow.id, reason: allow.reason ?? "allowed by rule" };
}

/** Reject any statement or payload that embeds credentials or placeholder tokens. */
export function rejectsCredentials(payload: unknown): { rejected: boolean; reason: string | null } {
  let text: string;
  try { text = JSON.stringify(payload); }
  catch { return { rejected: true, reason: "payload cannot be safely serialized" }; }
  if (SECRET_MARKER.test(text)) return { rejected: true, reason: "credential or placeholder token detected" };
  return { rejected: false, reason: null };
}

export function serializePermissionModel(model: PermissionModel): string {
  return JSON.stringify({ schema_version: model.schema_version, host: model.host, local_only: model.local_only, no_credentials: model.no_credentials, default_effect: model.default_effect, rule_count: model.rules.length }, null, 2);
}
