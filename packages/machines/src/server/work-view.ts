import { AgentsInTheCloudCoreError, invalidArguments, readJsonObject, requestAcceptsJson, type JsonObject, type JsonValue } from "@agents-in-the-cloud/core";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { destructiveConfirmationHtml } from "@agents-in-the-cloud/design-system/destructive-confirmation";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { domId, errorMessage, escapeHtml, turboStream, turboStreamResponse, type WorkspaceAttachment, type WorkspaceModuleCommandHandler, type WorkspaceModuleRouteHandler, type WorkspaceModuleWorkViewAdapter } from "@agents-in-the-cloud/shared";
import { jsonResponse, matchRoute, wantsStream } from "@agents-in-the-cloud/shared/http";
import { createWorkspaceTerminal } from "@agents-in-the-cloud/workspace-terminal/server/workspace-terminals";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { MachineView } from "./leases.ts";
import { machineBootWaitMs, machineLeases, templateMachineSettings } from "./runtime.ts";

const reference = { type: "machines" } as const;
const referenceSchema = Type.Object({ type: Type.Literal("machines") });
const acquireSchema = Type.Object({ profile: Type.String(), name: Type.Optional(Type.String()) }, { additionalProperties: false });

const states = {
  creating: { label: "Being created", dot: "running" },
  starting: { label: "Booting", dot: "running" },
  ready: { label: "Ready", dot: "success" },
  stopped: { label: "Stopped, starts again when it’s next used", dot: "" },
  failed: { label: "Couldn’t be set up", dot: "danger" },
  missing: { label: "Gone from the LXD server", dot: "warning" },
  disconnected: { label: "On an LXD server that isn’t connected now", dot: "warning" },
} satisfies Record<MachineView["state"], { label: string; dot: string }>;

const errorTarget = (workspaceId: string) => domId("machines_view_error", workspaceId);

function remaining(expiresAt: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));
  return minutes < 90 ? `${minutes} min left` : `${Math.round(minutes / 60)} h left`;
}

function machineRow(workspaceId: string, machine: MachineView): string {
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/machines/${encodeURIComponent(machine.name)}`;
  const state = states[machine.state];
  const disks = machine.diskSizesGiB.length ? ` · ${machine.diskSizesGiB.length === 1 ? "1 extra disk" : `${machine.diskSizesGiB.length} extra disks`}` : "";
  const kind = machine.type === "virtual-machine" ? "VM" : "Container";
  const status = `<span class="status-dot ${state.dot}" aria-hidden="true"></span> ${escapeHtml(machine.error ? `${state.label}: ${machine.error}` : state.label)}`;
  const terminal = machine.state === "ready" || machine.state === "stopped"
    ? `<form method="post" action="${path}/terminal" data-turbo="true">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Open terminal", iconHtml: Icons.Terminal } })}</form>`
    : "";
  const release = `<form method="post" action="${path}/release" data-turbo="true">${destructiveConfirmationHtml({
    id: domId("release_machine", workspaceId, machine.name),
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Release" } },
    confirmCaption: `Release ${machine.name}`,
    cancelCaption: "Cancel",
  })}</form>`;
  return `<div class="managed-list__item">
    <span class="managed-list__visual" aria-hidden="true">${Icons.Server}</span>
    <div class="managed-list__content">
      <div class="managed-list__label"><span class="managed-list__label-text">${escapeHtml(machine.name)}</span></div>
      <div class="managed-list__description">${escapeHtml(`${kind} from ${machine.image}${disks} · ${remaining(machine.expiresAt)}`)}</div>
      <div class="managed-list__description">${status}</div>
    </div>
    <div class="managed-list__actions">${terminal}${release}</div>
  </div>`;
}

async function renderMachinesView(workspaceId: string): Promise<string> {
  let body: string;
  try {
    const [machines, { profiles }] = await Promise.all([machineLeases.list(workspaceId), machineLeases.settings(workspaceId)]);
    const empty = profiles.length
      ? `No machines yet. Agents create them from this template’s profiles: ${profiles.map((profile) => profile.name).join(", ")}.`
      : "This template has no machine profiles yet. Add some in its settings, under Machines.";
    body = machines.length ? `<div class="managed-list">${machines.map((machine) => machineRow(workspaceId, machine)).join("")}</div>` : `<p>${escapeHtml(empty)}</p>`;
  } catch (error) {
    body = `<p>${escapeHtml(errorMessage(error))}</p>`;
  }
  return `<div class="machines-view"><div id="${errorTarget(workspaceId)}"></div>${body}</div>`;
}

export const machinesWorkView: WorkspaceModuleWorkViewAdapter = {
  type: "machines",
  parseReference(value: JsonValue) {
    if (!Value.Check(referenceSchema, value)) throw new Error("Machines reference is invalid");
    return reference;
  },
  identity: () => "workspace",
  render: ({ workspaceId }) => renderMachinesView(workspaceId),
};

export const machinesOpenCommand: WorkspaceModuleCommandHandler = { id: "machines.open", execute: () => ({ createdWorkView: reference }) };

/** Only workspaces that can have machines, or still do, offer the view. */
export async function attachMachines(workspaceId: string, workspaceTemplateId: string | undefined): Promise<WorkspaceAttachment> {
  const [leases, { profiles }] = await Promise.all([machineLeases.stored(workspaceId), templateMachineSettings(workspaceTemplateId)]);
  if (!leases.length && !profiles.length) return {};
  return {
    workViews: [{ reference, sourceKey: "machines:workspace", label: "Machines", kind: "contextual", iconHtml: Icons.Server, availability: { phase: "live" }, initiallyOpen: false }],
    commands: [{ id: "machines.open", label: "Machines", description: "See this workspace’s test machines.", scope: "workspace", surfaces: { ui: { placement: "work-launcher", iconHtml: Icons.Server, label: "Machines" } } }],
  };
}

async function existingMachine(workspaceId: string, name: string): Promise<string> {
  if (!(await machineLeases.stored(workspaceId)).some((lease) => lease.name === name)) throw new AgentsInTheCloudCoreError("machine_unavailable", `This workspace has no machine called ${name}`);
  return name;
}

export const machineRoutes: WorkspaceModuleRouteHandler = {
  async handle(request, url, context) {
    let params: string[] | undefined;
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/machines$/))) {
      const workspaceId = params[0]!;
      if (request.method === "GET" && requestAcceptsJson(request)) {
        const [machines, { profiles, maxMachines }] = await Promise.all([machineLeases.list(workspaceId), machineLeases.settings(workspaceId)]);
        return jsonResponse({ machines, profiles: profiles.map(({ name, image, type, diskSizesGiB, lifetimeHours }) => ({ name, image, type, diskSizesGiB, lifetimeHours })), maxMachines });
      }
      if (request.method === "POST") {
        const body: JsonObject = await readJsonObject(request);
        if (!Value.Check(acquireSchema, body)) throw invalidArguments("A machine request needs a profile, and may name the machine");
        return jsonResponse({ machine: await machineLeases.acquire(workspaceId, body, machineBootWaitMs, request.signal) });
      }
    }
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/machines\/([^/]+)\/release$/)) && request.method === "POST") {
      const [workspaceId, name] = [params[0]!, params[1]!];
      if (requestAcceptsJson(request) && !wantsStream(request)) {
        await machineLeases.release(workspaceId, name);
        return jsonResponse({ released: name });
      }
      try {
        await machineLeases.release(workspaceId, name);
      } catch (error) {
        return turboStreamResponse(turboStream("update", errorTarget(workspaceId), `<p class="machines-view__error" role="alert">${escapeHtml(`Couldn’t release ${name}: ${errorMessage(error)}`)}</p>`));
      }
      // Releasing changes the leases, which refreshes the view.
      return turboStreamResponse("");
    }
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/machines\/([^/]+)\/terminal$/)) && request.method === "POST") {
      const [workspaceId, name] = [params[0]!, params[1]!];
      let terminalId: string;
      try {
        terminalId = (await createWorkspaceTerminal(workspaceId, { title: name, command: `ssh ${await existingMachine(workspaceId, name)}` })).id;
      } catch (error) {
        return turboStreamResponse(turboStream("update", errorTarget(workspaceId), `<p class="machines-view__error" role="alert">${escapeHtml(`Couldn’t open a terminal on ${name}: ${errorMessage(error)}`)}</p>`));
      }
      return await context.openWorkView(workspaceId, { type: "terminal", terminalId });
    }
    return undefined;
  },
};

const workspaceIdParameter = { name: "id", in: "path", required: true, schema: { type: "string" } };
const machineNameParameter = { name: "name", in: "path", required: true, schema: { type: "string" } };
const jsonResult = (description: string) => ({ "200": { description, content: { "application/json": { schema: { type: "object" } } } } });

export const machinesOpenApiPaths = {
  "/workspaces/{id}/machines": {
    get: { summary: "List a workspace's test machines, the profiles it may create them from, and how many it may hold", parameters: [workspaceIdParameter], responses: jsonResult("Machines with name, profile, type, image, state, expiry and snapshots") },
    post: {
      summary: "Create a test machine for a workspace from one of its template's machine profiles",
      description: "Waits up to 10 minutes for the machine to boot and returns its state; a machine still booting keeps booting. Needs an LXD server connected in Settings.",
      parameters: [workspaceIdParameter],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["profile"], properties: { profile: { type: "string" }, name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,39}$" } }, additionalProperties: false } } } },
      responses: jsonResult("The machine"),
    },
  },
  "/workspaces/{id}/machines/{name}/release": {
    post: { summary: "Delete a workspace's test machine with its disks and snapshots", parameters: [workspaceIdParameter, machineNameParameter], responses: jsonResult("The released machine's name") },
  },
} satisfies Record<string, JsonObject>;
