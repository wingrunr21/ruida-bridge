import type { UdpRelay, UdpRelayCallbacks } from "./udp-relay.ts";
import type { Status } from "./types.ts";

export enum PacketType {
  Laser = 0x4c, // 'L'
  Ping = 0x50, // 'P'
}

// Ruida protocol constants
export const RUIDA_PROTOCOL = {
  // UDP packet constraints
  MAX_UDP_SIZE: 1472, // Maximum UDP packet size including checksum
  CHECKSUM_SIZE: 2, // 2-byte MSB-first checksum

  // ACK responses from laser
  ACK_SUCCESS: 0xc6, // All is well, send next chunk
  ACK_ERROR: 0x46, // Checksum error or busy

  // Timeout for laser communication
  LASER_TIMEOUT: 6000, // 6 seconds
} as const;

export interface ConnectionConfig {
  laserIp: string;
  fromLaserPort: number;
  toLaserPort: number;
  version: [number, number];
  bridgeHost?: string;
}

export class ConnectionHandler {
  private config: ConnectionConfig;
  private status: Status;
  private udpRelay: UdpRelay;

  constructor(config: ConnectionConfig, status: Status, udpRelay: UdpRelay) {
    this.config = config;
    this.status = status;
    this.udpRelay = udpRelay;
  }

  async handleConnection(socket: any): Promise<void> {
    const clientAddr = `${socket.remoteAddress}`;
    this.status.ok(`Connection from: ${clientAddr}`);

    // Connection state for TCP packet parsing
    let packet = Buffer.alloc(0);
    let packetLen = 0;
    let packetType = PacketType.Laser;
    let gotAck = true;
    let lastLen = 0;
    let lastTime = Date.now();
    let timeoutCheckInterval: Timer | null = null;

    // Create callback for UDP responses
    const udpCallback: UdpRelayCallbacks = {
      onLaserResponse: (data: Buffer) => {
        // Forward UDP responses to TCP client
        this.forwardUdpResponseToTcp(socket, data, lastLen);
      },
    };

    // Register for UDP responses
    this.udpRelay.registerCallback(udpCallback);

    const cleanup = () => {
      if (timeoutCheckInterval) {
        clearInterval(timeoutCheckInterval);
      }
      this.udpRelay.unregisterCallback(udpCallback);
    };

    try {
      // Set socket to handle data from TCP client
      socket.data = (socket: any, data: Uint8Array) => {
        if (!gotAck) {
          return;
        }

        const buf = Buffer.from(data);
        packet = Buffer.concat([packet, buf]);

        // Parse packet header (3 bytes: type, length high, length low)
        if (packetLen === 0 && packet.length >= 3) {
          packetType = packet[0] ?? PacketType.Laser;
          packetLen = ((packet[1] ?? 0) << 8) + (packet[2] ?? 0);
          packet = packet.slice(3);
        }

        // Process complete packet
        if (packetLen > 0 && packet.length >= packetLen) {
          const packetData = packet.slice(0, packetLen);
          packet = packet.slice(packetLen);
          packetLen = 0;

          switch (packetType) {
            case PacketType.Laser: {
              // Send to laser via shared UDP relay
              this.udpRelay.sendToLaser(packetData);

              lastLen = packetData.length;
              lastTime = Date.now();
              gotAck = false;
              break;
            }

            case PacketType.Ping: {
              // Respond with version directly (no UDP needed)
              const response = Buffer.from([
                PacketType.Ping,
                0x00,
                0x02, // Length: 2
                ...this.config.version,
              ]);
              socket.write(response);
              break;
            }

            default:
              this.status.error(
                `Unhandled packet type: 0x${(packetType as number).toString(16)}`,
              );
          }
        }
      };

      // Timeout check
      timeoutCheckInterval = setInterval(() => {
        if (!gotAck && Date.now() - lastTime > RUIDA_PROTOCOL.LASER_TIMEOUT) {
          this.status.error("Laser timeout error");
          socket.end();
        }
      }, 1000);

      // Handle socket events
      socket.drain = () => {
        // Socket drained
      };

      socket.close = () => {
        cleanup();
        this.status.ok("Ruida command complete");
      };

      socket.error = (socket: any, error: Error) => {
        this.status.error(`Client socket error: ${error.message}`);
        socket.end();
      };
    } catch (error) {
      this.status.error(`Connection handling error: ${error}`);
      cleanup();
      socket.end();
      throw error;
    }
  }

  private forwardUdpResponseToTcp(
    socket: any,
    data: Buffer,
    lastLen: number,
  ): void {
    // Single byte responses are ACKs
    if (data.length === 1) {
      // Forward single-byte ACKs to client only if previous packet was small
      // (filter out ACKs for large data transfers to avoid spam)
      if (lastLen <= 500) {
        if (socket && !socket.closed) {
          const header = Buffer.from([
            PacketType.Laser, // UDP ACKs are laser responses
            (data.length >> 8) & 0xff,
            data.length & 0xff,
          ]);
          try {
            socket.write(Buffer.concat([header, data]));
          } catch {
            // Connection might be closed
          }
        }
      }
    } else if (data.length > 2) {
      // Validate checksum for multi-byte responses
      const receivedChecksum = ((data[0] ?? 0) << 8) | (data[1] ?? 0);
      const payload = data.slice(2);

      // Calculate expected checksum
      let expectedChecksum = 0;
      for (const byte of payload) {
        expectedChecksum += byte;
      }
      expectedChecksum = expectedChecksum & 0xffff;

      if (receivedChecksum !== expectedChecksum) {
        // Checksum error - log but still forward (let client handle)
        console.warn(
          `UDP checksum mismatch: expected ${expectedChecksum}, got ${receivedChecksum}`,
        );
      }

      // Forward payload (without checksum) to client via TCP
      if (socket && !socket.closed) {
        const header = Buffer.from([
          PacketType.Laser, // UDP responses are laser data
          (payload.length >> 8) & 0xff,
          payload.length & 0xff,
        ]);
        try {
          socket.write(Buffer.concat([header, payload]));
        } catch {
          // Connection might be closed
        }
      }
    }
  }
}
