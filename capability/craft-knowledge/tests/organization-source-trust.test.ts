import assert from "node:assert/strict";
import test from "node:test";
import { trustedOrganizationSourceDigests } from "../organization-source-trust.ts";

test("global source allowlist binds each ID to one exact immutable identity digest", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(trustedOrganizationSourceDigests(undefined), new Map());
  assert.deepEqual(trustedOrganizationSourceDigests("  "), new Map());
  assert.deepEqual(trustedOrganizationSourceDigests("bad-json"), new Map());
  assert.deepEqual(trustedOrganizationSourceDigests("{}"), new Map());
  assert.deepEqual(trustedOrganizationSourceDigests(JSON.stringify(["source-id"])), new Map());
  assert.deepEqual(trustedOrganizationSourceDigests(JSON.stringify([{ id: "invalid id", identity_digest: digest }])), new Map());
  assert.deepEqual(trustedOrganizationSourceDigests(JSON.stringify([{ id: "source", identity_digest: "not-a-digest" }])), new Map());
  assert.deepEqual(trustedOrganizationSourceDigests(JSON.stringify([
    { id: "source", identity_digest: digest }, { id: "source", identity_digest: digest },
  ])), new Map());
  assert.deepEqual(trustedOrganizationSourceDigests(JSON.stringify([{ id: "source", identity_digest: digest }])), new Map([["source", digest]]));
});
