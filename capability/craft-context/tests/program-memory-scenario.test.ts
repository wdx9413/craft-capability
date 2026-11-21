import assert from "node:assert/strict";
import test from "node:test";
import { classifiedProgramMemoryScenarioMatches } from "../program-memory-governance.ts";

test("Program Memory scenario classification normalizes project IDs and requires candidate scenario identity", () => {
  const scope = { kind: "project", id: "project:repo-1" };
  const signature = { scenario_key: "incident-fix", project: { kind: "project", id: "repo-1" }, domain: "engineering" };
  assert.equal(classifiedProgramMemoryScenarioMatches([signature, signature], "incident-fix", scope), true);
  assert.equal(classifiedProgramMemoryScenarioMatches([{ ...signature, scenario_key: "other" }, { ...signature, scenario_key: "other" }], "incident-fix", scope), false);
  assert.equal(classifiedProgramMemoryScenarioMatches([{ ...signature, project: { kind: "project", id: "repo-2" } }], "incident-fix", scope), false);
  assert.equal(classifiedProgramMemoryScenarioMatches([signature, { ...signature, domain: "other" }], "incident-fix", scope), false);
});
