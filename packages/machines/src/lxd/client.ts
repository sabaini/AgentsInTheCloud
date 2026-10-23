import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { certificateFingerprint, lxdFetchTls, type LxdTlsIdentity } from "./tls.ts";
import { LxdWebSocket } from "./websocket.ts";

export interface LxdConnection extends LxdTlsIdentity {
  project: string;
}

/** A project on a server. The server is known by its certificate, which it keeps when its address changes or AITC connects to it again. */
export interface LxdLocation {
  address: string;
  fingerprint: string;
  project: string;
}

export function lxdLocation(connection: LxdConnection): LxdLocation {
  return { address: connection.server.address, fingerprint: certificateFingerprint(connection.server.certificate), project: connection.project };
}

export function sameLxdLocation(a: LxdLocation, b: LxdLocation): boolean {
  return a.fingerprint === b.fingerprint && a.project === b.project;
}

export class LxdRequestError extends AgentsInTheCloudCoreError {
  constructor(readonly status: number, message: string) {
    super("lxd_request_failed", message, { status });
  }
}

/** The subset of LXD's InstancesPost that AITC sends. */
export interface LxdInstancesPost {
  name: string;
  description?: string;
  type: "container" | "virtual-machine";
  source: { type: "image"; alias: string; server?: string; protocol?: "simplestreams" | "lxd" };
  profiles?: string[];
  config?: Record<string, string>;
  devices?: Record<string, Record<string, string>>;
  start?: boolean;
}

/** A network ACL rule as AITC writes it. LXD leaves fields that are empty out of its own answers too. */
export interface LxdNetworkAclRule { action: "allow" | "reject" | "drop"; source?: string; destination?: string; state: "enabled" }
export interface LxdNetworkAclPut { description: string; egress: LxdNetworkAclRule[]; ingress: LxdNetworkAclRule[] }
interface LxdNetworkAclsPost extends LxdNetworkAclPut { name: string }
export interface LxdNetworksPost { name: string; description: string; type: "ovn"; config: Record<string, string> }
interface LxdNetworkPatch { config: LxdNetworksPost["config"] }

interface LxdStatePut { action: "start" | "stop" | "restart" | "freeze" | "unfreeze"; force: boolean; timeout: number }
interface LxdSnapshotsPost { name: string }
interface LxdRestorePut { restore: string }
interface LxdVolumesPost { name: string; content_type: "block"; config: { size: string } }
interface LxdCertificatesPost { type: "client"; trust_token: string }
interface LxdExecPost {
  command: string[];
  environment: Record<string, string>;
  interactive: false;
  "wait-for-websocket": true;
  "record-output": false;
}
type LxdRequestBody = LxdInstancesPost | LxdStatePut | LxdSnapshotsPost | LxdRestorePut | LxdVolumesPost | LxdCertificatesPost | LxdExecPost | LxdNetworksPost | LxdNetworkPatch | LxdNetworkAclsPost | LxdNetworkAclPut;

const errorResponse = Type.Object({ type: Type.Literal("error"), error: Type.String(), error_code: Type.Number() });
const syncResponse = <T extends TSchema>(metadata: T) => Type.Object({ type: Type.Literal("sync"), metadata });
const asyncResponse = <T extends TSchema>(metadata: T) => Type.Object({ type: Type.Literal("async"), operation: Type.String(), metadata: Type.Object({ metadata }) });
const finishedOperation = <T extends TSchema>(metadata: T) => syncResponse(Type.Object({ status_code: Type.Number(), err: Type.String(), metadata }));
interface LxdOperationResult { status_code: number; err: string }

const changeResponse = Type.Union([syncResponse(Type.Unknown()), asyncResponse(Type.Unknown())]);
const changeFinished = finishedOperation(Type.Unknown());
const serverResponse = syncResponse(Type.Object({ environment: Type.Object({ server_name: Type.String(), server_version: Type.String() }) }));
const certificateResponse = syncResponse(Type.Object({ restricted: Type.Boolean(), projects: Type.Array(Type.String()) }));
const projectResponse = syncResponse(Type.Object({ config: Type.Record(Type.String(), Type.String()) }));
const instanceSchema = Type.Object({
  name: Type.String(),
  type: Type.String(),
  status: Type.String(),
  config: Type.Record(Type.String(), Type.String()),
  /** The instance's own devices, without those its profiles add. */
  devices: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())),
});
export type LxdInstance = Static<typeof instanceSchema>;
export interface LxdInstanceDetails { snapshots: string[]; addresses: string[] }
const instanceResponse = syncResponse(instanceSchema);
const instancesResponse = syncResponse(Type.Array(instanceSchema));
const networkResponse = syncResponse(Type.Object({ config: Type.Record(Type.String(), Type.String()), used_by: Type.Union([Type.Array(Type.String()), Type.Null()]) }));
const networkAclRule = Type.Record(Type.String(), Type.String());
const networkAclResponse = syncResponse(Type.Object({ egress: Type.Array(networkAclRule), ingress: Type.Array(networkAclRule) }));
export interface LxdNetwork { config: Record<string, string>; usedBy: string[] }
export type LxdNetworkAcl = Pick<Static<typeof networkAclResponse>["metadata"], "egress" | "ingress">;
const profileResponse = syncResponse(Type.Object({ devices: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())) }));
const instanceNetwork = Type.Record(Type.String(), Type.Object({
  /** The device's host side; empty for interfaces the instance made itself, like docker0. */
  host_name: Type.String(),
  addresses: Type.Union([Type.Array(Type.Object({ family: Type.String(), address: Type.String(), scope: Type.String() })), Type.Null()]),
}));
const instanceDetailsResponse = syncResponse(Type.Object({
  snapshots: Type.Union([Type.Array(Type.Object({ name: Type.String() })), Type.Null()]),
  state: Type.Object({ network: Type.Union([instanceNetwork, Type.Null()]) }),
}));
const execStarted = asyncResponse(Type.Object({ fds: Type.Object({ "0": Type.String(), "1": Type.String(), "2": Type.String(), control: Type.String() }) }));
// A failed exec reports no exit status.
const execFinished = finishedOperation(Type.Union([Type.Object({ return: Type.Optional(Type.Number()) }), Type.Null()]));

export interface LxdExecProcess {
  stdout: AsyncIterable<Buffer>;
  stderr: AsyncIterable<Buffer>;
  write(data: Uint8Array): Promise<void>;
  closeStdin(): void;
  /** Ends the command however it's doing, also one that carries on after its input ends: LXD kills it once its control stream closes. */
  kill(): void;
  /** The command's exit status, once LXD reports the operation finished. */
  exited: Promise<number>;
}

const name = (value: string) => encodeURIComponent(value);

/** Requests about the server and AITC's own certificate, which need no project. */
export class LxdServerClient {
  constructor(protected readonly identity: LxdTlsIdentity) {}

  protected url(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(path, `https://${this.identity.server.address}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  /** `waits` is for LXD's operation waits, which send nothing until the operation ends, however long that takes. */
  protected async send(method: string, path: string, { body, query, signal, waits = false }: { body?: LxdRequestBody; query?: Record<string, string>; signal?: AbortSignal; waits?: boolean } = {}): Promise<Response> {
    return await fetch(this.url(path, query), {
      method,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      tls: lxdFetchTls(this.identity),
      // Otherwise Bun gives up on a request that's silent for 5 minutes; true keeps that.
      timeout: !waits,
    });
  }

  /** Decode LXD's response envelope, turning error responses into LxdRequestError. */
  protected async receive<T extends TSchema>(schema: T, response: Response, what: string): Promise<Static<T>> {
    const json: unknown = await response.json();
    if (Value.Check(errorResponse, json)) throw new LxdRequestError(json.error_code, `${what}: ${json.error}`);
    if (Value.Check(schema, json)) return json;
    const [first] = Value.Errors(schema, json);
    throw new AgentsInTheCloudCoreError("lxd_unexpected_response", `Unexpected LXD response to ${what}: ${first ? `${first.instancePath || "/"} ${first.message}` : "invalid"}`);
  }

  protected async get<T extends TSchema>(schema: T, path: string, query?: Record<string, string>): Promise<Static<T>> {
    return await this.receive(schema, await this.send("GET", path, { query }), `GET ${path}`);
  }

  protected async waitFor<T extends TSchema>(schema: T, operation: string, what: string): Promise<Static<T>> {
    return await this.receive(schema, await this.send("GET", `${operation}/wait`, { query: { timeout: "-1" }, waits: true }), `${what} (waiting)`);
  }

  protected succeeded(result: LxdOperationResult, what: string): void {
    if (result.status_code !== 200) throw new LxdRequestError(result.status_code, `${what}: ${result.err || `operation ended with status ${result.status_code}`}`);
  }

  /** Make a change, waiting for its operation when LXD runs it in the background. */
  protected async perform(method: string, path: string, body?: LxdRequestBody, signal?: AbortSignal): Promise<void> {
    const what = `${method} ${path}`;
    const response = await this.receive(changeResponse, await this.send(method, path, { body, signal }), what);
    if (response.type === "async") this.succeeded((await this.waitFor(changeFinished, response.operation, what)).metadata, what);
  }

  async server(): Promise<{ name: string; version: string }> {
    const { environment } = (await this.get(serverResponse, "/1.0")).metadata;
    return { name: environment.server_name, version: environment.server_version };
  }

  /** Redeem a trust token for the client certificate this connection presents. */
  async addCertificate(trustToken: string): Promise<void> {
    await this.perform("POST", "/1.0/certificates", { type: "client", trust_token: trustToken });
  }

  private ownCertificatePath(): string {
    return `/1.0/certificates/${certificateFingerprint(this.identity.credentials.certificate)}`;
  }

  /** How LXD trusts AITC: restricted certificates may only use the listed projects. */
  async ownCertificate(): Promise<Static<typeof certificateResponse>["metadata"]> {
    return (await this.get(certificateResponse, this.ownCertificatePath())).metadata;
  }

  /** Stop LXD from trusting AITC's certificate. Restricted certificates may remove themselves. */
  async removeOwnCertificate(signal?: AbortSignal): Promise<void> {
    await this.perform("DELETE", this.ownCertificatePath(), undefined, signal);
  }

  async projectConfig(project: string): Promise<Record<string, string>> {
    return (await this.get(projectResponse, `/1.0/projects/${name(project)}`)).metadata.config;
  }
}

/** One project on one LXD server, reached with AITC's restricted client certificate. */
export class LxdClient extends LxdServerClient {
  readonly location: LxdLocation;

  constructor(private readonly connection: LxdConnection) {
    super(connection);
    this.location = lxdLocation(connection);
  }

  protected override url(path: string, query: Record<string, string> = {}): URL {
    const url = super.url(path, query);
    url.searchParams.set("project", this.connection.project);
    return url;
  }

  async instances(): Promise<LxdInstance[]> {
    return (await this.get(instancesResponse, "/1.0/instances", { recursion: "1" })).metadata;
  }

  async instance(instance: string): Promise<LxdInstance> {
    return (await this.get(instanceResponse, `/1.0/instances/${name(instance)}`)).metadata;
  }

  /** An LXD profile's devices. With features.profiles off, the project shares the default project's profiles. */
  async profileDevices(profile: string): Promise<Record<string, Record<string, string>>> {
    return (await this.get(profileResponse, `/1.0/profiles/${name(profile)}`)).metadata.devices;
  }

  async network(network: string): Promise<LxdNetwork> {
    const { config, used_by } = (await this.get(networkResponse, `/1.0/networks/${name(network)}`)).metadata;
    return { config, usedBy: used_by ?? [] };
  }

  async createNetwork(post: LxdNetworksPost): Promise<void> {
    await this.perform("POST", "/1.0/networks", post);
  }

  /** Sets these settings, leaving the network's others as they are. */
  async updateNetwork(network: string, config: LxdNetworksPost["config"]): Promise<void> {
    await this.perform("PATCH", `/1.0/networks/${name(network)}`, { config });
  }

  /** LXD refuses while an instance uses the network. */
  async deleteNetwork(network: string): Promise<void> {
    await this.perform("DELETE", `/1.0/networks/${name(network)}`);
  }

  async networkAcl(acl: string): Promise<LxdNetworkAcl> {
    const { egress, ingress } = (await this.get(networkAclResponse, `/1.0/network-acls/${name(acl)}`)).metadata;
    return { egress, ingress };
  }

  async createNetworkAcl(acl: string, put: LxdNetworkAclPut): Promise<void> {
    await this.perform("POST", "/1.0/network-acls", { name: acl, ...put });
  }

  /** Replaces the ACL's rules; every network using it follows. */
  async updateNetworkAcl(acl: string, put: LxdNetworkAclPut): Promise<void> {
    await this.perform("PUT", `/1.0/network-acls/${name(acl)}`, put);
  }

  async createInstance(post: LxdInstancesPost): Promise<void> {
    await this.perform("POST", "/1.0/instances", post);
  }

  /** Without `force`, stop and restart give the instance 30 seconds to shut down cleanly. */
  async setInstanceState(instance: string, action: LxdStatePut["action"], force = false): Promise<void> {
    await this.perform("PUT", `/1.0/instances/${name(instance)}/state`, { action, force, timeout: 30 });
  }

  /** LXD refuses to delete a running instance; stop it first. */
  async deleteInstance(instance: string): Promise<void> {
    await this.perform("DELETE", `/1.0/instances/${name(instance)}`);
  }

  /** The file's contents, or undefined if it doesn't exist (yet). A VM's files come through its LXD agent, which may not be running. */
  async readInstanceFile(instance: string, path: string, signal?: AbortSignal): Promise<Buffer | undefined> {
    const response = await this.send("GET", `/1.0/instances/${name(instance)}/files`, { query: { path }, signal });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (response.status === 404) return undefined;
    // Every other status carries an error envelope, which receive throws.
    await this.receive(Type.Never(), response, `GET ${path} from ${instance}`);
  }

  /**
   * The instance's snapshots, and while it runs, the addresses its LXD network devices have, IPv4 first.
   * LXD (5.21 and 6.9) refuses restricted certificates on the snapshot endpoints themselves
   * ("No entitlements can be granted against entities of type instance_snapshot"),
   * so snapshots are listed through their instance and last until it is deleted.
   */
  async details(instance: string): Promise<LxdInstanceDetails> {
    const { metadata } = await this.get(instanceDetailsResponse, `/1.0/instances/${name(instance)}`, { recursion: "1" });
    const addresses = Object.values(metadata.state.network ?? {})
      .filter(device => device.host_name)
      .flatMap(device => (device.addresses ?? []).filter(address => address.scope === "global"))
      .sort((a, b) => Number(a.family !== "inet") - Number(b.family !== "inet"));
    return { snapshots: (metadata.snapshots ?? []).map(snapshot => snapshot.name), addresses: addresses.map(address => address.address) };
  }

  async snapshots(instance: string): Promise<string[]> {
    return (await this.details(instance)).snapshots;
  }

  async createSnapshot(instance: string, snapshot: string): Promise<void> {
    await this.perform("POST", `/1.0/instances/${name(instance)}/snapshots`, { name: snapshot });
  }

  async restoreSnapshot(instance: string, snapshot: string): Promise<void> {
    await this.perform("PUT", `/1.0/instances/${name(instance)}`, { restore: snapshot });
  }

  /** A raw block device for one machine, e.g. a ceph OSD disk; `size` uses LXD units such as `20GiB`. */
  async createBlockVolume(pool: string, volume: string, size: string): Promise<void> {
    await this.perform("POST", `/1.0/storage-pools/${name(pool)}/volumes/custom`, { name: volume, content_type: "block", config: { size } });
  }

  /** Deletes the volume's snapshots too. */
  async deleteVolume(pool: string, volume: string): Promise<void> {
    await this.perform("DELETE", `/1.0/storage-pools/${name(pool)}/volumes/custom/${name(volume)}`);
  }

  /** A volume attached to an instance isn't part of the instance's snapshots, so it has snapshots of its own. */
  async createVolumeSnapshot(pool: string, volume: string, snapshot: string): Promise<void> {
    await this.perform("POST", `/1.0/storage-pools/${name(pool)}/volumes/custom/${name(volume)}/snapshots`, { name: snapshot });
  }

  /** LXD refuses while an instance using the volume is running. */
  async restoreVolumeSnapshot(pool: string, volume: string, snapshot: string): Promise<void> {
    await this.perform("PUT", `/1.0/storage-pools/${name(pool)}/volumes/custom/${name(volume)}`, { restore: snapshot });
  }

  /** Start a command with separate stdin, stdout and stderr streams; no terminal is allocated. Read both outputs. */
  async exec(instance: string, command: string[], environment: Record<string, string> = {}): Promise<LxdExecProcess> {
    const what = `exec in ${instance}`;
    const path = `/1.0/instances/${name(instance)}/exec`;
    const started = await this.receive(execStarted, await this.send("POST", path, { body: { command, environment, interactive: false, "wait-for-websocket": true, "record-output": false } }), what);
    const { fds } = started.metadata.metadata;
    // LXD starts the command only once every stream is connected.
    const connecting = await Promise.allSettled([fds.control, fds["0"], fds["1"], fds["2"]].map(secret => LxdWebSocket.connect(this.connection, this.url(`${started.operation}/websocket`, { secret }))));
    const connected = connecting.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const refused = connecting.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (refused) {
      // Without every stream the command never starts, so the others would only wait.
      for (const stream of connected) stream.destroy();
      throw refused.reason;
    }
    const [control, stdin, stdout, stderr] = connected;
    const drainControl = async () => { for await (const _ of control!.messages()) { /* nothing on it needs a response */ } };
    // stdout, stderr and control end when LXD closes them. Nothing reads stdin, so release it here.
    const finish = async () => {
      const [operation, drained] = await Promise.allSettled([this.waitFor(execFinished, started.operation, what), drainControl()]);
      // LXD's own error explains a broken control stream too, so it comes first.
      if (operation.status === "rejected") throw operation.reason;
      const result = operation.value.metadata;
      this.succeeded(result, what);
      if (drained.status === "rejected") throw drained.reason;
      if (result.metadata?.return === undefined) throw new AgentsInTheCloudCoreError("lxd_unexpected_response", `${what}: LXD reported no exit status`);
      return result.metadata.return;
    };
    const exited = finish().finally(() => stdin!.destroy());
    return {
      stdout: stdout!.messages(),
      stderr: stderr!.messages(),
      write: (data) => stdin!.send(data),
      closeStdin: () => stdin!.close(),
      kill: () => control!.close(),
      exited,
    };
  }

  /**
   * Run a command to completion and collect its output. The instance decides how much it writes, so only the first
   * `keepBytes` of each stream are kept; the rest is read and dropped.
   */
  async run(instance: string, command: string[], input?: Uint8Array, keepBytes = 1024 * 1024): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
    const process = await this.exec(instance, command);
    const collect = async (stream: AsyncIterable<Buffer>) => {
      const chunks: Buffer[] = [];
      let kept = 0;
      for await (const chunk of stream) {
        if (kept >= keepBytes) continue;
        chunks.push(chunk.subarray(0, keepBytes - kept));
        kept += chunks.at(-1)!.length;
      }
      return Buffer.concat(chunks);
    };
    const feed = async () => {
      if (input) await process.write(input);
      process.closeStdin();
    };
    const [stdout, stderr, fed, exited] = await Promise.allSettled([collect(process.stdout), collect(process.stderr), feed(), process.exited]);
    // A command that couldn't start (say, in a VM still booting) also loses its streams; LXD's own error says why.
    if (exited.status === "rejected") throw exited.reason;
    if (stdout.status === "rejected") throw stdout.reason;
    if (stderr.status === "rejected") throw stderr.reason;
    if (fed.status === "rejected") throw fed.reason;
    return { exitCode: exited.value, stdout: stdout.value, stderr: stderr.value.toString() };
  }
}
