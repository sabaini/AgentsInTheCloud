import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentsInTheCloudCoreError, runCommand } from "@agents-in-the-cloud/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { LxdRequestError, LxdServerClient } from "./client.ts";
import { certificateFingerprint, connectLxd, type LxdClientCredentials, type LxdServer } from "./tls.ts";

export interface LxdTrustToken {
  /** The token exactly as issued; LXD expects all of it back, not just its secret. */
  token: string;
  clientName: string;
  fingerprint: string;
  addresses: string[];
  expiresAt: Date;
}

const tokenSchema = Type.Object({
  client_name: Type.String(),
  fingerprint: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  addresses: Type.Array(Type.String()),
  secret: Type.String({ minLength: 1 }),
  expires_at: Type.String(),
});

function invalidToken(): AgentsInTheCloudCoreError {
  return new AgentsInTheCloudCoreError("invalid_lxd_trust_token", "That doesn't look like an LXD trust token. Paste the whole last line that lxc config trust add printed.");
}

export function parseLxdTrustToken(input: string, now = new Date()): LxdTrustToken {
  const token = input.trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    throw invalidToken();
  }
  if (!Value.Check(tokenSchema, decoded)) throw invalidToken();
  const expiresAt = new Date(decoded.expires_at);
  if (Number.isNaN(expiresAt.getTime())) throw invalidToken();
  if (expiresAt <= now) throw new AgentsInTheCloudCoreError("expired_lxd_trust_token", "This LXD trust token has expired. Create a new one.");
  if (!decoded.addresses.length) throw new AgentsInTheCloudCoreError("lxd_not_listening", "This LXD server isn't listening on the network yet. Run lxc config set core.https_address :8443 on it, then create a new token.");
  return { token, clientName: decoded.client_name, fingerprint: decoded.fingerprint, addresses: decoded.addresses, expiresAt };
}

/** A new key pair and self-signed client certificate for AITC, like the one `lxc` makes for itself. */
export async function createLxdClientCredentials(commonName: string): Promise<LxdClientCredentials> {
  const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-lxd-"));
  try {
    const certificatePath = join(directory, "client.crt");
    const keyPath = join(directory, "client.key");
    const { exitCode, stderr } = await runCommand([
      "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:secp384r1", "-sha384", "-nodes", "-days", "3650",
      "-subj", `/CN=${commonName}`, "-addext", "extendedKeyUsage=clientAuth", "-keyout", keyPath, "-out", certificatePath,
    ]);
    if (exitCode !== 0) throw new AgentsInTheCloudCoreError("lxd_credentials_failed", stderr.trim() || "openssl could not create an LXD client certificate");
    return { certificate: await readFile(certificatePath, "utf8"), privateKey: await readFile(keyPath, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface LxdJoin {
  server: LxdServer;
  /** The one project the token's restricted certificate may use. */
  project: string;
}

/**
 * Trust AITC's certificate on the server that issued `input`. The token lists every
 * address of that server; the first one reachable with the token's certificate
 * fingerprint is pinned. AITC only accepts tokens restricted to a single project.
 */
export async function joinLxdServer(input: string, credentials: LxdClientCredentials): Promise<LxdJoin> {
  const token = parseLxdTrustToken(input);
  const probes = await Promise.allSettled(token.addresses.map(async (address) => {
    const { socket, certificate } = await connectLxd(address, undefined, 5_000);
    socket.destroy();
    if (certificateFingerprint(certificate) !== token.fingerprint) throw new Error("presented a different certificate than the token names");
    return { address, certificate };
  }));
  const reached = probes.find(probe => probe.status === "fulfilled");
  if (!reached) {
    const reasons = probes.flatMap((probe, index) => probe.status === "rejected" ? [`${token.addresses[index]}: ${probe.reason.message}`] : []);
    throw new AgentsInTheCloudCoreError("lxd_unreachable", `Couldn't reach the LXD server that issued this token (${reasons.join("; ")})`);
  }
  const server = reached.value;
  const lxd = new LxdServerClient({ server, credentials });
  try {
    await lxd.addCertificate(token.token);
  } catch (error) {
    // LXD answers every unusable token the same way; tokens work once.
    if (error instanceof LxdRequestError && error.status === 403) throw new AgentsInTheCloudCoreError("lxd_token_rejected", "LXD didn't accept this token. Each token works only once, so create a new one.");
    throw error;
  }
  const { restricted, projects } = await lxd.ownCertificate();
  if (!restricted || projects.length !== 1) {
    await lxd.removeOwnCertificate();
    throw new AgentsInTheCloudCoreError("lxd_token_not_restricted", "This token isn't limited to a single project. Create one with --restricted --projects <project>, so AgentsInTheCloud can only use that project.");
  }
  return { server, project: projects[0]! };
}
