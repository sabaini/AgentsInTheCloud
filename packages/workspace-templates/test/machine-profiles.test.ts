import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createWorkspaceTemplateRoutes } from "../../../apps/web/src/server/workspace-template-routes.ts";
import { addWorkspaceTemplate, createWorkspaceTemplateMachineProfile, deleteWorkspaceTemplateMachineProfile, getWorkspaceTemplateConfiguration, setWorkspaceTemplateMaxMachines, updateWorkspaceTemplateMachineProfile, type WorkspaceTemplateMachineProfileInput } from "@agents-in-the-cloud/workspace-templates";
import { workspaceTemplatesFile } from "../src/workspace-template.ts";

type RequestFields = Record<string, string | number | string[] | number[]>;
const node: WorkspaceTemplateMachineProfileInput = { name: "node", image: "ubuntu:24.04", type: "virtual-machine", lxdProfiles: ["default"], cpus: 2, memoryGiB: 2, diskSizesGiB: [20, 20, 20], lifetimeHours: 24 };

describe("Workspace template machine profiles", () => {
  let previousDataDir: string | undefined;
  let dataDir: string;
  let workspaceTemplateId: string;

  beforeEach(async () => {
    previousDataDir = process.env.ATELIER_DATA_DIR;
    dataDir = await mkdtemp(`${tmpdir()}/agents-in-the-cloud-machine-profiles-`);
    process.env.ATELIER_DATA_DIR = dataDir;
    workspaceTemplateId = (await addWorkspaceTemplate("https://github.com/canonical/microceph.git")).workspaceTemplate.id;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("templates saved before Machines have no profiles and allow ten machines per workspace", async () => {
    expect(await getWorkspaceTemplateConfiguration(workspaceTemplateId)).toMatchObject({ machineProfiles: [], maxMachines: 10 });
  });

  test("profiles are saved, tidied, renamed and deleted", async () => {
    const created = await createWorkspaceTemplateMachineProfile(workspaceTemplateId, { ...node, name: " node ", image: " ubuntu:24.04 ", lxdProfiles: ["default", " ceph-node ", "default", ""] });
    expect(created).toMatchObject({ workspaceTemplateId, name: "node", image: "ubuntu:24.04", lxdProfiles: ["default", "ceph-node"], diskSizesGiB: [20, 20, 20] });
    expect(JSON.parse(await readFile(workspaceTemplatesFile(), "utf8")).projects[0].machineProfiles).toHaveLength(1);

    await createWorkspaceTemplateMachineProfile(workspaceTemplateId, { ...node, name: "client", type: "container", diskSizesGiB: [] });
    await expect(createWorkspaceTemplateMachineProfile(workspaceTemplateId, node)).rejects.toThrow("already has a profile called node");
    await expect(updateWorkspaceTemplateMachineProfile(workspaceTemplateId, created.id, { ...node, name: "client" })).rejects.toThrow("already has a profile called client");

    const renamed = await updateWorkspaceTemplateMachineProfile(workspaceTemplateId, created.id, { ...node, name: "osd-node", image: "images:ubuntu/24.04/cloud", lifetimeHours: 48 });
    expect(renamed).toMatchObject({ id: created.id, name: "osd-node", image: "images:ubuntu/24.04/cloud", lifetimeHours: 48, createdAt: created.createdAt });
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplateId)).machineProfiles.map((profile) => profile.name)).toEqual(["client", "osd-node"]);

    await deleteWorkspaceTemplateMachineProfile(workspaceTemplateId, created.id);
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplateId)).machineProfiles.map((profile) => profile.name)).toEqual(["client"]);
    await expect(deleteWorkspaceTemplateMachineProfile(workspaceTemplateId, created.id)).rejects.toThrow("machine profile not found");
  });

  test("profiles that LXD couldn't create are refused before they're saved", async () => {
    const refusals: [Partial<WorkspaceTemplateMachineProfileInput>, string][] = [
      [{ name: "Node" }, "lowercase letters"],
      [{ name: "" }, "lowercase letters"],
      [{ image: "ubuntu 24.04" }, "Use an image like ubuntu:24.04"],
      [{ image: "docker:ubuntu" }, "Image server docker is unknown"],
      [{ lxdProfiles: [" "] }, "at least one LXD profile"],
      [{ lxdProfiles: ["default", "bad/profile"] }, "bad/profile isn't a valid LXD profile name"],
      [{ cpus: 0 }, "CPUs are a whole number from 1 to 128"],
      [{ memoryGiB: 1.5 }, "Memory is whole GiB from 1 to 1024"],
      [{ type: "container" }, "Only virtual machines can have extra disks"],
      [{ diskSizesGiB: [0] }, "whole GiB"],
      [{ diskSizesGiB: [1.5] }, "whole GiB"],
      [{ diskSizesGiB: Array.from({ length: 17 }, () => 1) }, "up to 16 extra disks"],
      [{ lifetimeHours: 0 }, "hours from 1 to 720"],
      [{ lifetimeHours: Number.NaN }, "hours from 1 to 720"],
    ];
    for (const [change, message] of refusals) await expect(createWorkspaceTemplateMachineProfile(workspaceTemplateId, { ...node, ...change })).rejects.toThrow(message);
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplateId)).machineProfiles).toEqual([]);
    expect((await createWorkspaceTemplateMachineProfile(workspaceTemplateId, { ...node, image: "my-local-image" })).image).toBe("my-local-image");
  });

  test("the per-workspace limit is a whole number from 1 to 20", async () => {
    expect(await setWorkspaceTemplateMaxMachines(workspaceTemplateId, 5)).toEqual({ maxMachines: 5 });
    for (const invalid of [0, 21, 2.5]) await expect(setWorkspaceTemplateMaxMachines(workspaceTemplateId, invalid)).rejects.toThrow("from 1 to 20");
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplateId)).maxMachines).toBe(5);
  });

  test("the HTTP API accepts JSON and settings forms", async () => {
    let invalidations = 0;
    const routes = createWorkspaceTemplateRoutes({
      referencingWorkspaces: () => [],
      // Profiles decide whether workspaces offer their Machines view; the limit only matters for new machines.
      invalidatePresentation: () => { invalidations++; },
      createAgentWorkspace: async () => new Response(),
    });
    const post = async (path: string, body: RequestFields, json = true) => {
      const url = new URL(`http://localhost/workspace-templates/${workspaceTemplateId}${path}`);
      const request = json
        ? new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) })
        : new Request(url, { method: "POST", body: new URLSearchParams(Object.entries(body).map(([name, value]) => [name, String(value)])) });
      return (await routes.handle(request, url))!;
    };

    const created = await (await post("/machine-profiles", { ...node })).json();
    expect(created.machineProfile).toMatchObject({ workspaceTemplateId, name: "node", diskSizesGiB: [20, 20, 20] });
    await expect(post("/machine-profiles", { ...node, cpu: 4 })).rejects.toThrow("needs name, image, type");
    await expect(post("/machine-profiles", { ...node, diskSizesGiB: "20" })).rejects.toThrow("needs name, image, type");

    const form = await post(`/machine-profiles/${created.machineProfile.id}`, { name: "node", image: "ubuntu:26.04", type: "virtual-machine", lxdProfiles: "default, ceph-node", cpus: "4", memoryGiB: "8", diskSizesGiB: "20,20  40", lifetimeHours: "12" }, false);
    expect(form.status).toBe(303);
    expect(form.headers.get("location")).toBe(`http://localhost/workspace-templates/${workspaceTemplateId}/settings?section=machines&editor=${created.machineProfile.id}`);
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplateId)).machineProfiles[0]).toMatchObject({ image: "ubuntu:26.04", type: "virtual-machine", lxdProfiles: ["default", "ceph-node"], cpus: 4, memoryGiB: 8, diskSizesGiB: [20, 20, 40], lifetimeHours: 12 });
    await post(`/machine-profiles/${created.machineProfile.id}`, { name: "node", image: "ubuntu:26.04", type: "container", lxdProfiles: "default", cpus: "1", memoryGiB: "1", diskSizesGiB: "", lifetimeHours: "12" }, false);
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplateId)).machineProfiles[0]).toMatchObject({ type: "container", diskSizesGiB: [] });
    // Settings forms show the refusal next to the form instead.
    expect((await post(`/machine-profiles/${created.machineProfile.id}`, { name: "node", image: "ubuntu:26.04", type: "laptop", lxdProfiles: "default", cpus: "1", memoryGiB: "1", diskSizesGiB: "", lifetimeHours: "12" }, false)).status).toBe(422);
    expect((await post(`/machine-profiles/${created.machineProfile.id}`, { name: "node", image: "ubuntu:26.04", type: "virtual-machine", lxdProfiles: "default", cpus: "1", memoryGiB: "1", diskSizesGiB: "20 GiB", lifetimeHours: "12" }, false)).status).toBe(422);
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplateId)).machineProfiles[0]!.type).toBe("container");

    const profileInvalidations = invalidations;
    expect(profileInvalidations).toBeGreaterThan(0);
    expect(await (await post("/max-machines", { maxMachines: 6 })).json()).toEqual({ maxMachines: 6 });
    expect((await post("/max-machines", { maxMachines: "4" }, false)).headers.get("location")).toEndWith("settings?section=machines&editor=limit");
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplateId)).maxMachines).toBe(4);
    expect(invalidations).toBe(profileInvalidations);

    expect(await (await post(`/machine-profiles/${created.machineProfile.id}/delete`, {})).json()).toMatchObject({ deleted: true, machineProfile: { id: created.machineProfile.id } });
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplateId)).machineProfiles).toEqual([]);
  });
});
