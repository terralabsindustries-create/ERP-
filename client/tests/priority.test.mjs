/** One priority scale everywhere: Medium (not "Normal") and no unknown values. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePriority, priorityLabel, PRIORITIES } from "../src/lib/priority.ts";

test("Normal and blank read as Medium; rush and critical read as Urgent; unknown falls back to Medium", () => {
  for (const v of ["normal", "Normal", "", null, undefined, "weird"]) assert.equal(normalizePriority(v), "medium");
  for (const v of ["rush", "critical", "URGENT"]) assert.equal(normalizePriority(v), "urgent");
  assert.equal(priorityLabel("normal"), "Medium");
});

test("every picker offers the same four values", () => {
  assert.deepEqual(PRIORITIES.map((p) => p.value), ["low", "medium", "high", "urgent"]);
  assert.deepEqual(PRIORITIES.map((p) => p.label), ["Low", "Medium", "High", "Urgent"]);
});
