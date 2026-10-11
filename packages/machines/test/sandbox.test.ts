import { expect, test } from "bun:test";
import { lxdVersionKeepsSnapshots, projectSandbox } from "../src/server/sandbox.ts";

const sandboxed = { restricted: "true", "restricted.snapshots": "allow", "features.images": "true", "features.profiles": "true", "features.networks": "true", "restricted.networks.uplinks": "UPLINK", "limits.instances": "20" };

test("the project the connect form suggests keeps machines sandboxed on its one uplink", () => {
  expect(projectSandbox(sandboxed)).toEqual({ uplink: "UPLINK", missing: [], unsafe: [] });
  expect(projectSandbox({ ...sandboxed, "restricted.backups": "allow", "restricted.cluster.target": "allow", "restricted.containers.interception": "allow" }).unsafe).toEqual([]);
});

test("each missing piece is named", () => {
  // As the connect form suggested before machines had networks of their own.
  expect(projectSandbox({ "features.images": "false", "features.profiles": "false" })).toEqual({ missing: ["restricted=true", "restricted.snapshots=allow", "features.images=true", "features.profiles=true", "features.networks=true", "restricted.networks.uplinks=UPLINK"], unsafe: [] });
  expect(projectSandbox({ ...sandboxed, "restricted.networks.uplinks": "UPLINK,lxdbr0" })).toEqual({ missing: ["restricted.networks.uplinks=UPLINK"], unsafe: [] });
});

test("settings that hand out the LXD host or its devices are named", () => {
  const unsafe = {
    "restricted.containers.privilege": "allow",
    "restricted.containers.nesting": "allow",
    "restricted.containers.lowlevel": "allow",
    "restricted.containers.interception": "full",
    "restricted.virtual-machines.lowlevel": "allow",
    "restricted.devices.disk": "allow",
    "restricted.devices.nic": "allow",
    "restricted.devices.proxy": "allow",
    "restricted.devices.unix-char": "allow",
    "restricted.idmap.uid": "1000",
  };
  expect(projectSandbox({ ...sandboxed, ...unsafe })).toEqual({ uplink: "UPLINK", missing: [], unsafe: Object.keys(unsafe).sort() });
  // Their safe values are fine.
  expect(projectSandbox({ ...sandboxed, "restricted.containers.privilege": "isolated", "restricted.devices.disk": "managed", "restricted.devices.nic": "managed" }).unsafe).toEqual([]);
});

test("LXD 6.9 keeps VM snapshots restorable in a restricted project, and earlier ones don't", () => {
  expect(["5.21.8", "6.0.3", "6.8", "6.9", "6.10", "7.0"].map(lxdVersionKeepsSnapshots)).toEqual([false, false, false, true, true, true]);
});
