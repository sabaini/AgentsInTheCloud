/** Exercise machines end to end through a running AgentsInTheCloud, the way a user and an Agent use them:
 * connect it to an LXD server with a restricted token, give a template a container profile, and have a
 * workspace's Agent create a machine, write to it with plain ssh, and snapshot it. Parking stops the machine;
 * after unparking, the Agent wakes it with ssh and restores the snapshot. The HTTP API creates a second machine,
 * which the first reaches at the address the API reports, refuses a third and releases it, and deleting the
 * workspace asks before deleting the first. Every check looks at LXD or the API, not at what the Agent says.
 * Images the machines needed are deleted again afterwards.
 *
 * Needs `lxc` with admin access to the server, and an AgentsInTheCloud that isn't connected to LXD yet, with a
 * model provider. The Agent makes fewer than ten small model requests; pick a cheap model with --model.
 * Cleans up on success and keeps everything on failure for diagnosis.
 *
 *   bun run test:machines:functional [--atelier <url>] [--remote <lxc-remote>] [--model <provider::model>] [--image <ubuntu-release>]
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, parseArgs } from "node:util";
import type { JsonObject } from "@agents-in-the-cloud/core";
import { machineInstanceName } from "../src/server/leases.ts";

const { values: options } = parseArgs({ options: { atelier: { type: "string", default: "http://localhost:3000" }, remote: { type: "string" }, model: { type: "string" }, image: { type: "string", default: "24.04" } } });
const project = `aitc-ft-${randomUUID().slice(0, 8)}`;
const on = (name: string) => options.remote ? `${options.remote}:${name}` : name;
const server = options.remote ? [`${options.remote}:`] : [];
// A template is identified by its repository, so this one must not be in use already.
const repository = "https://github.com/octocat/Hello-World";
const nonce = randomUUID();
const kept: string[] = [];

interface Workspace {
  id: string;
  parked?: boolean;
  phase: { kind: string; status?: string; deletion?: { status: string; fingerprint?: string } };
  agents?: { id: string; agentTypeId: string; busy: boolean }[];
}
interface Machine { name: string; state: string; addresses: string[]; snapshots: string[] }

async function command(program: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn([program, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${program} ${args.join(" ")}: ${stderr || stdout}`);
  return stdout.trim();
}
const lxc = (...args: string[]) => command("lxc", ...args);

async function step<T>(description: string, action: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await action();
  console.log(`ok  ${description} (${Math.round((Date.now() - started) / 1000)} s)`);
  return result;
}

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(2000);
  }
}

/** One request to AgentsInTheCloud, as JSON or as the form fields a page posts. */
async function send(method: "GET" | "POST", path: string, body?: JsonObject | URLSearchParams): Promise<{ status: number; text: string }> {
  const headers = new Headers({ Accept: "application/json", Origin: new URL(options.atelier).origin });
  if (body && !(body instanceof URLSearchParams)) headers.set("Content-Type", "application/json");
  const response = await fetch(new URL(path, options.atelier), { method, headers, body: body instanceof URLSearchParams ? body : body && JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}

async function api<T>(method: "GET" | "POST", path: string, body?: JsonObject): Promise<T> {
  const { status, text } = await send(method, path, body);
  assert(status < 300, `${method} ${path}: HTTP ${status} ${text.slice(0, 400)}`);
  // SAFETY: AgentsInTheCloud's documented JSON contract for these operations (GET /openapi.json).
  return JSON.parse(text) as T;
}

/** Posts a form the way its page does. Settings answers with HTML for the page, which isn't checked. */
async function submit(path: string, fields: Record<string, string>): Promise<void> {
  const { status, text } = await send("POST", path, new URLSearchParams(fields));
  assert(status < 300, `POST ${path}: HTTP ${status} ${text.slice(0, 400)}`);
}

/** The fingerprint of the certificate the server trusts for just this project, once AgentsInTheCloud has joined. */
async function trustedFor(name: string): Promise<string | undefined> {
  // SAFETY: the entries `lxc config trust list -f json` prints.
  const entries = JSON.parse(await lxc("config", "trust", "list", ...server, "-f", "json")) as { fingerprint: string; restricted: boolean; projects: string[] | null }[];
  return entries.find((entry) => entry.restricted && isDeepStrictEqual(entry.projects, [name]))?.fingerprint;
}

// Machines' images land in the server's default project, so they outlive the test's project.
const images = async () => (await lxc("image", "list", ...server, "-c", "f", "-f", "csv")).split("\n").filter(Boolean);
const imagesBefore = await images();
const pulledImages = async () => (await images()).filter((image) => !imagesBefore.includes(image));

try {
  const { workspaceTemplates } = await api<{ workspaceTemplates: { gitUrl: string; branch: string | null }[] }>("GET", "/workspace-templates");
  assert(!workspaceTemplates.some((template) => template.gitUrl === repository && template.branch === null), `AgentsInTheCloud already has a template for ${repository}, which this test would change and delete`);

  await step(`connect AgentsInTheCloud to the ${project} project with a restricted token, as Settings asks`, async () => {
    await lxc("project", "create", on(project), "-c", "features.images=false", "-c", "features.profiles=false");
    kept.unshift(`lxc project delete ${on(project)}`);
    const token = (await lxc("config", "trust", "add", ...server, "--name", project, "--restricted", "--projects", project)).split("\n").at(-1)!;
    kept.unshift(`lxc config trust revoke-token ${on(project)}`);
    await submit("/settings/machines/connect", { token });
    // AgentsInTheCloud keeps an existing connection and ignores the token, which then trusts nothing here.
    const fingerprint = await trustedFor(project);
    assert(fingerprint, "AgentsInTheCloud didn't join with the token. If it's connected to an LXD server already, disconnect it in Settings first.");
    kept[0] = `lxc config trust remove ${on(fingerprint)}`;
  });

  const templateId = await step("give a template a container profile and at most 2 machines per workspace", async () => {
    const { workspaceTemplate } = await api<{ workspaceTemplate: { id: string } }>("POST", "/workspace-templates", { gitUrl: repository });
    kept.unshift(`delete the template ${workspaceTemplate.id} in AgentsInTheCloud`);
    await api("POST", `/workspace-templates/${workspaceTemplate.id}/machine-profiles`, { name: "box", image: `ubuntu:${options.image}`, type: "container", lxdProfiles: ["default"], diskSizesGiB: [], lifetimeHours: 1 });
    await api("POST", `/workspace-templates/${workspaceTemplate.id}/max-machines`, { maxMachines: 2 });
    return workspaceTemplate.id;
  });

  const workspaceId = (await api<{ workspace: { id: string } }>("POST", "/workspaces", { source: { type: "workspace-template", workspaceTemplate: templateId }, title: "Machines functional test", agent: { agentTypeId: "builtin" } })).workspace.id;
  kept.unshift(`delete the workspace ${workspaceId} in AgentsInTheCloud, which deletes its machines`);
  const workspace = async () => (await api<{ workspace: Workspace }>("GET", `/workspaces/${workspaceId}`)).workspace;
  const running = () => until("the workspace to run", 15 * 60_000, async () => {
    const current = await workspace();
    assert.notEqual(current.phase.status, "failed", JSON.stringify(current.phase));
    return current.phase.kind === "runningPhase" && !current.parked ? current : undefined;
  });
  const agentId = await step("start a workspace from it", async () => (await running()).agents!.find((agent) => agent.agentTypeId === "builtin")!.id);
  if (options.model) await api("POST", `/workspaces/${workspaceId}/agents/${agentId}/model`, { model: options.model });

  const ask = async (text: string) => {
    await api("POST", `/workspaces/${workspaceId}/agents/${agentId}/messages`, { text, mode: "send" });
    const busy = async () => (await workspace()).agents!.find((agent) => agent.id === agentId)!.busy;
    await until("the Agent to start", 60_000, async () => await busy() ? true : undefined);
    await until("the Agent to finish", 15 * 60_000, async () => await busy() ? undefined : true);
  };
  const machines = async () => (await api<{ machines: Machine[] }>("GET", `/workspaces/${workspaceId}/machines`)).machines;
  const box = machineInstanceName(workspaceId, "box-1");
  const inBox = (shell: string) => lxc("exec", on(box), "--project", project, "--", "sh", "-c", shell);
  const instances = (columns: string) => lxc("list", ...server, "--project", project, "-c", columns, "-f", "csv");

  await step("the Agent creates box-1, writes to it with ssh, and snapshots it", async () => {
    await ask(`Create a test machine from the box profile. Then run \`ssh box-1 'echo ${nonce} | sudo tee /root/functional'\` and take a snapshot of box-1 called marked. Answer in one short line.`);
    assert.deepEqual((await machines()).map(({ name, state, snapshots }) => ({ name, state, snapshots })), [{ name: "box-1", state: "ready", snapshots: ["marked"] }]);
    assert.equal(await inBox("cat /root/functional"), nonce);
  });

  await step("parking the workspace stops box-1, and it stays stopped after unparking", async () => {
    await inBox("rm /root/functional");
    await api("POST", `/workspaces/${workspaceId}/park?force=1`, {});
    await until("box-1 to stop", 5 * 60_000, async () => await instances("s") === "STOPPED" ? true : undefined);
    assert.equal((await machines())[0]!.state, "stopped");
    await api("POST", `/workspaces/${workspaceId}/unpark`, {});
    await running();
    assert.equal(await instances("s"), "STOPPED");
  });

  await step("the Agent wakes box-1 with ssh and restores its snapshot", async () => {
    await ask("Run `ssh box-1 hostname`, then restore box-1 to its snapshot called marked. Answer in one short line.");
    assert.equal(await instances("s"), "RUNNING");
    assert.equal((await machines())[0]!.state, "ready");
    assert.equal(await inBox("cat /root/functional"), nonce);
  });

  await step("the HTTP API creates box-2, which box-1 reaches at its address, refuses a third machine, and releases box-2", async () => {
    const { machine } = await api<{ machine: Machine }>("POST", `/workspaces/${workspaceId}/machines`, { profile: "box" });
    assert.deepEqual([machine.name, machine.state], ["box-2", "ready"]);
    const [address] = machine.addresses;
    const listed = (await instances("n4")).split("\n").find((line) => line.startsWith(`${machineInstanceName(workspaceId, "box-2")},`));
    assert.ok(address && listed?.includes(address), `box-2's address ${address} isn't one LXD lists: ${listed}`);
    await inBox(`nc -z -w 5 ${address} 22`);
    const third = await send("POST", `/workspaces/${workspaceId}/machines`, { profile: "box" });
    assert.equal(third.status, 409, third.text);
    assert.match(third.text, /already has 2 of its 2 machines/);
    assert.deepEqual(await api("POST", `/workspaces/${workspaceId}/machines/box-2/release`), { released: "box-2" });
    assert.deepEqual((await machines()).map(({ name }) => name), ["box-1"]);
    assert.equal(await instances("n"), box);
  });

  await step("deleting the workspace asks first, then deletes box-1 with it", async () => {
    const review = await api<{ blocked: boolean; details: { details: JsonObject }[] }>("POST", `/workspaces/${workspaceId}/delete`, {});
    assert(review.blocked && review.details.some(({ details }) => isDeepStrictEqual(details, { deleted: ["box-1"], kept: [] })), JSON.stringify(review));
    await submit(`/workspaces/${workspaceId}/delete/confirm`, { fingerprint: (await workspace()).phase.deletion!.fingerprint! });
    await until("the workspace to be deleted", 5 * 60_000, async () => {
      const { workspaces } = await api<{ workspaces: { id: string }[] }>("GET", "/workspaces");
      return workspaces.some(({ id }) => id === workspaceId) ? undefined : true;
    });
    kept.shift();
    assert.equal(await instances("n"), "");
  });

  await step("delete the template, and disconnect, which removes AgentsInTheCloud's certificate", async () => {
    await api("POST", `/workspace-templates/${templateId}/delete`, {});
    kept.shift();
    await submit("/settings/machines/disconnect", {});
    assert.equal(await trustedFor(project), undefined);
    kept.shift();
  });

  await lxc("project", "delete", on(project));
  for (const image of await pulledImages()) await lxc("image", "delete", on(image));
  console.log("passed");
} catch (error) {
  console.error(error);
  kept.push(...(await pulledImages()).map((image) => `lxc image delete ${on(image)}`));
  console.error(`\nFAILED. Kept for diagnosis; to clean up:\n${kept.map((what) => `  ${what}`).join("\n")}`);
  process.exit(1);
}
