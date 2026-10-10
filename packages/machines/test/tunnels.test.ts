import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LxdExecProcess } from "../src/lxd/index.ts";
import type { MachineLease } from "../src/server/leases.ts";
import { createMachineTunnels, type MachineTunnelLxd } from "../src/server/tunnels.ts";

let sshd: Server;
let port: number;
let directory: string;
const execs: string[][] = [];

/** Stands in for LXD exec of nc inside the machine: a TCP connection to a local echo server playing sshd. */
const lxd: MachineTunnelLxd = {
  async exec(instance: string, command: string[]): Promise<LxdExecProcess> {
    execs.push([instance, ...command]);
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    return {
      stdout: socket,
      stderr: (async function* () {})(),
      write: (data) => new Promise((resolve, reject) => socket.write(data, (error) => error ? reject(error) : resolve())),
      closeStdin: () => { socket.end(); },
      exited: once(socket, "close").then(() => 0),
    };
  },
};

const lease = (name: string, status: MachineLease["status"]): MachineLease => ({ name, location: { address: "lxd.test:8443", fingerprint: "a1", project: "agents-in-the-cloud" }, instance: `${name}-abcd1234`, profile: { name: "node", image: "ubuntu:24.04", type: "virtual-machine", lxdProfiles: ["default"], diskSizesGiB: [] }, volumes: [], createdAt: 0, expiresAt: 0, status, hostKeys: [`ssh-ed25519 AAAA${name}`] });

beforeAll(async () => {
  sshd = createServer((socket: Socket) => socket.pipe(socket)).listen(0, "127.0.0.1");
  await once(sshd, "listening");
  // SAFETY: listen completed on an explicit TCP address, so address() is an AddressInfo.
  port = (sshd.address() as AddressInfo).port;
});
afterAll(() => { sshd.close(); });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "machines-tunnels-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test("ready machines get a socket relayed into the machine, an SSH host entry and their host keys", async () => {
  const tunnels = createMachineTunnels({ usable: async () => lxd, hostDirectory: () => directory, containerDirectory: "/run/ssh" });
  await tunnels.sync("w1", [lease("node-1", "ready"), { ...lease("node-2", "starting"), hostKeys: [] }]);

  const config = await readFile(join(directory, "ssh_config.d", "machines.conf"), "utf8");
  const socket = /UNIX-CONNECT:\/run\/ssh\/machines\/([0-9a-f]{12}\.sock)/.exec(config)![1]!;
  expect(config).toContain("Host node-1\n    User ubuntu\n");
  expect(config).toContain("UserKnownHostsFile /run/ssh/machines/known_hosts\n    KnownHostsCommand none\n    StrictHostKeyChecking yes\n");
  expect(config).not.toContain("node-2");
  expect(await readFile(join(directory, "machines", "known_hosts"), "utf8")).toBe("node-1 ssh-ed25519 AAAAnode-1\n");
  expect(await readdir(join(directory, "machines"))).toContain(socket);

  const client = connect(join(directory, "machines", socket));
  await once(client, "connect");
  const payload = Buffer.alloc(1024 * 1024 + 3, "ssh bytes ");
  const received = (async () => Buffer.concat(await Array.fromAsync(client)))();
  client.end(payload);
  expect((await received).equals(payload)).toBe(true);
  expect(execs.at(-1)).toEqual(["node-1-abcd1234", "nc", "-N", "127.0.0.1", "22"]);

  await tunnels.sync("w1", [lease("node-2", "ready")]);
  expect(await readFile(join(directory, "ssh_config.d", "machines.conf"), "utf8")).not.toContain("node-1");
  expect((await readdir(join(directory, "machines"))).filter((file) => file.endsWith(".sock"))).toHaveLength(1);
  await tunnels.close("w1");
  expect(await readdir(directory)).toEqual(["ssh_config.d"]);
  expect(await readdir(join(directory, "ssh_config.d"))).toEqual([]);
});

test("a connection waiting for its machine to restart doesn't hold up the lease change that restart makes", async () => {
  let tunnels!: ReturnType<typeof createMachineTunnels>;
  // Waking a stopped machine marks it starting, which resyncs the tunnels while this connection waits.
  const usable = async (workspaceId: string, name: string) => {
    await tunnels.sync(workspaceId, [lease(name, "starting")]);
    return lxd;
  };
  tunnels = createMachineTunnels({ usable, hostDirectory: () => directory, containerDirectory: "/run/ssh" });
  await tunnels.sync("w1", [lease("node-1", "ready")]);
  const socket = /UNIX-CONNECT:\/run\/ssh\/machines\/([0-9a-f]{12}\.sock)/.exec(await readFile(join(directory, "ssh_config.d", "machines.conf"), "utf8"))![1]!;
  const client = connect(join(directory, "machines", socket));
  await once(client, "connect");
  const received = (async () => Buffer.concat(await Array.fromAsync(client)))();
  client.end(Buffer.from("SSH-2.0-test\r\n"));
  expect((await received).toString()).toBe("SSH-2.0-test\r\n");

  // Releasing cuts connections instead of waiting for them.
  const lingering = connect(join(directory, "machines", socket));
  await once(lingering, "connect");
  lingering.write("still here");
  await once(lingering, "data");
  const closed = once(lingering, "close");
  await tunnels.sync("w1", []);
  await closed;
  await tunnels.close("w1");
});

test("losing the machine's side mid-connection ends it, so ssh doesn't wait for the rest of a reply", async () => {
  const sent = Promise.withResolvers<void>();
  const failing: MachineTunnelLxd = {
    async exec() {
      return {
        stdout: (async function* () {
          yield Buffer.from("SSH-2.0-machine\r\n");
          await sent.promise;
          throw new Error("LXD connection reset");
        })(),
        stderr: (async function* () {})(),
        write: async () => sent.resolve(),
        closeStdin: () => undefined,
        exited: Promise.resolve(1),
      };
    },
  };
  const logged = spyOn(console, "error").mockImplementation(() => undefined);
  const tunnels = createMachineTunnels({ usable: async () => failing, hostDirectory: () => directory, containerDirectory: "/run/ssh" });
  await tunnels.sync("w1", [lease("node-1", "ready")]);
  const socket = /UNIX-CONNECT:\/run\/ssh\/machines\/([0-9a-f]{12}\.sock)/.exec(await readFile(join(directory, "ssh_config.d", "machines.conf"), "utf8"))![1]!;
  const client = connect(join(directory, "machines", socket));
  await once(client, "connect");
  client.write("SSH-2.0-test\r\n");
  expect((await Array.fromAsync(client)).join("")).toBe("SSH-2.0-machine\r\n");
  expect(logged).toHaveBeenCalledWith("[machines] SSH relay to node-1-abcd1234 failed:", expect.objectContaining({ message: "LXD connection reset" }));
  logged.mockRestore();
  await tunnels.close("w1");
});
