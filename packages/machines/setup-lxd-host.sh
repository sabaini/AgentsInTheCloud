#!/usr/bin/env bash
# Turns a fresh Ubuntu machine into an LXD server for AgentsInTheCloud's machines: LXD 6 and MicroOVN from snaps, a ZFS
# pool, a NAT bridge that's the uplink for OVN networks, and a sandboxed project with a trust token for it. Running it
# again keeps what's there and prints a new token.
#
#   curl -fsSL https://raw.githubusercontent.com/sabaini/AgentsInTheCloud/machines-ovn/packages/machines/setup-lxd-host.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/sabaini/AgentsInTheCloud/machines-ovn/packages/machines/setup-lxd-host.sh | sudo bash -s -- --disk /dev/nvme1n1
set -Eeuo pipefail

project=agents-in-the-cloud
pool=local
uplink=aitc-uplink
listen="[::]:8443"
pki=/var/snap/microovn/common/data/pki
ovn_env=/var/snap/microovn/common/data/env/ovn.env

usage() {
  cat <<'EOF'
Usage: setup-lxd-host.sh [--disk DEVICE | --size SIZE]

  --disk DEVICE  Put machines on this whole disk, like /dev/nvme1n1. Everything on it is erased.
  --size SIZE    Put machines in a file of this size on the root disk, like 200GiB.
                 Without either, the file gets half the free space there.
EOF
}

say() { printf '==> %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Like 6.9 or 5.21.3, from `snap list`.
lxd_version() { snap list lxd | awk 'NR == 2 { split($2, v, "-"); print v[1] }'; }
keeps_snapshots() {
  local major=${1%%.*} rest=${1#*.}
  local minor=${rest%%.*}
  [ "$major" -gt 6 ] || { [ "$major" -eq 6 ] && [ "$minor" -ge 9 ]; }
}

install_lxd() {
  if ! snap list lxd >/dev/null 2>&1; then
    say "Installing LXD"
    snap install lxd --channel=6/stable
  elif ! keeps_snapshots "$(lxd_version)"; then
    # Ubuntu installs an older LXD on some machines; one that has never been used can move to 6 safely.
    if [ -n "$(lxc storage list -f csv)" ] || [ -n "$(lxc list --all-projects -f csv -c n)" ]; then
      fail "LXD $(lxd_version) is already in use here, and machines need 6.9 or later. Run snap refresh lxd --channel=6/stable when you're ready, then run this again."
    fi
    say "Moving the unused LXD $(lxd_version) to LXD 6"
    snap refresh lxd --channel=6/stable
  fi
  lxd waitready --timeout=300
  # On its first run, the client suggests lxd init, which this script takes the place of.
  lxc query /1.0 >/dev/null 2>&1
}

install_microovn() {
  if ! snap list microovn >/dev/null 2>&1; then
    say "Installing MicroOVN"
    snap install microovn --channel=24.03/stable
  fi
  if ! microovn cluster list >/dev/null 2>&1; then
    say "Starting OVN"
    microovn cluster bootstrap
  fi
  if ! snap connections lxd | grep -q "microovn:ovn-chassis"; then
    say "Letting LXD use OVN"
    snap connect lxd:ovn-chassis microovn:ovn-chassis
    snap restart lxd
    lxd waitready --timeout=300
  fi
  if [ -z "$(lxc config get network.ovn.northbound_connection)" ]; then
    # MicroOVN writes down where OVN's northbound database is, like ssl:10.0.0.5:6641.
    local northbound
    northbound=$(sed -n 's/^OVN_NB_CONNECT="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$ovn_env")
    [ -n "$northbound" ] || fail "MicroOVN didn't say where OVN listens. Look for OVN_NB_CONNECT in $ovn_env."
    lxc config set network.ovn.northbound_connection="$northbound" \
      network.ovn.ca_cert="$(cat "$pki/cacert.pem")" \
      network.ovn.client_cert="$(cat "$pki/client-cert.pem")" \
      network.ovn.client_key="$(cat "$pki/client-privkey.pem")"
  fi
}

configure_lxd() {
  [ -n "$(lxc config get core.https_address)" ] || lxc config set core.https_address="$listen"
  if ! lxc storage show "$pool" >/dev/null 2>&1; then
    if [ -n "$disk" ]; then
      say "Making storage pool $pool on $disk"
      lxc storage create "$pool" zfs source="$disk"
    else
      if [ -z "$size" ]; then
        local free
        free=$(df --output=avail -BG /var/snap/lxd/common | awk 'NR == 2 { print int($1) }')
        [ "$free" -ge 40 ] || fail "There's only ${free} GiB free on the root disk. Give machines a disk of their own with --disk, or a smaller file with --size."
        size="$((free / 2))GiB"
      fi
      say "Making storage pool $pool, $size"
      lxc storage create "$pool" zfs size="$size"
    fi
  fi
  if ! lxc network show "$uplink" >/dev/null 2>&1; then
    say "Making network $uplink, the uplink for machine networks"
    # It keeps IPv6, though machine networks have none: without it, LXD 6.9 fails to parse the uplink when it checks a
    # network forward, before it gets to refusing one.
    lxc network create "$uplink" ipv4.address=auto ipv4.nat=true
  fi
  # Each step is checked on its own, so a run that stopped halfway is finished by the next.
  if [ -z "$(lxc network get "$uplink" ipv4.ovn.ranges)" ]; then
    local prefix
    prefix=$(lxc network get "$uplink" ipv4.address | cut -d. -f1-3)
    # Each workspace's network takes one address from the OVN range.
    lxc network set "$uplink" ipv4.dhcp.ranges="$prefix.2-$prefix.99" ipv4.ovn.ranges="$prefix.100-$prefix.254"
  fi
  # As lxd init would, so instances outside AgentsInTheCloud's project get a disk and a network too.
  lxc profile device get default root pool >/dev/null 2>&1 || lxc profile device add default root disk path=/ pool="$pool"
  lxc profile device get default eth0 network >/dev/null 2>&1 || lxc profile device add default eth0 nic network="$uplink" name=eth0
  if ! lxc project show "$project" >/dev/null 2>&1; then
    say "Making project $project"
    lxc project create "$project" \
      -c features.profiles=true -c features.networks=true \
      -c restricted=true -c restricted.snapshots=allow \
      -c restricted.networks.uplinks="$uplink"
  fi
  lxc profile device get default root pool --project "$project" >/dev/null 2>&1 || lxc profile device add default root disk path=/ pool="$pool" --project "$project"
}

new_token() {
  # A token from an earlier run that was never used.
  if lxc config trust list-tokens -f csv | grep -q "^$project,"; then lxc config trust revoke-token "$project" >/dev/null; fi
  lxc config trust add --name "$project" --restricted --projects "$project" --quiet
}

main() {
  disk="" size=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --disk) disk=${2:?--disk needs a device}; shift 2 ;;
      --size) size=${2:?--size needs a size, like 200GiB}; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; exit 2 ;;
    esac
  done
  [ -z "$disk" ] || [ -z "$size" ] || fail "Use --disk or --size, not both."
  [ -z "$disk" ] || [ -b "$disk" ] || fail "$disk isn't a disk."
  [ "$(id -u)" -eq 0 ] || fail "Run this as root, for example with sudo."
  command -v snap >/dev/null || fail "This needs snapd, which Ubuntu comes with."
  export PATH=/snap/bin:$PATH
  ! snap list microcloud >/dev/null 2>&1 || fail "This is a MicroCloud, which has LXD and OVN already. Use the commands in AgentsInTheCloud's Settings, under Machines, instead."
  [ -e /dev/kvm ] || say "There's no /dev/kvm, so this server can run containers but not virtual machines."

  install_lxd
  install_microovn
  configure_lxd
  local token
  token=$(new_token)
  cat <<EOF

LXD $(lxd_version) with OVN is ready. In AgentsInTheCloud, open Settings, go to Machines, and paste this token:

$token

EOF
}

# Reading the whole script first, and keeping stdin from commands, makes `curl … | bash` safe.
main "$@" < /dev/null
