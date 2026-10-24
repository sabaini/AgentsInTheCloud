import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificateFingerprint, createLxdClientCredentials, lxdLocation, type LxdConnection } from "../src/lxd/index.ts";
import { addLxdConnection, disconnectAllLxd, disconnectLxd, readLxdConnections } from "../src/server/connection.ts";

let previousDataDir: string | undefined;
let dataDir: string;

beforeEach(async () => {
  previousDataDir = process.env.ATELIER_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "machines-connection-"));
  process.env.ATELIER_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

/** A server nothing listens at anymore, as when it's switched off. */
async function unreachable(project = "aitc"): Promise<LxdConnection> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const address = `127.0.0.1:${listener.port}`;
  listener.stop(true);
  const server = await createLxdClientCredentials(address);
  return { server: { address, certificate: server.certificate }, project, credentials: await createLxdClientCredentials("aitc-test") };
}

test("disconnecting forgets a server it can't reach, and says how to remove its certificate there, leaving the others", async () => {
  const [first, second] = [await unreachable(), await unreachable()];
  expect(await disconnectLxd(lxdLocation(first))).toBeUndefined();
  await addLxdConnection(first);
  await addLxdConnection(second);
  const leftover = await disconnectLxd(lxdLocation(first));
  expect(leftover).toStartWith(`AgentsInTheCloud forgot the LXD server at ${first.server.address} but couldn't remove its certificate there`);
  expect(leftover).toEndWith(`run lxc config trust remove ${certificateFingerprint(first.credentials.certificate)} on the server.`);
  expect(await readLxdConnections()).toEqual([second]);
});

test("each project on a server is connected once, and another project on it counts as another server", async () => {
  const connection = await unreachable();
  await addLxdConnection(connection);
  await expect(addLxdConnection({ ...connection, server: { ...connection.server, address: "10.0.0.9:8443" } })).rejects.toThrow("The aitc project on that LXD server is connected already.");
  const otherProject = { ...connection, project: "elsewhere" };
  await addLxdConnection(otherProject);
  expect(await readLxdConnections()).toEqual([connection, otherProject]);
});

test("the one server connected before there could be more still loads, and the next is added to it", async () => {
  const [old, next] = [await unreachable(), await unreachable()];
  await mkdir(join(dataDir, "machines"), { recursive: true });
  await writeFile(join(dataDir, "machines", "lxd.json"), JSON.stringify(old));
  expect(await readLxdConnections()).toEqual([old]);
  await addLxdConnection(next);
  expect(JSON.parse(await readFile(join(dataDir, "machines", "lxd.json"), "utf8"))).toEqual({ servers: [old, next] });
});

test("deleting all settings forgets every server, and says how to remove each certificate it couldn't", async () => {
  const [first, second] = [await unreachable(), await unreachable()];
  expect(await disconnectAllLxd()).toBeUndefined();
  await addLxdConnection(first);
  await addLxdConnection(second);
  const leftover = await disconnectAllLxd();
  for (const { server } of [first, second]) expect(leftover).toContain(`at ${server.address} but couldn't remove its certificate there (`);
  for (const { credentials } of [first, second]) expect(leftover).toContain(`run lxc config trust remove ${certificateFingerprint(credentials.certificate)} on the server.`);
  expect(await readLxdConnections()).toEqual([]);
});
