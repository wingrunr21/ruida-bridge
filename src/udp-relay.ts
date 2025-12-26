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
  private gotAck = true;
  private lastLen = 0;

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

        // Forward to LightBurn based on Python implementation rules:
        // - Always forward multi-byte responses
        // - Only forward single-byte ACKs if last packet was <= 500 bytes
        if (buf.length > 1 || this.lastLen <= 500) {
          this.callbacks.forEach((callback) => {
            callback.onLaserResponse(buf);
          });
        }

        // Handle single-byte ACK responses for internal flow control
        if (buf.length === 1) {
          const ackByte = buf[0];
          this.handleAckResponse(ackByte);
        } else {
          // Multi-byte responses also indicate ready for next packet
          this.status.debug(`Received data response: ${buf.toString("hex")}`);
          this.gotAck = true;
        }
      };

      const errorHandler = (socket: any, error: any) => {
        this.status.error(`UDP socket error: ${error}`);
      };

      // Create connected UDP socket for better performance
      // Connected sockets provide OS-level optimizations and restrict to single peer
      const socketOptions: any = {
        port: this.config.fromLaserPort, // Bind to port 40200
        binaryType: "buffer",
        connect: {
          hostname: this.config.laserIp,
          port: this.config.toLaserPort,
        },
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

  private handleAckResponse(ackByte: number): void {
    this.status.debug(`Handling ACK response: 0x${ackByte.toString(16)}`);

    // Simple flow control based on Python implementation
    // 0xC6 = success, ready for next packet
    // 0x46 = error (checksum or busy)
    // Everything else = treat as success (be lenient)

    switch (ackByte) {
      case RUIDA_PROTOCOL.ACK_SUCCESS:
        this.status.debug("ACK Success - ready for next chunk");
        this.gotAck = true;
        break;

      case RUIDA_PROTOCOL.ACK_ERROR:
        this.status.error("ACK Error - checksum error or busy");
        this.gotAck = true; // Reset to allow retry
        break;

      default:
        this.status.debug(
          `ACK byte: 0x${ackByte.toString(16)} - treating as success`,
        );
        this.gotAck = true;
        break;
    }
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

    // Pure passthrough - LightBurn has already formatted the packet
    // No swizzling, no checksum calculation, no transformations
    this.status.debug(
      `Sending UDP packet: ${packetData.length} bytes to ${this.config.laserIp}:${this.config.toLaserPort}`,
    );
    this.status.debug(`Packet data: ${packetData.toString("hex")}`);

    // Connected socket - no need to specify destination
    const bytesSent = this.socket.send(packetData);
    if (bytesSent < 0) {
      this.status.error(`UDP send failed: ${bytesSent} bytes`);
      return;
    }

    // Track packet length for ACK forwarding logic
    this.lastLen = packetData.length;

    // Mark that we're waiting for ACK
    this.gotAck = false;
  }
}
