import assert from "node:assert/strict";
import test from "node:test";
import * as notes from "../index.ts";

test("the package entry re-exports the public Notes surface", () => {
  assert.equal(typeof notes.CraftNotesRegistry, "function");
  assert.equal(typeof notes.CraftNotesLocationRegistry, "function");
  assert.equal(typeof notes.canonicalizeNotePath, "function");
  assert.equal(notes.NOTE_USAGE_THRESHOLD, 3);
  assert.equal(notes.NOTE_USAGE_WINDOW_DAYS, 30);
  assert.equal(notes.NOTE_INDEPENDENT_SESSION_THRESHOLD, 2);
  assert.equal(notes.CRAFT_NOTES_LOCATION_USE_THRESHOLD, 3);
});
