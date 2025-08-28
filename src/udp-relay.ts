import type { ConnectionConfig } from "./connection-handler.ts";
import type { Status } from "./types.ts";
import { RUIDA_PROTOCOL } from "./connection-handler.ts";

export interface UdpRelayCallbacks {
  onLaserResponse: (data: Buffer) => void;
}

export class UdpRelay {
  private config: ConnectionConfig;
  private status: Status;
  private socket: any = null;
  private callbacks: Set<UdpRelayCallbacks> = new Set();
  private isStarted = false;
  private ackValue = Buffer.alloc(0);
  private gotAck = true;

  constructor(config: ConnectionConfig, status: Status) {
    this.config = config;
    this.status = status;
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }
    try {
      const dataHandler = (sock: any, buf: any, _port: any, _addr: any) => {
        this.status.debug(
          `Received UDP response: ${buf.length} bytes from laser`,
        );
        this.status.debug(`Response data: ${buf.toString("hex")}`);

        // Handle ACK tracking - check first byte even if packet is padded
        if (buf.length >= 1) {
          if (this.ackValue.length === 0) {
            // First ACK received, store it
            this.ackValue = buf;
            this.gotAck = true;
          } else if (this.ackValue[0] !== buf[0]) {
            // Different ACK value received
            this.status.warn(
              `Non-ack received: expected ${this.ackValue[0]?.toString(16)}, got ${buf[0]?.toString(16)}`,
            );
            this.ackValue = buf;
            this.gotAck = true;
          } else {
            // Same ACK as before, don't change gotAck state
            this.status.debug(
              `Duplicate ACK received: ${buf[0]?.toString(16)}`,
            );
          }
        }

        // Forward to all registered callbacks
        this.callbacks.forEach((callback) => {
          callback.onLaserResponse(buf);
        });
      };

      const errorHandler = (socket: any, error: any) => {
        this.status.error(`UDP socket error: ${error}`);
      };

      // Create single UDP socket for both sending and receiving
      const socketOptions: any = {
        port: this.config.fromLaserPort, // Bind to port 40200
        binaryType: "buffer",
        socket: {
          data: dataHandler,
          error: errorHandler,
        },
      };

      if (this.config.bridgeHost) {
        socketOptions.hostname = this.config.bridgeHost;
      }

      this.socket = await Bun.udpSocket(socketOptions);
      this.status.debug(
        `Created UDP socket on port ${this.config.fromLaserPort}${this.config.bridgeHost ? ` bound to ${this.config.bridgeHost}` : ""}`,
      );
      this.status.debug(
        `Bridge will send packets to laser at ${this.config.laserIp}:${this.config.toLaserPort}`,
      );

      this.isStarted = true;
      this.status.ok("UDP relay started");
    } catch (error) {
      this.status.error(`Failed to start UDP relay: ${error}`);
      throw error;
    }
  }

  stop(): void {
    if (!this.isStarted) {
      return;
    }

    try {
      if (this.socket) {
        this.socket.close();
        this.socket = null;
      }

      this.callbacks.clear();
      this.isStarted = false;
      this.status.info("UDP relay stopped");
    } catch (error) {
      this.status.error(`Error stopping UDP relay: ${error}`);
    }
  }

  registerCallback(callback: UdpRelayCallbacks): void {
    this.callbacks.add(callback);
  }

  unregisterCallback(callback: UdpRelayCallbacks): void {
    this.callbacks.delete(callback);
  }

  private swizzleByte(b: number, magic: number = 0x88): number {
    b ^= (b >> 7) & 0xff;
    b ^= (b << 7) & 0xff;
    b ^= (b >> 7) & 0xff;
    b ^= magic;
    b = (b + 1) & 0xff;
    return b;
  }

  private encodeBytes(data: Buffer, magic: number = 0x88): Buffer {
    const encoded = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
      encoded[i] = this.swizzleByte(data[i] ?? 0, magic);
    }
    return encoded;
  }

  sendToLaser(packetData: Buffer): void {
    if (!this.isStarted || !this.socket) {
      this.status.error("UDP relay not started, cannot send packet");
      return;
    }

    if (!this.gotAck) {
      this.status.warn(
        "Cannot send packet, waiting for ACK from previous packet",
      );
      return;
    }

    // Encode bytes using Ruida protocol scrambling
    const encodedData = this.encodeBytes(packetData);

    // Calculate checksum for UDP packet (sum of encoded bytes, MSB first)
    let checksum = 0;
    for (const byte of encodedData) {
      checksum += byte;
    }
    checksum = checksum & 0xffff; // Keep it 16-bit

    // Create UDP packet with 2-byte checksum header
    const checksumHeader = Buffer.from([
      (checksum >> 8) & 0xff, // MSB first
      checksum & 0xff,
    ]);
    const udpPacket = Buffer.concat([checksumHeader, encodedData]);

    // Enforce maximum UDP packet size
    const MAX_UDP_SIZE = RUIDA_PROTOCOL.MAX_UDP_SIZE;
    if (udpPacket.length <= MAX_UDP_SIZE) {
      // Send as single packet
      this.status.debug(
        `Sending UDP packet: ${udpPacket.length} bytes to ${this.config.laserIp}:${this.config.toLaserPort}`,
      );
      this.status.debug(`Packet data: ${udpPacket.toString("hex")}`);

      this.socket.send(udpPacket, this.config.toLaserPort, this.config.laserIp);

      // Mark that we're waiting for ACK
      this.gotAck = false;
    } else {
      // For fragmented packets, we should implement proper ACK waiting
      // For now, log a warning and send the first fragment only
      this.status.warn(
        `Large packet fragmentation not fully implemented: ${udpPacket.length} bytes`,
      );

      const firstFragment = udpPacket.subarray(0, MAX_UDP_SIZE);
      this.status.debug(
        `Sending first fragment: ${firstFragment.length} bytes to ${this.config.laserIp}:${this.config.toLaserPort}`,
      );
      this.status.debug(`Fragment data: ${firstFragment.toString("hex")}`);

      this.socket.send(
        firstFragment,
        this.config.toLaserPort,
        this.config.laserIp,
      );

      // Mark that we're waiting for ACK
      this.gotAck = false;
    }
  }
}
