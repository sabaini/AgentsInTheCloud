import { randomUUID } from "node:crypto";
import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { findWorkspaceTemplateRecord, workspaceTemplatesFile, updateWorkspaceTemplateStore, workspaceTemplateMachineProfileSummary, type StoredWorkspaceTemplateMachineProfile, type WorkspaceTemplateMachineProfile, type WorkspaceTemplateRecord } from "./workspace-template.ts";

/** The image servers a profile may name, as in `ubuntu:24.04`; a bare alias names an image already on the LXD server. */
export const machineImageServers = {
  ubuntu: "https://cloud-images.ubuntu.com/releases",
  "ubuntu-daily": "https://cloud-images.ubuntu.com/daily",
  images: "https://images.lxd.canonical.com",
} as const;

export type MachineType = "virtual-machine" | "container";

export interface WorkspaceTemplateMachineProfileInput {
  name: string;
  image: string;
  type: MachineType;
  lxdProfiles: string[];
  cpus: number;
  memoryGiB: number;
  diskSizesGiB: number[];
  lifetimeHours: number;
}

const maxCpus = 128;
const maxMemoryGiB = 1_024;
const maxDisks = 16;
const maxDiskSizeGiB = 16_384;
const maxLifetimeHours = 720;
const maxMachinesLimit = 20;

function invalid(message: string): AgentsInTheCloudCoreError {
  return new AgentsInTheCloudCoreError("invalid_arguments", message);
}

function wholeNumberIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function normalizeProfile(input: WorkspaceTemplateMachineProfileInput): WorkspaceTemplateMachineProfileInput {
  const name = input.name.trim();
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw invalid("Profile names use lowercase letters, digits and hyphens, and start with a letter");
  const image = input.image.trim();
  const imageParts = /^(?:([a-z-]+):)?([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(image);
  if (!imageParts) throw invalid("Image must look like ubuntu:24.04");
  if (imageParts[1] !== undefined && !Object.hasOwn(machineImageServers, imageParts[1])) throw invalid(`Image server ${imageParts[1]} is unknown. Use ${Object.keys(machineImageServers).join(", ")}, or an image alias on the LXD server`);
  const lxdProfiles = [...new Set(input.lxdProfiles.map((profile) => profile.trim()).filter(Boolean))];
  if (!lxdProfiles.length) throw invalid("Add at least one LXD profile, such as default");
  const invalidProfile = lxdProfiles.find((profile) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile));
  if (invalidProfile) throw invalid(`${invalidProfile} isn't a valid LXD profile name`);
  if (!wholeNumberIn(input.cpus, 1, maxCpus)) throw invalid(`CPUs are a whole number from 1 to ${maxCpus}`);
  if (!wholeNumberIn(input.memoryGiB, 1, maxMemoryGiB)) throw invalid(`Memory is whole GiB from 1 to ${maxMemoryGiB}`);
  if (input.type === "container" && input.diskSizesGiB.length) throw invalid("Only virtual machines can have extra disks. Leave Extra disks empty for a container");
  if (input.diskSizesGiB.length > maxDisks) throw invalid(`A profile can have up to ${maxDisks} extra disks`);
  if (!input.diskSizesGiB.every((size) => wholeNumberIn(size, 1, maxDiskSizeGiB))) throw invalid(`Disk sizes are whole GiB from 1 to ${maxDiskSizeGiB}`);
  if (!wholeNumberIn(input.lifetimeHours, 1, maxLifetimeHours)) throw invalid(`Machines can last from 1 to ${maxLifetimeHours} hours`);
  return { name, image, type: input.type, lxdProfiles, cpus: input.cpus, memoryGiB: input.memoryGiB, diskSizesGiB: [...input.diskSizesGiB], lifetimeHours: input.lifetimeHours };
}

function findProfile(workspaceTemplate: WorkspaceTemplateRecord, profileId: string): StoredWorkspaceTemplateMachineProfile {
  const profile = workspaceTemplate.machineProfiles?.find((candidate) => candidate.id === profileId);
  if (!profile) throw new AgentsInTheCloudCoreError("workspace_template_machine_profile_not_found", `machine profile not found: ${profileId}`);
  return profile;
}

function assertNameAvailable(workspaceTemplate: WorkspaceTemplateRecord, name: string, exceptProfileId?: string): void {
  if (workspaceTemplate.machineProfiles?.some((profile) => profile.id !== exceptProfileId && profile.name === name)) throw new AgentsInTheCloudCoreError("workspace_template_machine_profile_exists", `This template already has a profile called ${name}`);
}

export async function createWorkspaceTemplateMachineProfile(workspaceTemplateId: string, input: WorkspaceTemplateMachineProfileInput, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateMachineProfile> {
  const values = normalizeProfile(input);
  return await updateWorkspaceTemplateStore(file, (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, workspaceTemplateId);
    assertNameAvailable(workspaceTemplate, values.name);
    const now = new Date().toISOString();
    const profile: StoredWorkspaceTemplateMachineProfile = { id: randomUUID(), ...values, createdAt: now, updatedAt: now };
    workspaceTemplate.machineProfiles = [...workspaceTemplate.machineProfiles ?? [], profile];
    return workspaceTemplateMachineProfileSummary(profile, workspaceTemplateId);
  });
}

/** Machines already created from the profile keep what they were created with. */
export async function updateWorkspaceTemplateMachineProfile(workspaceTemplateId: string, profileId: string, input: WorkspaceTemplateMachineProfileInput, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateMachineProfile> {
  const values = normalizeProfile(input);
  return await updateWorkspaceTemplateStore(file, (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, workspaceTemplateId);
    const profile = findProfile(workspaceTemplate, profileId);
    assertNameAvailable(workspaceTemplate, values.name, profileId);
    Object.assign(profile, values, { updatedAt: new Date().toISOString() });
    return workspaceTemplateMachineProfileSummary(profile, workspaceTemplateId);
  });
}

export async function deleteWorkspaceTemplateMachineProfile(workspaceTemplateId: string, profileId: string, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateMachineProfile> {
  return await updateWorkspaceTemplateStore(file, (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, workspaceTemplateId);
    const profile = findProfile(workspaceTemplate, profileId);
    workspaceTemplate.machineProfiles = workspaceTemplate.machineProfiles!.filter((candidate) => candidate !== profile);
    return workspaceTemplateMachineProfileSummary(profile, workspaceTemplateId);
  });
}

/** How many machines one workspace may hold at once. */
export async function setWorkspaceTemplateMaxMachines(workspaceTemplateId: string, maxMachines: number, file = workspaceTemplatesFile()): Promise<{ maxMachines: number }> {
  if (!wholeNumberIn(maxMachines, 1, maxMachinesLimit)) throw invalid(`Machines per workspace must be a whole number from 1 to ${maxMachinesLimit}`);
  return await updateWorkspaceTemplateStore(file, (store) => {
    findWorkspaceTemplateRecord(store, workspaceTemplateId).maxMachines = maxMachines;
    return { maxMachines };
  });
}
