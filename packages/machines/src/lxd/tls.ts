import { createHash, X509Certificate } from "node:crypto";
import { connect, type TLSSocket } from "node:tls";
import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";

/** AITC's own client certificate, trusted by LXD through a trust token. */
export interface LxdClientCredentials {
  certificate: string;
  privateKey: string;
}

/** An LXD API endpoint and the exact server certificate AITC pinned when joining it. */
export interface LxdServer {
  /** `host:port`, with IPv6 hosts in brackets, as LXD lists them in trust tokens. */
  address: string;
  certificate: string;
}

export interface LxdTlsIdentity {
  server: LxdServer;
  credentials: LxdClientCredentials;
}

export function certificateFingerprint(certificate: string | Buffer): string {
  return createHash("sha256").update(new X509Certificate(certificate).raw).digest("hex");
}

/**
 * LXD server certificates are self-signed leaves whose names rarely include the
 * address AITC uses. Trusting exactly that certificate as a partial chain pins the
 * server, so hostname verification adds nothing and is skipped.
 */
export function lxdFetchTls(identity: LxdTlsIdentity): BunFetchRequestInitTLS & { allowPartialTrustChain: boolean } {
  return {
    cert: identity.credentials.certificate,
    key: identity.credentials.privateKey,
    ca: identity.server.certificate,
    allowPartialTrustChain: true,
    checkServerIdentity: () => undefined,
  };
}

function endpoint(address: string) {
  const url = new URL(`https://${address}`);
  return { host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(url.port || 8443) };
}

/** Open a TLS connection and return it with the certificate the server presented. */
export function connectLxd(address: string, credentials?: LxdClientCredentials, timeoutMs = 10_000): Promise<{ socket: TLSSocket; certificate: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ ...endpoint(address), cert: credentials?.certificate, key: credentials?.privateKey, rejectUnauthorized: false }, () => {
      socket.setTimeout(0);
      resolve({ socket, certificate: new X509Certificate(socket.getPeerCertificate().raw).toString() });
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new AgentsInTheCloudCoreError("lxd_unreachable", `Timed out connecting to ${address}`)));
    socket.once("error", reject);
  });
}

/** Bun's WebSocket cannot skip hostname verification, so exec streams use sockets pinned here. */
export async function connectPinnedLxd(identity: LxdTlsIdentity, address = identity.server.address): Promise<TLSSocket> {
  const { socket, certificate } = await connectLxd(address, identity.credentials);
  if (certificateFingerprint(certificate) !== certificateFingerprint(identity.server.certificate)) {
    socket.destroy();
    throw new AgentsInTheCloudCoreError("lxd_certificate_mismatch", `${address} presented a different certificate than the LXD server AITC joined`);
  }
  return socket;
}
