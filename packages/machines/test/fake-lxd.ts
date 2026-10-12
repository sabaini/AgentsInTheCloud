import type { WorkspaceTemplateMachineProfile } from "@agents-in-the-cloud/workspace-templates";
import { LxdRequestError, type LxdInstance, type LxdInstancesPost, type LxdLocation, type LxdNetworkAclPut, type LxdNetworkAclRule, type LxdNetworksPost } from "../src/lxd/index.ts";
import type { MachineLxd } from "../src/server/leases.ts";

type LxdDevices = Record<string, Record<string, string>>;
interface FakeInstance extends LxdInstance { post: LxdInstancesPost; snapshots: string[]; runningSnapshots: string[]; address: string; probesUntilBooted: number; cloudInitReadsLeft: number; files: Map<string, string> }

/** Just enough LXD for leases: VMs whose agent answers only after a few probes, like a booting VM. */
export class FakeLxd implements MachineLxd {
  instancesByName = new Map<string, FakeInstance>();
  volumes = new Map<string, string>();
  volumeSnapshots = new Map<string, string[]>();
  /** State changes, commands run, snapshots and restores, with the state of the instance they're for at the time. */
  log: string[] = [];
  profiles = new Map<string, LxdDevices>([
    ["default", { root: { type: "disk", path: "/", pool: "default" }, eth0: { type: "nic", network: "lxdbr0" } }],
    ["ceph-node", { root: { type: "disk", path: "/", pool: "fast" } }],
  ]);
  /** The project's config, sandboxed as the connect form suggests. */
  projectSettings: Awaited<ReturnType<MachineLxd["projectConfig"]>> = { restricted: "true", "restricted.snapshots": "allow", "features.images": "true", "features.profiles": "true", "features.networks": "true", "restricted.networks.uplinks": "UPLINK" };
  networks = new Map<string, Record<string, string>>();
  acls = new Map<string, Pick<LxdNetworkAclPut, "egress" | "ingress">>();
  probesUntilBooted = 3;
  hostKeys = new Map([["/etc/ssh/ssh_host_ed25519_key.pub", "ssh-ed25519 AAAAhost root@node\n"]]);
  failCreate?: string;

  constructor(readonly location: LxdLocation = { address: "lxd.test:8443", fingerprint: "a1", project: "agents-in-the-cloud" }) {}

  private existing(name: string): FakeInstance {
    const instance = this.instancesByName.get(name);
    if (!instance) throw new LxdRequestError(404, `Instance not found: ${name}`);
    return instance;
  }

  version = "6.9";
  async server() { return { name: "lxd-test", version: this.version }; }
  async projectConfig(project: string) {
    if (project !== this.location.project) throw new LxdRequestError(403, "Forbidden");
    return this.projectSettings;
  }
  async network(name: string) {
    const config = this.networks.get(name);
    if (!config) throw new LxdRequestError(404, "Network not found");
    const users = [...this.instancesByName.values()].filter((instance) => Object.values(instance.devices).some((device) => device.type === "nic" && device.network === name));
    return { config, usedBy: users.map((instance) => `/1.0/instances/${instance.name}?project=${this.location.project}`) };
  }
  async createNetwork(post: LxdNetworksPost) {
    if (this.networks.has(post.name)) throw new LxdRequestError(409, "The network already exists");
    this.networks.set(post.name, post.config);
  }
  async updateNetwork(name: string, config: LxdNetworksPost["config"]) {
    this.log.push(`update network ${name}`);
    this.networks.set(name, { ...(await this.network(name)).config, ...config });
  }
  async deleteNetwork(name: string) {
    if ((await this.network(name)).usedBy.length) throw new LxdRequestError(400, "The network is currently in use");
    this.networks.delete(name);
  }
  async networkAcl(name: string) {
    const acl = this.acls.get(name);
    if (!acl) throw new LxdRequestError(404, "Network ACL not found");
    // As LXD answers, without the fields left empty.
    const answer = (rule: LxdNetworkAclRule) => Object.fromEntries(Object.entries(rule).filter(([, value]) => value !== undefined));
    return { egress: acl.egress.map(answer), ingress: acl.ingress.map(answer) };
  }
  async createNetworkAcl(name: string, { egress, ingress }: LxdNetworkAclPut) {
    if (this.acls.has(name)) throw new LxdRequestError(409, "The network ACL already exists");
    this.acls.set(name, { egress, ingress });
  }
  async updateNetworkAcl(name: string, { egress, ingress }: LxdNetworkAclPut) {
    await this.networkAcl(name);
    this.log.push(`update ACL ${name}`);
    this.acls.set(name, { egress, ingress });
  }
  async instances() { return [...this.instancesByName.values()]; }
  async instance(name: string) { return this.existing(name); }
  async profileDevices(name: string) {
    const devices = this.profiles.get(name);
    if (!devices) throw new LxdRequestError(404, `Profile not found: ${name}`);
    return devices;
  }
  async createBlockVolume(pool: string, volume: string, size: string) { this.volumes.set(`${pool}/${volume}`, size); }
  async deleteVolume(pool: string, volume: string) {
    if (!this.volumes.delete(`${pool}/${volume}`)) throw new LxdRequestError(404, "Storage volume not found");
    this.volumeSnapshots.delete(`${pool}/${volume}`);
  }
  private usedBy(pool: string, volume: string): FakeInstance | undefined {
    return [...this.instancesByName.values()].find((instance) => Object.values(instance.devices).some((device) => device.pool === pool && device.source === volume));
  }
  async createVolumeSnapshot(pool: string, volume: string, snapshot: string) {
    if (!this.volumes.has(`${pool}/${volume}`)) throw new LxdRequestError(404, "Storage volume not found");
    this.volumeSnapshots.set(`${pool}/${volume}`, [...this.volumeSnapshots.get(`${pool}/${volume}`) ?? [], snapshot]);
    this.log.push(`snapshot ${volume} ${snapshot} while ${this.usedBy(pool, volume)?.status}`);
  }
  async restoreVolumeSnapshot(pool: string, volume: string, snapshot: string) {
    if (!this.volumeSnapshots.get(`${pool}/${volume}`)?.includes(snapshot)) throw new LxdRequestError(404, "Storage volume snapshot not found");
    const user = this.usedBy(pool, volume);
    if (user && user.status !== "Stopped") throw new LxdRequestError(400, "Cannot restore custom volume used by running instances");
    this.log.push(`restore ${volume} ${snapshot} while ${user?.status}`);
  }
  async createInstance(post: LxdInstancesPost) {
    if (this.failCreate) throw new LxdRequestError(400, this.failCreate);
    for (const device of Object.values(post.devices ?? {})) if (device.type === "nic" && !this.networks.has(device.network!)) throw new LxdRequestError(404, "Network not found");
    this.instancesByName.set(post.name, { name: post.name, type: post.type, status: "Running", config: post.config ?? {}, devices: post.devices ?? {}, post, snapshots: [], runningSnapshots: [], address: `10.0.0.${this.instancesByName.size + 2}`, probesUntilBooted: this.probesUntilBooted, cloudInitReadsLeft: 0, files: new Map(this.hostKeys) });
  }
  async setInstanceState(name: string, action: "start" | "stop" | "restart" | "freeze" | "unfreeze") {
    this.log.push(`${action} ${name}`);
    this.existing(name).status = action === "stop" ? "Stopped" : action === "freeze" ? "Frozen" : "Running";
  }
  async deleteInstance(name: string) {
    if (this.existing(name).status !== "Stopped") throw new LxdRequestError(400, "Instance is running");
    this.instancesByName.delete(name);
  }
  async readInstanceFile(name: string, path: string) {
    const instance = this.existing(name);
    if (instance.status !== "Running" || instance.probesUntilBooted-- > 0) throw new LxdRequestError(500, "LXD VM agent is not currently running");
    // Once the agent answers, cloud-init may still be running this boot: only its result in /run says when it's done.
    if (path === "/run/cloud-init/result.json") {
      if (instance.cloudInitReadsLeft <= 0) return Buffer.from("../../var/lib/cloud/data/result.json");
      instance.cloudInitReadsLeft--;
      return undefined;
    }
    // Left on disk by an earlier boot.
    if (path === "/var/lib/cloud/instance/boot-finished") return Buffer.from("done");
    const file = instance.files.get(path);
    return file === undefined ? undefined : Buffer.from(file);
  }
  async run(name: string, command: string[]) {
    const instance = this.existing(name);
    this.log.push(`run ${command.join(" ")} in ${name} while ${instance.status}`);
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
  }
  async details(name: string) {
    const instance = this.existing(name);
    return { snapshots: instance.snapshots, addresses: instance.status === "Running" ? [instance.address] : [] };
  }
  async snapshots(name: string) { return this.existing(name).snapshots; }
  async createSnapshot(name: string, snapshot: string) {
    const instance = this.existing(name);
    instance.snapshots.push(snapshot);
    if (instance.status !== "Stopped") instance.runningSnapshots.push(snapshot);
    this.log.push(`snapshot ${name} ${snapshot} while ${instance.status}`);
  }
  async restoreSnapshot(name: string, snapshot: string) {
    const instance = this.existing(name);
    if (!instance.snapshots.includes(snapshot)) throw new LxdRequestError(404, "Snapshot not found");
    // A running instance's snapshot holds its NIC's host-side name, which a restricted project won't set on a stopped one.
    if (instance.runningSnapshots.includes(snapshot) && instance.status === "Stopped") throw new LxdRequestError(500, `Setting "volatile.eth0.host_name" on ${instance.type} "${name}" in project "${this.location.project}" is forbidden`);
    this.log.push(`restore ${name} ${snapshot} while ${instance.status}`);
    instance.probesUntilBooted = 2;
  }
}

export const nodeProfile: WorkspaceTemplateMachineProfile = { id: "p1", workspaceTemplateId: "t", name: "node", image: "ubuntu:24.04", type: "virtual-machine", lxdProfiles: ["default", "ceph-node"], cpus: 2, memoryGiB: 4, diskSizesGiB: [20, 20, 20], lifetimeHours: 24, createdAt: "", updatedAt: "" };
export const clientProfile: WorkspaceTemplateMachineProfile = { ...nodeProfile, id: "p2", name: "client", type: "container", lxdProfiles: ["default"], cpus: 1, memoryGiB: 1, diskSizesGiB: [] };
