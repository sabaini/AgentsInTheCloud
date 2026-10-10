import { expect, test } from "bun:test";
import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { problemJsonResponse } from "../src/server/http-responses.ts";

test("invalid terminal cwd returns a client validation response", async () => {
  const message = "terminal cwd must be under /work: /tmp/qa-run";
  const response = problemJsonResponse(new AgentsInTheCloudCoreError("terminal_invalid_cwd", message));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "terminal_invalid_cwd", message } });
});

test("terminal creation failures remain server errors", () => {
  expect(problemJsonResponse(new AgentsInTheCloudCoreError("terminal_create_failed", "creation failed")).status).toBe(500);
});

test("a machine the workspace can't have right now is a conflict, not a server error", async () => {
  const message = "This workspace already has 2 of its 2 machines. Release one first.";
  const response = problemJsonResponse(new AgentsInTheCloudCoreError("machine_unavailable", message));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { code: "machine_unavailable", message } });
});
