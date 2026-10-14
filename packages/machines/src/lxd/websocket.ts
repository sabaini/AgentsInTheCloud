import { createHash, randomBytes } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { connectPinnedLxd, type LxdTlsIdentity } from "./tls.ts";

const acceptGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const opcode = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

function failure(message: string): AgentsInTheCloudCoreError {
  return new AgentsInTheCloudCoreError("lxd_websocket_failed", message);
}

/** Client frames must be masked (RFC 6455 section 5.3). */
function encodeFrame(code: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  const header = Buffer.alloc(length < 126 ? 2 : length < 0x10000 ? 4 : 10);
  header[0] = 0x80 | code;
  if (length < 126) header[1] = 0x80 | length;
  else if (length < 0x10000) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index++) masked[index] = payload[index]! ^ mask[index & 3]!;
  return Buffer.concat([header, mask, masked]);
}

/**
 * A minimal binary WebSocket client for LXD operation streams over a pinned TLS socket.
 * Messages have a single consumer; a client that never reads them (exec stdin) only sends.
 */
export class LxdWebSocket {
  private buffered: Buffer;
  private closeSent = false;
  /** LXD pings a stream it's done with just before it drops the connection, and the pong may then take the socket down. */
  private lastWasPing = false;

  private constructor(private readonly socket: TLSSocket, private readonly chunks: AsyncIterator<Buffer>, rest: Buffer) {
    this.buffered = rest;
    // Reads and writes report their own failures; without a listener the same error would also crash the process.
    socket.on("error", () => {});
  }

  /** `url` is on the server `identity` names, which it may give without its port. */
  static async connect(identity: LxdTlsIdentity, url: URL): Promise<LxdWebSocket> {
    const socket = await connectPinnedLxd(identity);
    const key = randomBytes(16).toString("base64");
    socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const chunks: AsyncIterator<Buffer> = socket[Symbol.asyncIterator]();
    let buffered = Buffer.alloc(0);
    let end = -1;
    while ((end = buffered.indexOf("\r\n\r\n")) < 0) {
      const next = await chunks.next();
      if (next.done) throw failure(`${url.pathname}: connection closed during the WebSocket handshake`);
      buffered = Buffer.concat([buffered, next.value]);
    }
    const [status, ...headers] = buffered.subarray(0, end).toString("latin1").split("\r\n");
    if (!/^HTTP\/1\.1 101 /.test(status!)) {
      socket.destroy();
      throw failure(`${url.pathname}: LXD refused the WebSocket (${status})`);
    }
    const accept = createHash("sha1").update(key + acceptGuid).digest("base64");
    if (!headers.some(header => /^sec-websocket-accept:/i.test(header) && header.slice(header.indexOf(":") + 1).trim() === accept)) {
      socket.destroy();
      throw failure(`${url.pathname}: invalid WebSocket handshake response`);
    }
    return new LxdWebSocket(socket, chunks, buffered.subarray(end + 4));
  }

  private async fill(length: number): Promise<boolean> {
    while (this.buffered.length < length) {
      let next: IteratorResult<Buffer>;
      try {
        next = await this.chunks.next();
      } catch (error) {
        // Only right after a ping is a dropped connection the end of the stream.
        if (this.lastWasPing) return false;
        throw error;
      }
      if (next.done) return false;
      this.buffered = Buffer.concat([this.buffered, next.value]);
    }
    return true;
  }

  private async readFrame(): Promise<{ fin: boolean; code: number; payload: Buffer } | undefined> {
    if (!await this.fill(2)) {
      if (this.buffered.length) throw failure("connection closed inside a WebSocket frame");
      return undefined;
    }
    const fin = (this.buffered[0]! & 0x80) !== 0;
    const code = this.buffered[0]! & 0x0f;
    const masked = (this.buffered[1]! & 0x80) !== 0;
    let length = this.buffered[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (!await this.fill(4)) throw failure("connection closed inside a WebSocket frame");
      length = this.buffered.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (!await this.fill(10)) throw failure("connection closed inside a WebSocket frame");
      length = Number(this.buffered.readBigUInt64BE(2));
      offset = 10;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (!await this.fill(offset + length)) throw failure("connection closed inside a WebSocket frame");
    const payload = Buffer.from(this.buffered.subarray(offset, offset + length));
    if (masked) for (let index = 0; index < length; index++) payload[index]! ^= this.buffered[maskOffset + (index & 3)]!;
    this.buffered = this.buffered.subarray(offset + length);
    return { fin, code, payload };
  }

  /** Resolves once the frame is flushed; a closed or dropped connection rejects instead of leaving it waiting. */
  private async write(frame: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => this.socket.write(frame, error => error ? reject(error) : resolve()));
  }

  /**
   * Pongs and close replies don't wait: LXD may have dropped the connection already, as it does when a command can't
   * start or a stream is done, and then nobody is left to answer. A reply that fails then ends the reading too.
   */
  private answer(frame: Buffer): void {
    if (!this.socket.readableEnded) this.socket.write(frame);
  }

  /** Data and text messages, in order, until the server closes the stream. A reader that stops early releases it. */
  async *messages(): AsyncGenerator<Buffer> {
    let fragments: Buffer[] = [];
    try {
      for (let frame = await this.readFrame(); frame; frame = await this.readFrame()) {
        this.lastWasPing = frame.code === opcode.ping;
        if (frame.code === opcode.ping) this.answer(encodeFrame(opcode.pong, frame.payload));
        else if (frame.code === opcode.close) {
          this.close();
          return;
        } else if (frame.code === opcode.text || frame.code === opcode.binary || frame.code === opcode.continuation) {
          fragments.push(frame.payload);
          if (frame.fin) {
            yield Buffer.concat(fragments);
            fragments = [];
          }
        } else if (frame.code !== opcode.pong) throw failure(`unexpected WebSocket opcode ${frame.code}`);
      }
    } finally {
      // A close reply is still on its way out.
      if (!this.closeSent) this.destroy();
    }
  }

  async send(data: Uint8Array): Promise<void> {
    await this.write(encodeFrame(opcode.binary, data));
  }

  /** For exec stdin this is end-of-file. Like a pong it doesn't wait: the command may have exited and taken the stream with it. */
  close(): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const status = Buffer.alloc(2);
    status.writeUInt16BE(1000);
    this.answer(encodeFrame(opcode.close, status));
    this.socket.end();
  }

  /** Release the connection, as for exec stdin once its operation has finished. */
  destroy(): void {
    this.socket.destroy();
  }
}
