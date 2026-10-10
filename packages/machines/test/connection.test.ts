import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificateFingerprint, createLxdClientCredentials } from "../src/lxd/index.ts";
import { disconnectLxd, readLxdConnection, saveLxdConnection } from "../src/server/connection.ts";

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

test("disconnecting forgets a server it can't reach, and says how to remove its certificate there", async () => {
  expect(await disconnectLxd()).toBeUndefined();
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const address = `127.0.0.1:${listener.port}`;
  listener.stop(true);
  const credentials = await createLxdClientCredentials("aitc-test");
  await saveLxdConnection({ server: { address, certificate: credentials.certificate }, project: "aitc", credentials });
  const leftover = await disconnectLxd();
  expect(leftover).toStartWith(`AgentsInTheCloud forgot the LXD server at ${address} but couldn't remove its certificate there`);
  expect(leftover).toEndWith(`run lxc config trust remove ${certificateFingerprint(credentials.certificate)} on the server.`);
  expect(await readLxdConnection()).toBeUndefined();
});
