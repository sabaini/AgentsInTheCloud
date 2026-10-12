# Machines

Some work doesn't fit in a workspace container: installing snaps, formatting real disks, loading kernel modules, or forming a cluster out of several machines. **Machines** gives your Agents fresh virtual machines and containers on an LXD server of yours for exactly that. They create them when they need them, reach them with `ssh`, and release them when they're done.

You set this up once:

1. Connect an LXD server in **Settings › Machines**.
2. Add machine profiles to a workspace template, so its workspaces know what machines they may create.

## Connect an LXD server

Machines run on a server of yours, with LXD and OVN. AgentsInTheCloud gets a project of its own there and can't touch anything else on the server. It reaches the server on port 8443, so that port needs to be reachable from AgentsInTheCloud.

Open **Settings › Machines**. It shows two ways to get a trust token from the server, depending on where you start.

### A fresh Ubuntu server

One command sets up everything. Settings shows it with your AgentsInTheCloud's address filled in:

```sh
curl -fsSL http://<AgentsInTheCloud>/settings/machines/setup-lxd-host.sh | sudo bash
```

It installs LXD 6 and MicroOVN, then makes:

- a ZFS storage pool called `local`, in a file that takes half the free space on the root disk,
- a NAT bridge called `aitc-uplink`, which machines reach the internet through, so one network port on the server is enough,
- the `agents-in-the-cloud` project,
- and a trust token, which it prints at the end.

To put machines on a disk of their own, name it: add `-s -- --disk /dev/nvme1n1` after `sudo bash`. **Everything on that disk is erased.** Or set the file's size with `--size 200GiB`.

Running it again is safe. It keeps what's already there and prints a new token.

Virtual machines need hardware virtualization on the server, which shows up as `/dev/kvm`. Without it, only containers work.

If you open AgentsInTheCloud at a `localhost` address, the server can't fetch the script from there. Settings then offers it as a download instead: copy it to the server and run `sudo bash setup-lxd-host.sh`.

### A server with LXD and OVN already

On a [MicroCloud](https://canonical.com/microcloud), or any server with LXD 6.9 or later and OVN, run these instead:

```sh
lxc project create agents-in-the-cloud \
  -c features.profiles=true -c features.networks=true \
  -c restricted=true -c restricted.snapshots=allow \
  -c restricted.networks.uplinks=UPLINK
lxc profile device add default root disk path=/ \
  pool=local --project agents-in-the-cloud
lxc config trust add --name agents-in-the-cloud \
  --restricted --projects agents-in-the-cloud
```

On a MicroCloud, run them as they are. Elsewhere, put your OVN uplink network in place of `UPLINK` and your storage pool in place of `local`. The last command prints the trust token.

### Connect

Paste the token into Settings and select **Connect**. Settings then shows the server, its LXD version and any limits you've set on the project.

To cap how much your Agents can use in total, set limits on the project, for example:

```sh
lxc project set agents-in-the-cloud limits.instances=10
```

**Disconnect** in Settings forgets the server and removes AgentsInTheCloud's certificate there. Machines that already exist stay on the server. Connect the same server and project again to use or release them.

## Add machine profiles to a template

A machine profile describes one kind of machine your Agents may create. Profiles belong to a workspace template, so different repositories can get different machines. Open the template's settings and go to **Machines**:

| Setting | What it does |
| --- | --- |
| **Name** | What Agents ask for, like `node`. Machines are named after it, `node-1`, `node-2` and so on, unless your Agent picks a name. |
| **Image** | `ubuntu:24.04` by default. Images from `ubuntu-daily:` and `images:` work too, and so does the alias of an image already on the LXD server. The image needs cloud-init and openssh-server, which Ubuntu's images have. |
| **Type** | **Virtual machine** gets its own kernel and can have extra disks. **Container** starts faster and shares the server's kernel. |
| **CPUs** and **Memory (GiB)** | 2 CPUs and 2 GiB unless you change them. |
| **Extra disks (GiB)** | Empty block devices, one per size: one 4 GiB disk unless you change it. `20, 20, 20` gives three disks, for example for Ceph OSDs. Containers can't have them, so clear the field for a container. |
| **LXD profiles** | The profiles on the LXD server that machines are made with, `default` to start with. The root disk comes from them. |
| **Delete after (hours)** | How long a machine lasts: 24 hours unless you change it, and up to 30 days. It's deleted after that, with its disks and snapshots. |

**Machines per workspace** sets how many machines one workspace can have at once, 10 unless you change it.

Changes apply to machines created afterwards. Machines that already exist keep what they were created with.

Machines always use their workspace's own network. An LXD profile that adds another network device is refused, since that could connect machines to more than their workspace.

## Work with machines

Ask your Agent in plain words, like "Make three nodes and set up a Ceph cluster on their extra disks", and it picks the right tools:

| Tool | What it does |
| --- | --- |
| `acquire_machine` | Creates a machine from a profile and waits until it has booted. |
| `list_machines` | Lists the workspace's machines and the profiles it can create more from. |
| `wait_for_machine` | Waits for a machine that's still booting. |
| `snapshot_machines` | Saves a snapshot of one or more machines. |
| `restore_machines` | Puts one or more machines back to a snapshot. |
| `release_machine` | Deletes a machine, with its disks and snapshots. |

Once a machine is up, `ssh node-1` reaches it from the workspace as the `ubuntu` user, with passwordless sudo. `scp`, `rsync`, Ansible and Juju work with the name too. This works from the workspace's terminals as well as the Agent's.

The first virtual machine from an image takes a few minutes, while the LXD server downloads the image. Later ones are quicker.

### The Machines view

Open **Machines** from the Work-view launcher to see the workspace's machines: what each one is, how long it has left, and whether it's ready. From there you can:

- **Open terminal** to get a shell on a machine.
- **Release** a machine you no longer need.

The view only shows up in workspaces whose template has machine profiles, or that still have machines.

### Machines talking to each other

A workspace's machines share a network, where they can reach each other and the public internet, and nothing else. They can't reach your local network or other workspaces' machines.

Machines know each other by a longer name than the one you `ssh` to, like `node-1-3f9a2c1b.lxd`. `list_machines` tells your Agent each machine's name and addresses on that network.

### Snapshots

Snapshots let your Agent go back to a known-good state between experiments, like before an upgrade it wants to try twice.

- **Machines shut down for a snapshot and for a restore.** They start again right after, but anything that was only in memory is gone.
- **Machines that work together are snapshotted together.** Your Agent passes all of a cluster's nodes in one call, so they shut down together and the snapshot holds the same moment for all of them. Restoring works the same way.
- **Snapshots last as long as the machine.** Releasing a machine deletes its snapshots too.

## When machines go away

- **They reach their time limit.** A machine is deleted, with its disks and snapshots, once its profile's **Delete after** time is up. The Machines view shows how long each one has left.
- **Someone releases them.** Your Agent with `release_machine`, or you with **Release** in the Machines view.
- **You delete the workspace.** The confirmation lists its machines, and they're deleted with it.

Parking a workspace doesn't delete its machines. It shuts them down, and they start again the next time they're used: by `ssh`, by your Agent listing them, or by **Open terminal**.

If you delete a workspace while its LXD server isn't connected, its machines stay on the server. Once you connect it again, Settings lists them under machines that don't belong to a workspace anymore, with a **Delete** button for each.

## When something's wrong

**"No new machines until the server runs LXD 6.9 or later."** Upgrade LXD on the server. On a snap install, run `snap refresh lxd --channel=6/stable`.

**"No new machines until this project keeps them apart from the rest of the network."** The project is missing a setting that keeps machines sandboxed, or has one that would give them the LXD server. Settings shows the commands that fix it. Some settings can only be changed while the project is empty. If LXD says so, start over with a new project: **Disconnect**, run the commands above with another project name, and connect that one.

**A machine "didn't finish booting".** Its image probably lacks cloud-init or openssh-server. Try an Ubuntu image.

**A machine is "Stopped, as restoring it didn't finish".** Its disks may be from different points in time. Ask your Agent to restore it again, or release it.

**A machine is "Gone from the LXD server".** Someone deleted it there. Release it to clear it from the workspace.

**"This workspace is older than machines in AgentsInTheCloud."** Its `ssh` can't reach machines. Create a new workspace from the same template.
