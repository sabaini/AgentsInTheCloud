import { expect, test } from "bun:test";
import type { WorkspaceDeletionAssessment, WorkspaceDeletionReview } from "@agents-in-the-cloud/shared";
import { combineDeletionReviews } from "../src/server/deletion-reviews.ts";

function review(name: string, assessment: () => WorkspaceDeletionAssessment): WorkspaceDeletionReview {
  return { inspect: async () => assessment(), renderEvidence: (workspaceId, details) => `[${name} ${workspaceId} ${JSON.stringify(details)}]` };
}

test("deletion asks first when any module would lose something, and shows each module its own evidence", async () => {
  let changes: WorkspaceDeletionAssessment = { status: "clear" };
  let machines: WorkspaceDeletionAssessment = { status: "clear" };
  const combined = combineDeletionReviews([review("changes", () => changes), review("machines", () => machines)]);
  expect(await combined.inspect("w1")).toEqual({ status: "clear" });

  machines = { status: "blocked", fingerprint: "m1", details: { machines: ["node-1"] } };
  const onlyMachines = await combined.inspect("w1");
  if (onlyMachines.status !== "blocked") throw new Error("expected a blocked review");
  expect(combined.renderEvidence("w1", onlyMachines.details)).toBe('[machines w1 {"machines":["node-1"]}]');

  changes = { status: "blocked", fingerprint: "c1", details: { files: 2 } };
  const both = await combined.inspect("w1");
  if (both.status !== "blocked") throw new Error("expected a blocked review");
  expect(both.fingerprint).not.toBe(onlyMachines.fingerprint);
  expect(combined.renderEvidence("w1", both.details)).toBe('[changes w1 {"files":2}][machines w1 {"machines":["node-1"]}]');

  machines = { status: "blocked", fingerprint: "m2", details: { machines: ["node-1", "node-2"] } };
  const changed = await combined.inspect("w1");
  if (changed.status !== "blocked") throw new Error("expected a blocked review");
  expect(changed.fingerprint).not.toBe(both.fingerprint);
  expect(() => combined.renderEvidence("w1", { anything: true })).toThrow("evidence is invalid");
});
