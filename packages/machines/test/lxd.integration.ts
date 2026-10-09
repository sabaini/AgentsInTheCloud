/** Exercise the LXD client against a real LXD server: a fresh project, a restricted
 * trust token redeemed by a new AITC client certificate, and one container driven only
 * through the API. Needs `lxc` with admin access to the server (the local one, or the
 * `--remote` it names) and that server listening on HTTPS.
 * Cleans up on success and keeps everything on failure for diagnosis.
 *
 *   bun run test:lxd [--remote <lxc-remote>] [--image <ubuntu-release>]
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { certificateFingerprint, createLxdClientCredentials, joinLxdServer, LxdClient, LxdRequestError } from "../src/lxd/index.ts";

const project = `aitc-it-${randomUUID().slice(0, 8)}`;
const instance = "machine-1";
const pool = "default";
const volume = `${instance}-disk-1`;
const { values: options } = parseArgs({ options: { remote: { type: "string" }, image: { type: "string", default: "24.04" } } });
const alias = options.image;
/** A name on the server under test, as `lxc` addresses it. */
const on = (name = "") => options.remote ? `${options.remote}:${name}` : name;
const cleanup: string[][] = [];

async function lxc(...args: string[]): Promise<string> {
  const child = Bun.spawn(["lxc", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`lxc ${args.join(" ")}: ${stderr || stdout}`);
  return stdout.trim();
}

async function step<T>(description: string, action: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await action();
  console.log(`ok  ${description} (${Date.now() - started} ms)`);
  return result;
}

try {
  console.log(`LXD ${(await lxc("query", `${on()}/1.0`)).match(/"server_version": "([^"]+)"/)?.[1]}`);
  await lxc("project", "create", on(project), "-c", "features.images=false", "-c", "features.profiles=false");
  cleanup.unshift(["project", "delete", on(project)]);
  const token = (await lxc("config", "trust", "add", ...(options.remote ? [on()] : []), "--name", project, "--restricted", "--projects", project)).split("\n").at(-1)!;
  const credentials = await step("create AITC client certificate", () => createLxdClientCredentials(project));
  const joined = await step("join with a restricted trust token", () => joinLxdServer(token, credentials));
  const { server } = joined;
  cleanup.unshift(["config", "trust", "remove", on(certificateFingerprint(credentials.certificate))]);
  console.log(`    pinned ${server.address}`);
  assert.equal(joined.project, project);
  const lxd = new LxdClient({ server, credentials, project });

  await step("restricted to its own project", async () => {
    const outside = new LxdClient({ server, credentials, project: "default" });
    const error = await outside.instances().then(() => undefined, (caught: Error) => caught);
    assert(error instanceof LxdRequestError && error.status === 403, `expected 403 outside the project, got ${error}`);
  });

  await step(`create and start a container from ubuntu:${alias}`, () => lxd.createInstance({
    name: instance,
    type: "container",
    source: { type: "image", alias, server: "https://cloud-images.ubuntu.com/releases", protocol: "simplestreams" },
    config: { "user.aitc.workspace": "integration" },
    start: true,
  }));
  cleanup.unshift(["delete", "--force", "--project", project, on(instance)]);
  assert.equal((await lxd.instance(instance)).status, "Running");
  assert.equal((await lxd.instances()).find(candidate => candidate.name === instance)?.config["user.aitc.workspace"], "integration");

  await step("collect stdout, stderr and the exit status", async () => {
    const result = await lxd.run(instance, ["sh", "-c", "echo out; echo err >&2; exit 3"]);
    assert.deepEqual({ exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr }, { exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  const payload = Buffer.alloc(16 * 1024 * 1024, "lxd exec stream\n");
  await step(`stream ${payload.length / 1024 / 1024} MiB through cat and back`, async () => {
    const result = await lxd.run(instance, ["cat"], payload);
    assert.equal(result.exitCode, 0);
    assert(result.stdout.equals(payload), `got ${result.stdout.length} bytes back`);
  });

  await step("read files and report missing ones", async () => {
    assert.equal((await lxd.readInstanceFile(instance, "/etc/hostname"))?.toString().trim(), instance);
    assert.equal(await lxd.readInstanceFile(instance, "/nonexistent"), undefined);
  });

  await step("snapshot, change, restore", async () => {
    await lxd.createSnapshot(instance, "clean");
    assert.deepEqual(await lxd.snapshots(instance), ["clean"]);
    assert.equal((await lxd.run(instance, ["touch", "/root/experiment"])).exitCode, 0);
    await lxd.restoreSnapshot(instance, "clean");
    assert.equal((await lxd.instance(instance)).status, "Running");
    assert.equal((await lxd.run(instance, ["test", "-e", "/root/experiment"])).exitCode, 1);
  });

  await step("create and delete a block volume", async () => {
    await lxd.createBlockVolume(pool, volume, "1GiB");
    cleanup.unshift(["storage", "volume", "delete", on(pool), volume, "--project", project]);
    await lxd.deleteVolume(pool, volume);
    cleanup.shift();
  });

  await step("stop and delete the container", async () => {
    await lxd.setInstanceState(instance, "stop", true);
    await lxd.deleteInstance(instance);
    cleanup.shift();
  });

  await step("untrust AITC's own certificate", async () => {
    await lxd.removeOwnCertificate();
    cleanup.shift();
    assert(!(await lxc("config", "trust", "list", ...(options.remote ? [on()] : []), "--format", "csv")).includes(`,${project},`));
  });

  for (const args of cleanup) await lxc(...args);
  console.log("passed");
} catch (error) {
  console.error(error);
  console.error(`\nFAILED. Kept for diagnosis; clean up with:\n${cleanup.map(args => `  lxc ${args.join(" ")}`).join("\n")}`);
  process.exit(1);
}
