import type { WorkspaceTemplateMachineProfile } from "@agents-in-the-cloud/workspace-templates";
import { LxdRequestError, type LxdInstance, type LxdInstancesPost, type LxdLocation } from "../src/lxd/index.ts";
import type { MachineLxd } from "../src/server/leases.ts";

type LxdDevices = Record<string, Record<string, string>>;
interface FakeInstance extends LxdInstance { post: LxdInstancesPost; snapshots: string[]; address: string; probesUntilBooted: number; cloudInitReadsLeft: number; files: Map<string, string> }

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
  probesUntilBooted = 3;
  hostKeys = new Map([["/etc/ssh/ssh_host_ed25519_key.pub", "ssh-ed25519 AAAAhost root@node\n"]]);
  failCreate?: string;

  constructor(readonly location: LxdLocation = { address: "lxd.test:8443", fingerprint: "a1", project: "agents-in-the-cloud" }) {}

  private existing(name: string): FakeInstance {
    const instance = this.instancesByName.get(name);
    if (!instance) throw new LxdRequestError(404, `Instance not found: ${name}`);
    return instance;
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
    this.instancesByName.set(post.name, { name: post.name, type: post.type, status: "Running", config: post.config ?? {}, devices: post.devices ?? {}, post, snapshots: [], address: `10.0.0.${this.instancesByName.size + 2}`, probesUntilBooted: this.probesUntilBooted, cloudInitReadsLeft: 0, files: new Map(this.hostKeys) });
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
    this.log.push(`snapshot ${name} ${snapshot} while ${instance.status}`);
  }
  async restoreSnapshot(name: string, snapshot: string) {
    const instance = this.existing(name);
    if (!instance.snapshots.includes(snapshot)) throw new LxdRequestError(404, "Snapshot not found");
    this.log.push(`restore ${name} ${snapshot} while ${instance.status}`);
    instance.probesUntilBooted = 2;
  }
}

export const nodeProfile: WorkspaceTemplateMachineProfile = { id: "p1", workspaceTemplateId: "t", name: "node", image: "ubuntu:24.04", type: "virtual-machine", lxdProfiles: ["default", "ceph-node"], diskSizesGiB: [20, 20, 20], lifetimeHours: 24, createdAt: "", updatedAt: "" };
export const clientProfile: WorkspaceTemplateMachineProfile = { ...nodeProfile, id: "p2", name: "client", type: "container", lxdProfiles: ["default"], diskSizesGiB: [] };
