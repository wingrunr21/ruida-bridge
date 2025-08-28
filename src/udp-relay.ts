import type { ConnectionConfig } from "./connection-handler.ts";
import type { Status } from "./types.ts";
import { RUIDA_PROTOCOL } from "./connection-handler.ts";

export interface UdpRelayCallbacks {
  onLaserResponse: (data: Buffer) => void;
}

export class UdpRelay {
  private config: ConnectionConfig;
  private status: Status;
  private outSocket: any = null;
  private inSocket: any = null;
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
    const logger = this.status;
    try {
      // Create UDP socket for outgoing (to laser)
      const outSocketOptions: any = {
        socket: {
          data(_socket: any, _buf: any, _port: any, _addr: any) {
            // Not used for outgoing socket
          },
          error(socket: any, error: any) {
            logger.error(`UDP out socket error: ${error}`);
          },
        },
      };

      if (this.config.bridgeHost) {
        outSocketOptions.hostname = this.config.bridgeHost;
      }

      this.outSocket = await Bun.udpSocket(outSocketOptions);
      this.status.debug(
        `Created outgoing UDP socket${this.config.bridgeHost ? ` bound to ${this.config.bridgeHost}` : ""}`,
      );

      // Create UDP socket for incoming (from laser)
      const socketOptions: any = {
        port: this.config.fromLaserPort,
        socket: {
          data: (inSock: any, buf: any, _port: any, _addr: any) => {
            const data = Buffer.from(buf);
            this.status.debug(
              `Received UDP response: ${data.length} bytes from laser`,
            );
            this.status.debug(`Response data: ${data.toString("hex")}`);

            // Handle ACK tracking for single-byte responses
            if (data.length === 1) {
              if (this.ackValue.length === 0) {
                // First ACK received, store it
                this.ackValue = data;
                this.gotAck = true;
              } else if (this.ackValue[0] !== data[0]) {
                // Different ACK value received
                this.status.warn(
                  `Non-ack received: expected ${this.ackValue[0].toString(16)}, got ${data[0].toString(16)}`,
                );
                this.ackValue = data;
                this.gotAck = true;
              } else {
                // Same ACK as before, don't change gotAck state
                this.status.debug(
                  `Duplicate ACK received: ${data[0].toString(16)}`,
                );
              }
            }

            // Forward to all registered callbacks
            this.callbacks.forEach((callback) => {
              callback.onLaserResponse(data);
            });
          },
          error: (socket: any, error: any) => {
            this.status.error(`UDP in socket error: ${error}`);
          },
        },
      };

      if (this.config.bridgeHost) {
        socketOptions.hostname = this.config.bridgeHost;
      }

      this.inSocket = await Bun.udpSocket(socketOptions);
      this.status.debug(
        `Created incoming UDP socket on port ${this.config.fromLaserPort}${this.config.bridgeHost ? ` bound to ${this.config.bridgeHost}` : ""}`,
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
      if (this.inSocket) {
        this.inSocket.close();
        this.inSocket = null;
      }
      if (this.outSocket) {
        this.outSocket.close();
        this.outSocket = null;
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

  sendToLaser(packetData: Buffer): void {
    if (!this.isStarted || !this.outSocket) {
      this.status.error("UDP relay not started, cannot send packet");
      return;
    }

    if (!this.gotAck) {
      this.status.warn(
        "Cannot send packet, waiting for ACK from previous packet",
      );
      return;
    }

    // Calculate checksum for UDP packet (sum of all bytes, MSB first)
    let checksum = 0;
    for (const byte of packetData) {
      checksum += byte;
    }
    checksum = checksum & 0xffff; // Keep it 16-bit

    // Create UDP packet with 2-byte checksum header
    const checksumHeader = Buffer.from([
      (checksum >> 8) & 0xff, // MSB first
      checksum & 0xff,
    ]);
    const udpPacket = Buffer.concat([checksumHeader, packetData]);

    // Enforce maximum UDP packet size
    const MAX_UDP_SIZE = RUIDA_PROTOCOL.MAX_UDP_SIZE;
    if (udpPacket.length <= MAX_UDP_SIZE) {
      // Send as single packet
      this.status.debug(
        `Sending UDP packet: ${udpPacket.length} bytes to ${this.config.laserIp}:${this.config.toLaserPort}`,
      );
      this.status.debug(`Packet data: ${udpPacket.toString("hex")}`);

      this.outSocket.send(
        udpPacket,
        this.config.toLaserPort,
        this.config.laserIp,
      );

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

      this.outSocket.send(
        firstFragment,
        this.config.toLaserPort,
        this.config.laserIp,
      );

      // Mark that we're waiting for ACK
      this.gotAck = false;
    }
  }
}
