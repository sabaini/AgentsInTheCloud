import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { copyButtonHtml } from "@agents-in-the-cloud/design-system/copy-button";
import { destructiveConfirmationHtml } from "@agents-in-the-cloud/design-system/destructive-confirmation";
import { disclosureHtml } from "@agents-in-the-cloud/design-system/disclosure";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { errorMessage, escapeHtml, turboStream, turboStreamResponse, type SettingsContribution } from "@agents-in-the-cloud/shared";
import { createLxdClientCredentials, joinLxdServer, LxdClient, lxdLocation, LxdServerClient, type LxdConnection, type LxdInstance } from "../lxd/index.ts";
import { addLxdConnection, answeredInTime, disconnectLxd, readLxdConnections } from "./connection.ts";
import { deleteUntrackedMachine, untrackedMachines } from "./lifecycle.ts";
import { lxdVersionKeepsSnapshots, projectSandbox } from "./sandbox.ts";

const sectionId = "settings-sec-machines";
const connectPath = "/settings/machines/connect";
const disconnectPath = "/settings/machines/disconnect";
const deleteUntrackedPath = "/settings/machines/untracked/delete";
const setupScriptUrl = "https://raw.githubusercontent.com/sabaini/AgentsInTheCloud/machines-ovn/packages/machines/setup-lxd-host.sh";
const suggestedProject = "agents-in-the-cloud";

const limitLabels: [key: string, label: (value: string) => string][] = [
  ["limits.instances", value => `${value} machines`],
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

const setupCommand = `curl -fsSL ${setupScriptUrl} | sudo bash`;

/** `introHtml` says what connecting a server is for. */
function connectFormHtml(introHtml: string, message: string): string {
  return `<form class="machines-connect form-stack" method="post" action="${connectPath}" data-turbo="true">
    ${introHtml}
    <p>On a fresh Ubuntu server, this command sets up LXD and OVN:</p>
    <div class="machines-setup-command"><pre class="settings-command">${escapeHtml(setupCommand)}</pre>${copyButtonHtml({ label: "Copy command", copyText: setupCommand })}</div>
    <p>If the server already has LXD 6.9 or later and OVN, like a MicroCloud, run this instead:</p>
    <pre class="settings-command">lxc project create ${suggestedProject} \\
  -c features.profiles=true -c features.networks=true \\
  -c restricted=true -c restricted.snapshots=allow \\
  -c restricted.networks.uplinks=UPLINK
lxc profile device add default root disk path=/ \\
  pool=local --project ${suggestedProject}
lxc config trust add --name ${suggestedProject} \\
  --restricted --projects ${suggestedProject}</pre>
    <p>${notOnMicroCloud} Either way, you get a token to paste here. AgentsInTheCloud can only use the project it’s for, and keeps each workspace’s machines on a network of their own.</p>
    ${message ? `<p class="settings-error">${escapeHtml(message)}</p>` : ""}
    <div class="machines-connect__controls">
      <input class="settings-input text-field" type="password" name="token" aria-label="LXD trust token" placeholder="Paste the trust token" autocomplete="off" data-1p-ignore required>
      ${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Connect" }, attributesHtml: 'data-turbo-submits-with="Connecting…"' })}
    </div>
  </form>`;
}

/** Which connected server a form is about: its certificate and project, which stay when its address changes. */
function serverFieldsHtml(connection: LxdConnection): string {
  return `<input type="hidden" name="fingerprint" value="${escapeHtml(lxdLocation(connection).fingerprint)}"><input type="hidden" name="project" value="${escapeHtml(connection.project)}">`;
}

/** The connected server a form names; none when it's been disconnected meanwhile, as from another page. */
async function namedConnection(form: FormData): Promise<LxdConnection | undefined> {
  const fingerprint = String(form.get("fingerprint") ?? "");
  const project = String(form.get("project") ?? "");
  return (await readLxdConnections()).find((connection) => connection.project === project && lxdLocation(connection).fingerprint === fingerprint);
}

/** `serverName` is what the server calls itself. */
function renderUntracked(connection: LxdConnection, serverName: string, index: number, machines: LxdInstance[]): string {
  if (!machines.length) return "";
  const rows = machines.map((machine, row) => {
    const workspace = machine.config["user.aitc.workspace"];
    const lease = machine.config["user.aitc.lease"];
    const remove = `<form method="post" action="${deleteUntrackedPath}" data-turbo="true">${serverFieldsHtml(connection)}<input type="hidden" name="name" value="${escapeHtml(machine.name)}">${destructiveConfirmationHtml({
      id: `delete_untracked_machine_${index}_${row}`,
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
  return `<div class="machines-untracked"><p>${escapeHtml(`These machines on ${serverName} don’t belong to a workspace anymore.`)} Delete them, with their disks and snapshots, when you no longer need them.</p><div class="managed-list">${rows}</div></div>`;
}

const notOnMicroCloud = "Not on a MicroCloud? Use your OVN uplink network and storage pool in place of UPLINK and local.";

/** The commands that would sandbox the project, if it isn't, and whether they name MicroCloud's uplink or pool. */
function sandboxFixes(project: string, config: Record<string, string>) {
  const { missing, unsafe } = projectSandbox(config);
  const commands: string[] = [];
  // One update, since a MicroCloud refuses any other change to a project without images of its own.
  if (missing.length) commands.push(`lxc project set ${project} ${missing.join(" ")}`);
  // Its own default profile starts out empty. LXD itself says when the project has to be emptied first.
  const ownProfiles = missing.includes("features.profiles=true");
  if (ownProfiles) commands.push(`lxc profile device add default root disk path=/ pool=local --project ${project}`);
  commands.push(...unsafe.map((key) => `lxc project unset ${project} ${key}`));
  return { commands, microCloudNames: ownProfiles || missing.includes("restricted.networks.uplinks=UPLINK") };
}

/** `index` numbers the server's confirmations apart from other servers'. */
async function renderConnection(connection: LxdConnection, index: number): Promise<string> {
  const disconnect = `<form method="post" action="${disconnectPath}" data-turbo="true">${serverFieldsHtml(connection)}${destructiveConfirmationHtml({
    id: `disconnect_lxd_${index}`,
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Disconnect" } },
    confirmCaption: "Disconnect LXD",
    cancelCaption: "Cancel",
  })}</form>`;
  const where = `${connection.project} project at ${connection.server.address}`;
  const lxd = new LxdServerClient(connection);
  try {
    const [server, config, untracked] = await answeredInTime(Promise.all([lxd.server(), lxd.projectConfig(connection.project), untrackedMachines(new LxdClient(connection))]));
    const limits = limitLabels.flatMap(([key, label]) => config[key] ? [label(config[key])] : []);
    const upgrade = lxdVersionKeepsSnapshots(server.version) ? "" : `<div class="managed-list__description"><span class="status-dot warning" aria-hidden="true"></span> No new machines until the server runs LXD 6.9 or later. On a snap install, run <code>snap refresh lxd --channel=6/stable</code> there.</div>`;
    const fixes = sandboxFixes(connection.project, config);
    const sandbox = fixes.commands.length ? `<div class="managed-list__description"><span class="status-dot warning" aria-hidden="true"></span> No new machines until this project keeps them apart from the rest of the network. On the LXD server, run:</div>
      <pre class="settings-command">${escapeHtml(fixes.commands.join("\n"))}</pre>${fixes.microCloudNames ? `<div class="managed-list__description">${notOnMicroCloud}</div>` : ""}` : "";
    const containersOnly = server.instanceTypes.includes("virtual-machine") ? "" : " · Containers only, as it has no /dev/kvm";
    return row(`LXD on ${server.name}`, `<div class="managed-list__description">${escapeHtml(`${where} · LXD ${server.version}${containersOnly}`)}</div>
      <div class="managed-list__description">${escapeHtml(limits.length ? `Limited to ${limits.join(", ")}` : "No project limits set")}</div>${upgrade}${sandbox}`, disconnect) + renderUntracked(connection, server.name, index, untracked);
  } catch (error) {
    return row("LXD", `<div class="managed-list__description">${escapeHtml(where)}</div>
      <div class="managed-list__description"><span class="status-dot warning" aria-hidden="true"></span> ${escapeHtml(`Can’t reach it right now: ${errorMessage(error)}`)}</div>`, disconnect);
  }
}

/** `notice` is about the servers, like what's left to clean up after disconnecting one; `connectError` about connecting one. */
async function renderMachinesSettings({ notice = "", connectError = "" }: { notice?: string; connectError?: string } = {}): Promise<string> {
  const connections = await readLxdConnections();
  const noticeHtml = notice ? `<p class="settings-error">${escapeHtml(notice)}</p>` : "";
  let body: string;
  if (!connections.length) {
    body = row("LXD", connectFormHtml("<p>Give Agents their own test machines on a server of yours, for work that needs real disks, a kernel of its own, or several machines.</p>", connectError)) + noticeHtml;
  } else {
    const servers = await Promise.all(connections.map((connection, index) => renderConnection(connection, index)));
    const another = disclosureHtml({
      summary: { kind: "compact", width: "fit", label: { kind: "text", text: "Connect another server" } },
      bodyHtml: connectFormHtml("<p>More servers make room for more machines. A workspace’s first machine goes to the server with the fewest, and the rest follow it there, so they can reach each other.</p>", connectError),
      open: Boolean(connectError),
    });
    body = servers.join("") + noticeHtml + another;
  }
  return `<section class="settings-sec settings-sec-machines" id="${sectionId}"><h2>Machines</h2>${body}</section>`;
}

async function connect(request: Request): Promise<string> {
  const token = String((await request.formData()).get("token") ?? "");
  try {
    const credentials = await createLxdClientCredentials(suggestedProject);
    const { server, project } = await joinLxdServer(token, credentials);
    try {
      await addLxdConnection({ server, project, credentials });
    } catch (error) {
      // AITC can't use the certificate it just joined with, as when that project is connected already with another one.
      await new LxdServerClient({ server, credentials }).removeOwnCertificate();
      throw error;
    }
    return await renderMachinesSettings();
  } catch (error) {
    if (error instanceof AgentsInTheCloudCoreError) return await renderMachinesSettings({ connectError: error.message });
    throw error;
  }
}

async function disconnect(request: Request): Promise<string> {
  const connection = await namedConnection(await request.formData());
  return await renderMachinesSettings({ notice: connection && await disconnectLxd(lxdLocation(connection)) });
}

async function deleteUntracked(request: Request): Promise<string> {
  const form = await request.formData();
  const connection = await namedConnection(form);
  if (!connection) return await renderMachinesSettings();
  try {
    await deleteUntrackedMachine(new LxdClient(connection), String(form.get("name") ?? ""));
  } catch (error) {
    if (error instanceof AgentsInTheCloudCoreError) return await renderMachinesSettings({ notice: error.message });
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
    if (url.pathname === disconnectPath) return turboStreamResponse(turboStream("replace", sectionId, await disconnect(request)));
    if (url.pathname === deleteUntrackedPath) return turboStreamResponse(turboStream("replace", sectionId, await deleteUntracked(request)));
    return undefined;
  },
};
