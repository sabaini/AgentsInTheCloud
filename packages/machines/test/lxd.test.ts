import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import type { Server, ServerWebSocket } from "bun";
import type { JsonValue } from "@agents-in-the-cloud/core";
import { certificateFingerprint, createLxdClientCredentials, joinLxdServer, LxdClient, LxdRequestError, parseLxdTrustToken, type LxdClientCredentials, type LxdServer } from "../src/lxd/index.ts";
import { LxdWebSocket } from "../src/lxd/websocket.ts";

type Fd = "0" | "1" | "2" | "control";
interface ExecSession { running: boolean; sockets: Map<Fd, ServerWebSocket<Upgrade>>; closed: Set<Fd>; opened: ReturnType<typeof Promise.withResolvers<void>>; finished: ReturnType<typeof Promise.withResolvers<void>> }
type OperationResult = { status_code: number; err: string; metadata: { return: number } | null };
interface Upgrade { session: ExecSession; fd: Fd }

const trustSecret = "fake-secret";
let issuedToken = "";
let restriction = { restricted: true, projects: ["aitc"] };
let directory: string;
let serverCertificate: string;
let credentials: LxdClientCredentials;
let fake: Server<Upgrade>;
let trusted = false;
const operations = new Map<string, Promise<OperationResult | { error: string }>>();
const execSessions = new Map<string, { session: ExecSession; fd: Fd }>();
let halfSession: ExecSession | undefined;

const sync = (metadata: JsonValue) => Response.json({ type: "sync", status: "Success", status_code: 200, operation: "", error_code: 0, error: "", metadata });
const failure = (code: number, error: string) => Response.json({ type: "error", status: "", status_code: 0, operation: "", error_code: code, error, metadata: null }, { status: code });
function operation(result: Promise<OperationResult | { error: string }>, metadata: JsonValue = null): Response {
  const id = crypto.randomUUID();
  operations.set(id, result);
  return Response.json({ type: "async", status: "Operation created", status_code: 100, operation: `/1.0/operations/${id}`, error_code: 0, error: "", metadata: { id, metadata } }, { status: 202 });
}

function token(fingerprint: string, addresses: string[], expiresAt = new Date(Date.now() + 60_000)): string {
  return Buffer.from(JSON.stringify({ client_name: "aitc", fingerprint, addresses, secret: trustSecret, expires_at: expiresAt.toISOString(), type: "" })).toString("base64");
}

async function selfSignedServerCertificate(name: string): Promise<{ certificate: string; key: string }> {
  const keyPath = join(directory, `${name}.key`);
  const certificatePath = join(directory, `${name}.crt`);
  const child = Bun.spawn(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", `/CN=${name}`, "-addext", "basicConstraints=critical,CA:FALSE", "-addext", `subjectAltName=DNS:${name}`, "-keyout", keyPath, "-out", certificatePath], { stderr: "pipe" });
  expect(await child.exited).toBe(0);
  return { certificate: await readFile(certificatePath, "utf8"), key: await readFile(keyPath, "utf8") };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "machines-lxd-test-"));
  const tls = await selfSignedServerCertificate("fake-lxd");
  serverCertificate = tls.certificate;
  credentials = await createLxdClientCredentials("aitc-test");
  fake = Bun.serve<Upgrade>({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: tls.certificate, key: tls.key },
    async fetch(request, server) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/1.0" && request.method === "GET") return sync({ auth: trusted ? "trusted" : "untrusted" });
      if (path === "/1.0/certificates" && request.method === "POST") {
        const body = await request.json();
        if (body.type !== "client" || body.trust_token !== issuedToken) return failure(403, "Forbidden");
        trusted = true;
        return sync(null);
      }
      if (path === `/1.0/certificates/${certificateFingerprint(credentials.certificate)}`) {
        if (!trusted) return failure(403, "Forbidden");
        if (request.method === "GET") return sync(restriction);
        trusted = false;
        return sync({});
      }
      if (path === "/1.0/instances" && request.method === "POST") {
        const body = await request.json();
        return operation(Promise.resolve(body.name === "broken" ? { status_code: 400, err: "Failed creating instance record: broken image", metadata: null } : { status_code: 200, err: "", metadata: null }));
      }
      if (path === "/1.0/instances/box" && request.method === "GET" && url.searchParams.get("recursion") === "1") {
        const address = (family: string, address: string, scope: string) => ({ family, address, netmask: "64", scope });
        return sync({ name: "box", snapshots: [{ name: "clean" }], state: { status: "Running", network: {
          lo: { host_name: "", addresses: [address("inet", "127.0.0.1", "local")] },
          docker0: { host_name: "", addresses: [address("inet", "172.17.0.1", "global")] },
          enp5s0: { host_name: "tap6101283", addresses: [address("inet6", "fd42::5", "global"), address("inet6", "fe80::5", "link"), address("inet", "10.1.0.5", "global")] },
        } } });
      }
      if (path === "/1.0/instances/stopped" && request.method === "GET") return sync({ name: "stopped", snapshots: null, state: { status: "Stopped", network: null } });
      if (path === "/1.0/instances/box/files") return url.searchParams.get("path") === "/etc/hostname" ? new Response("box\n") : failure(404, "Not Found");
      const exec = path.match(/^\/1\.0\/instances\/(box|booting|half)\/exec$/);
      if (exec && request.method === "POST") {
        // A VM whose agent isn't up yet: once the streams connect, LXD closes them all and fails the operation.
        const running = exec[1] !== "booting";
        const session: ExecSession = { running, sockets: new Map(), closed: new Set(), opened: Promise.withResolvers(), finished: Promise.withResolvers() };
        if (exec[1] === "half") halfSession = session;
        const fds = Object.fromEntries((["0", "1", "2", "control"] as const).map(fd => {
          const secret = crypto.randomUUID();
          // On half, stderr's WebSocket is refused.
          if (exec[1] !== "half" || fd !== "2") execSessions.set(secret, { session, fd });
          return [fd, secret];
        }));
        return operation(running
          ? session.finished.promise.then(() => ({ status_code: 200, err: "", metadata: { return: 3 } }))
          : session.opened.promise.then(() => ({ error: "LXD VM agent is not currently running" })), { fds });
      }
      const wait = path.match(/^\/1\.0\/operations\/([^/]+)\/wait$/);
      if (wait) {
        const result = await operations.get(wait[1]!)!;
        return "error" in result ? failure(500, result.error) : sync(result);
      }
      if (/^\/1\.0\/operations\/[^/]+\/websocket$/.test(path)) {
        const target = execSessions.get(url.searchParams.get("secret")!);
        if (!target || !server.upgrade(request, { data: target })) return failure(403, "Forbidden");
        return undefined;
      }
      return failure(404, "Not Found");
    },
    websocket: {
      open(socket) {
        socket.data.session.sockets.set(socket.data.fd, socket);
        const { session } = socket.data;
        if (session.sockets.size < 4) return;
        session.opened.resolve();
        if (session.running) return;
        for (const stream of session.sockets.values()) {
          stream.close(1000);
          stream.terminate();
        }
      },
      // Behaves like `cat`: stdin is echoed to stdout until stdin closes.
      async message(socket, message) {
        await socket.data.session.opened.promise;
        if (socket.data.fd === "0") socket.data.session.sockets.get("1")!.send(message);
      },
      async close(socket) {
        socket.data.session.closed.add(socket.data.fd);
        if (socket.data.fd !== "0" || !socket.data.session.running) return;
        await socket.data.session.opened.promise;
        for (const fd of ["1", "2", "control"] as const) socket.data.session.sockets.get(fd)!.close(1000);
        socket.data.session.finished.resolve();
      },
    },
  });
});

afterAll(async () => {
  await fake.stop(true);
  await rm(directory, { recursive: true, force: true });
});

const fakeAddress = () => `127.0.0.1:${fake.port}`;
const fakeServer = (): LxdServer => ({ address: fakeAddress(), certificate: serverCertificate });
const client = () => new LxdClient({ server: fakeServer(), credentials, project: "aitc" });

test("trust tokens are decoded and checked before contacting LXD", () => {
  const fingerprint = "a".repeat(64);
  expect(parseLxdTrustToken(`  ${token(fingerprint, ["10.0.0.2:8443"])}\n`)).toMatchObject({ fingerprint, addresses: ["10.0.0.2:8443"], clientName: "aitc" });
  expect(() => parseLxdTrustToken("not a token")).toThrow("doesn't look like an LXD trust token");
  expect(() => parseLxdTrustToken(token(fingerprint, []))).toThrow("isn't listening on the network");
  expect(() => parseLxdTrustToken(token(fingerprint, ["10.0.0.2:8443"], new Date(Date.now() - 1000)))).toThrow("expired");
});

test("joining pins the first address that presents the token's certificate and learns its project", async () => {
  trusted = false;
  restriction = { restricted: true, projects: ["aitc"] };
  issuedToken = token(certificateFingerprint(serverCertificate), ["127.0.0.1:1", fakeAddress()]);
  expect(await joinLxdServer(issuedToken, credentials)).toEqual({ server: fakeServer(), project: "aitc" });
  expect(trusted).toBe(true);
});

test("joining refuses tokens that aren't restricted to one project and untrusts itself again", async () => {
  for (const unsafe of [{ restricted: false, projects: [] }, { restricted: true, projects: ["aitc", "default"] }]) {
    trusted = false;
    restriction = unsafe;
    issuedToken = token(certificateFingerprint(serverCertificate), [fakeAddress()]);
    await expect(joinLxdServer(issuedToken, credentials)).rejects.toThrow("--restricted --projects <project>");
    expect(trusted).toBe(false);
  }
});

test("joining explains rejected tokens", async () => {
  issuedToken = "";
  await expect(joinLxdServer(token(certificateFingerprint(serverCertificate), [fakeAddress()]), credentials)).rejects.toThrow("Each token works only once");
});

test("joining refuses a server whose certificate the token doesn't name", async () => {
  const other = await selfSignedServerCertificate("other-lxd");
  await expect(joinLxdServer(token(certificateFingerprint(other.certificate), [fakeAddress()]), credentials)).rejects.toThrow("different certificate");
});

test("failed operations surface LXD's own error", async () => {
  await client().createInstance({ name: "machine-1", type: "virtual-machine", source: { type: "image", alias: "24.04" } });
  const failed = client().createInstance({ name: "broken", type: "virtual-machine", source: { type: "image", alias: "24.04" } });
  await expect(failed).rejects.toThrow("Failed creating instance record: broken image");
  await expect(failed).rejects.toBeInstanceOf(LxdRequestError);
});

test("an instance's addresses are those of its LXD network devices, IPv4 first, and it has none while stopped", async () => {
  expect(await client().details("box")).toEqual({ snapshots: ["clean"], addresses: ["10.1.0.5", "fd42::5"] });
  expect(await client().details("stopped")).toEqual({ snapshots: [], addresses: [] });
});

test("missing files read as undefined", async () => {
  expect((await client().readInstanceFile("box", "/etc/hostname"))?.toString()).toBe("box\n");
  expect(await client().readInstanceFile("box", "/var/lib/cloud/instance/boot-finished")).toBeUndefined();
});

test("exec streams large stdin and stdout through pinned WebSockets", async () => {
  const input = Buffer.alloc(1024 * 1024 + 7, "x");
  input.write("first line\n");
  const result = await client().run("box", ["cat"], input, input.length);
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toBe("");
  expect(result.stdout.equals(input)).toBe(true);
});

test("exec keeps only as much output as asked for, and still runs the command to the end", async () => {
  const input = Buffer.alloc(256 * 1024, "x");
  const result = await client().run("box", ["cat"], input, 1000);
  expect(result.exitCode).toBe(3);
  expect(result.stdout.equals(input.subarray(0, 1000))).toBe(true);
});

test("exec fails with LXD's error when the command can't start", async () => {
  await expect(client().run("booting", ["true"])).rejects.toThrow("LXD VM agent is not currently running");
});

test("exec closes the streams it connected when another one is refused", async () => {
  await expect(client().run("half", ["true"])).rejects.toThrow("LXD refused the WebSocket (HTTP/1.1 403 Forbidden)");
  while (halfSession!.closed.size < 3) await Bun.sleep(10);
  expect([...halfSession!.closed].sort()).toEqual(["0", "1", "control"]);
});

/** Bun's WebSocket server waits for the client's close frame; LXD doesn't, so these speak raw TLS. */
async function rawLxdStream(name: string, upgraded: (socket: TLSSocket) => void | Promise<void>) {
  const tls = await selfSignedServerCertificate(name);
  const server = createServer({ cert: tls.certificate, key: tls.key }, (socket: TLSSocket) => {
    let request = "";
    socket.on("data", async (chunk: Buffer) => {
      request += chunk.toString("latin1");
      const key = /^sec-websocket-key: *(.+)$/im.exec(request)?.[1];
      if (!request.includes("\r\n\r\n") || !key) return;
      request = "";
      const accept = createHash("sha1").update(`${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      await upgraded(socket);
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: listen completed on an explicit TCP address, so address() is an AddressInfo.
  const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stream = await LxdWebSocket.connect({ server: { address, certificate: tls.certificate }, credentials }, new URL(`https://${address}/1.0/operations/x/websocket?secret=x`));
  return { stream, close: () => server.close() };
}

const ping = Buffer.from([0x89, 0x00]);
const closeFrame = Buffer.from([0x88, 0x02, 0x03, 0xe8]);

test("a stream LXD pings, closes and drops at once ends without waiting for answers", async () => {
  const { stream, close } = await rawLxdStream("dropping-lxd", async (socket) => {
    socket.write(Buffer.concat([ping, closeFrame]));
    await Bun.sleep(50);
    socket.resetAndDestroy();
  });
  // Read only once the connection is gone, as when LXD fails an exec before its streams are read.
  await Bun.sleep(200);
  expect(await Array.fromAsync(stream.messages())).toEqual([]);
  stream.close();
  close();
});

test("a stream LXD pings and drops ends there, even when the pong takes the connection down", async () => {
  const { stream, close } = await rawLxdStream("pinging-lxd", async (socket) => {
    socket.write(Buffer.concat([Buffer.from([0x82, 0x03]), Buffer.from("out"), ping]));
    await Bun.sleep(50);
    socket.resetAndDestroy();
  });
  expect((await Array.fromAsync(stream.messages())).map(String)).toEqual(["out"]);
  close();
});

test("a reader that stops early releases the stream", async () => {
  const released = Promise.withResolvers<void>();
  const { stream, close } = await rawLxdStream("talking-lxd", (socket) => {
    socket.once("close", () => released.resolve());
    socket.write(Buffer.concat([Buffer.from([0x82, 0x01]), Buffer.from("a"), Buffer.from([0x82, 0x01]), Buffer.from("b")]));
  });
  for await (const _ of stream.messages()) break;
  await released.promise;
  close();
});

test("exec WebSockets refuse a server other than the pinned one", async () => {
  const other = await selfSignedServerCertificate("impostor-lxd");
  const url = new URL(`https://${fakeAddress()}/1.0/operations/none/websocket?secret=none`);
  await expect(LxdWebSocket.connect({ server: { address: fakeAddress(), certificate: other.certificate }, credentials }, url)).rejects.toThrow("different certificate");
});
