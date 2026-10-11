import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { destructiveConfirmationHtml } from "@agents-in-the-cloud/design-system/destructive-confirmation";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { errorMessage, escapeHtml, turboStream, turboStreamResponse, type SettingsContribution } from "@agents-in-the-cloud/shared";
import { createLxdClientCredentials, joinLxdServer, LxdClient, LxdServerClient, type LxdConnection, type LxdInstance } from "../lxd/index.ts";
import { disconnectLxd, readLxdConnection, saveLxdConnection } from "./connection.ts";
import { deleteUntrackedMachine, untrackedMachines } from "./lifecycle.ts";
import { lxdVersionKeepsSnapshots, projectSandbox } from "./sandbox.ts";

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
    <p>Give Agents their own test machines on a server with LXD 6.9 or later and OVN, like a MicroCloud, for work that needs real disks, its own kernel or several machines. On that server, run:</p>
    <pre class="settings-command">lxc project create ${suggestedProject} \\
  -c features.images=false -c features.profiles=true \\
  -c features.networks=true -c restricted=true \\
  -c restricted.snapshots=allow \\
  -c restricted.networks.uplinks=UPLINK
lxc profile device add default root disk path=/ \\
  pool=local --project ${suggestedProject}
lxc config trust add --name ${suggestedProject} \\
  --restricted --projects ${suggestedProject}</pre>
    <p>${notOnMicroCloud} Then paste the token the last command prints. AgentsInTheCloud can only use that project, and keeps each workspace’s machines on a network of their own.</p>
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

const notOnMicroCloud = "Not on a MicroCloud? Use your OVN uplink network and storage pool in place of UPLINK and local.";

/** The commands that would sandbox the project, if it isn't, and whether they name MicroCloud's uplink or pool. */
function sandboxFixes(project: string, config: Record<string, string>) {
  const { missing, unsafe } = projectSandbox(config);
  const commands: string[] = [];
  if (missing.length) commands.push(`lxc project set ${project} ${missing.join(" ")}`);
  // Its own default profile starts out empty. LXD itself says when the project has to be emptied first.
  const ownProfiles = missing.includes("features.profiles=true");
  if (ownProfiles) commands.push(`lxc profile device add default root disk path=/ pool=local --project ${project}`);
  commands.push(...unsafe.map((key) => `lxc project unset ${project} ${key}`));
  return { commands, microCloudNames: ownProfiles || missing.includes("restricted.networks.uplinks=UPLINK") };
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
    const upgrade = lxdVersionKeepsSnapshots(server.version) ? "" : `<div class="managed-list__description"><span class="status-dot warning" aria-hidden="true"></span> No new machines until the server runs LXD 6.9 or later. On a snap install, run <code>snap refresh lxd --channel=6/stable</code> there.</div>`;
    const fixes = sandboxFixes(connection.project, config);
    const sandbox = fixes.commands.length ? `<div class="managed-list__description"><span class="status-dot warning" aria-hidden="true"></span> No new machines until this project keeps them apart from the rest of the network. On the LXD server, run:</div>
      <pre class="settings-command">${escapeHtml(fixes.commands.join("\n"))}</pre>${fixes.microCloudNames ? `<div class="managed-list__description">${notOnMicroCloud}</div>` : ""}` : "";
    return row(`LXD on ${server.name}`, `<div class="managed-list__description">${escapeHtml(`${where} · LXD ${server.version}`)}</div>
      <div class="managed-list__description">${escapeHtml(limits.length ? `Limited to ${limits.join(", ")}` : "No project limits set")}</div>${upgrade}${sandbox}`, disconnect) + notice + renderUntracked(untracked);
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
