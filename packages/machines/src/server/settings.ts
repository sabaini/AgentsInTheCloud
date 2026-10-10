import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { destructiveConfirmationHtml } from "@agents-in-the-cloud/design-system/destructive-confirmation";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { errorMessage, escapeHtml, turboStream, turboStreamResponse, type SettingsContribution } from "@agents-in-the-cloud/shared";
import { createLxdClientCredentials, joinLxdServer, LxdClient, LxdServerClient, type LxdConnection, type LxdInstance } from "../lxd/index.ts";
import { disconnectLxd, readLxdConnection, saveLxdConnection } from "./connection.ts";
import { deleteUntrackedMachine, untrackedMachines } from "./lifecycle.ts";

const sectionId = "settings-sec-machines";
const connectPath = "/settings/machines/connect";
const disconnectPath = "/settings/machines/disconnect";
const deleteUntrackedPath = "/settings/machines/untracked/delete";
const suggestedProject = "agents-in-the-cloud";
const statusTimeoutMs = 5_000;

const limitLabels: [key: string, label: (value: string) => string][] = [
  ["limits.instances", value => `${value} instances`],
  ["limits.cpu", value => `${value} CPUs`],
  ["limits.memory", value => `${value} memory`],
  ["limits.disk", value => `${value} disk`],
];

function row(label: string, contentHtml: string, actionsHtml = ""): string {
  return `<div class="managed-list"><div class="managed-list__item">
    <span class="managed-list__visual machines-provider-icon" aria-hidden="true">${Icons.Server}</span>
    <div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">${escapeHtml(label)}</span></div>${contentHtml}</div>
    ${actionsHtml ? `<div class="managed-list__actions">${actionsHtml}</div>` : ""}
  </div></div>`;
}

function renderConnectForm(message: string): string {
  return row("LXD", `<form class="machines-connect form-stack" method="post" action="${connectPath}" data-turbo="true">
    <p>Give Agents their own test machines on an LXD server, for work that needs real disks, its own kernel or several machines. On that server, run:</p>
    <pre class="settings-command">lxc project create ${suggestedProject} \\
  -c features.images=false -c features.profiles=false
lxc config trust add --name ${suggestedProject} \\
  --restricted --projects ${suggestedProject}</pre>
    <p>Then paste the token it prints. AgentsInTheCloud can only use that project.</p>
    ${message ? `<p class="settings-error">${escapeHtml(message)}</p>` : ""}
    <div class="machines-connect__controls">
      <input class="settings-input text-field" type="password" name="token" aria-label="LXD trust token" placeholder="Paste the trust token" autocomplete="off" data-1p-ignore required>
      ${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Connect" }, attributesHtml: 'data-turbo-submits-with="Connecting…"' })}
    </div>
  </form>`);
}

function renderUntracked(machines: LxdInstance[]): string {
  if (!machines.length) return "";
  const rows = machines.map((machine, index) => {
    const workspace = machine.config["user.aitc.workspace"];
    const lease = machine.config["user.aitc.lease"];
    const remove = `<form method="post" action="${deleteUntrackedPath}" data-turbo="true"><input type="hidden" name="name" value="${escapeHtml(machine.name)}">${destructiveConfirmationHtml({
      id: `delete_untracked_machine_${index}`,
      trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Delete" } },
      confirmCaption: `Delete ${machine.name}`,
      cancelCaption: "Cancel",
    })}</form>`;
    return `<div class="managed-list__item">
      <span class="managed-list__visual" aria-hidden="true">${Icons.Server}</span>
      <div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">${escapeHtml(machine.name)}</span></div><div class="managed-list__description">${escapeHtml(`${lease ?? "A machine"} from workspace ${workspace} · ${machine.status.toLowerCase()}`)}</div></div>
      <div class="managed-list__actions">${remove}</div>
    </div>`;
  }).join("");
  return `<div class="machines-untracked"><p>These machines don’t belong to a workspace anymore. Delete them, with their disks and snapshots, when you no longer need them.</p><div class="managed-list">${rows}</div></div>`;
}

async function renderConnection(connection: LxdConnection, message: string): Promise<string> {
  const disconnect = `<form method="post" action="${disconnectPath}" data-turbo="true">${destructiveConfirmationHtml({
    id: "disconnect_lxd",
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Disconnect" } },
    confirmCaption: "Disconnect LXD",
    cancelCaption: "Cancel",
  })}</form>`;
  const where = `${connection.project} project at ${connection.server.address}`;
  const notice = message ? `<p class="settings-error">${escapeHtml(message)}</p>` : "";
  const lxd = new LxdServerClient(connection);
  // A server behind a dropped route would otherwise keep Settings loading for minutes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${statusTimeoutMs / 1000} seconds`)), statusTimeoutMs); });
  try {
    const [server, config, untracked] = await Promise.race([Promise.all([lxd.server(), lxd.projectConfig(connection.project), untrackedMachines(new LxdClient(connection))]), deadline]);
    const limits = limitLabels.flatMap(([key, label]) => config[key] ? [label(config[key])] : []);
    return row(`LXD on ${server.name}`, `<div class="managed-list__description">${escapeHtml(`${where} · LXD ${server.version}`)}</div>
      <div class="managed-list__description">${escapeHtml(limits.length ? `Limited to ${limits.join(", ")}` : "No project limits set")}</div>`, disconnect) + notice + renderUntracked(untracked);
  } catch (error) {
    return row("LXD", `<div class="managed-list__description">${escapeHtml(where)}</div>
      <div class="managed-list__description"><span class="status-dot warning" aria-hidden="true"></span> ${escapeHtml(`Can't reach it right now: ${errorMessage(error)}`)}</div>`, disconnect) + notice;
  } finally {
    clearTimeout(timer);
  }
}

async function renderMachinesSettings(message = ""): Promise<string> {
  const connection = await readLxdConnection();
  return `<section class="settings-sec settings-sec-machines" id="${sectionId}"><h2>Machines</h2>${connection ? await renderConnection(connection, message) : renderConnectForm(message)}</section>`;
}

async function connect(request: Request): Promise<string> {
  // A second submit from a stale page must not trust another certificate.
  if (await readLxdConnection()) return await renderMachinesSettings();
  const token = String((await request.formData()).get("token") ?? "");
  try {
    const credentials = await createLxdClientCredentials(suggestedProject);
    const { server, project } = await joinLxdServer(token, credentials);
    await saveLxdConnection({ server, project, credentials });
    return await renderMachinesSettings();
  } catch (error) {
    if (error instanceof AgentsInTheCloudCoreError) return await renderMachinesSettings(error.message);
    throw error;
  }
}

async function deleteUntracked(request: Request): Promise<string> {
  const connection = await readLxdConnection();
  if (!connection) return await renderMachinesSettings();
  try {
    await deleteUntrackedMachine(new LxdClient(connection), String((await request.formData()).get("name") ?? ""));
  } catch (error) {
    if (error instanceof AgentsInTheCloudCoreError) return await renderMachinesSettings(error.message);
    throw error;
  }
  return await renderMachinesSettings();
}

export const machinesSettingsContribution: SettingsContribution = {
  id: "machines",
  label: "Machines",
  order: 50,
  render: () => renderMachinesSettings(),
  async handleAction({ request, url }) {
    if (request.method !== "POST") return undefined;
    if (url.pathname === connectPath) return turboStreamResponse(turboStream("replace", sectionId, await connect(request)));
    if (url.pathname === disconnectPath) return turboStreamResponse(turboStream("replace", sectionId, await renderMachinesSettings(await disconnectLxd())));
    if (url.pathname === deleteUntrackedPath) return turboStreamResponse(turboStream("replace", sectionId, await deleteUntracked(request)));
    return undefined;
  },
};
