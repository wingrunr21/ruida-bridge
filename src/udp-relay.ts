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

  constructor(config: ConnectionConfig, status: Status) {
    this.config = config;
    this.status = status;
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }

    try {
      // Create UDP socket for outgoing (to laser)
      const outSocketOptions: any = {
        socket: {
          data(_socket: any, _buf: any, _port: any, _addr: any) {
            // Not used for outgoing socket
          },
          error(socket: any, error: any) {
            console.error("UDP out socket error:", error);
          },
        },
      };

      if (this.config.bridgeHost) {
        outSocketOptions.hostname = this.config.bridgeHost;
      }

      this.outSocket = await Bun.udpSocket(outSocketOptions);
      console.debug(
        `Created outgoing UDP socket${this.config.bridgeHost ? ` bound to ${this.config.bridgeHost}` : ""}`,
      );

      // Create UDP socket for incoming (from laser)
      const socketOptions: any = {
        port: this.config.fromLaserPort,
        socket: {
          data: (inSock: any, buf: any, _port: any, _addr: any) => {
            const data = Buffer.from(buf);
            console.debug(
              `Received UDP response: ${data.length} bytes from laser`,
            );
            console.debug(`Response data: ${data.toString("hex")}`);

            // Forward to all registered callbacks
            this.callbacks.forEach((callback) => {
              callback.onLaserResponse(data);
            });
          },
          error: (socket: any, error: any) => {
            console.error("UDP in socket error:", error);
          },
        },
      };

      if (this.config.bridgeHost) {
        socketOptions.hostname = this.config.bridgeHost;
      }

      this.inSocket = await Bun.udpSocket(socketOptions);
      console.debug(
        `Created incoming UDP socket on port ${this.config.fromLaserPort}${this.config.bridgeHost ? ` bound to ${this.config.bridgeHost}` : ""}`,
      );
      console.debug(
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
      console.error("UDP relay not started, cannot send packet");
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
      console.debug(
        `Sending UDP packet: ${udpPacket.length} bytes to ${this.config.laserIp}:${this.config.toLaserPort}`,
      );
      console.debug(`Packet data: ${udpPacket.toString("hex")}`);
      this.outSocket.send(
        udpPacket,
        this.config.toLaserPort,
        this.config.laserIp,
      );
    } else {
      // Protocol spec: "fragmented by simple cutting (even inside a command)"
      // Simple cutting = split the complete packet (checksum + data) without modification
      console.debug(
        `Fragmenting large packet: ${udpPacket.length} bytes into ${Math.ceil(udpPacket.length / MAX_UDP_SIZE)} fragments`,
      );
      let offset = 0;
      let fragmentIndex = 0;
      while (offset < udpPacket.length) {
        const chunkSize = Math.min(MAX_UDP_SIZE, udpPacket.length - offset);
        const fragment = udpPacket.subarray(offset, offset + chunkSize);

        console.debug(
          `Sending fragment ${fragmentIndex + 1}: ${fragment.length} bytes to ${this.config.laserIp}:${this.config.toLaserPort}`,
        );
        console.debug(`Fragment data: ${fragment.toString("hex")}`);
        this.outSocket.send(
          fragment,
          this.config.toLaserPort,
          this.config.laserIp,
        );
        offset += chunkSize;
        fragmentIndex++;

        // Protocol requires waiting for ACK between fragments
        // For now, send immediately - laser should handle buffering
      }
    }
  }
}
