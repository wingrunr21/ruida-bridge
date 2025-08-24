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
}

export class ConnectionHandler {
  private config: ConnectionConfig;
  private status: Status;

  constructor(config: ConnectionConfig, status: Status) {
    this.config = config;
    this.status = status;
  }

  async handleConnection(socket: any): Promise<void> {
    const clientAddr = `${socket.remoteAddress}`;
    this.status.ok(`Connection from: ${clientAddr}`);

    // Create UDP socket for outgoing (to laser)
    const outSocket = await Bun.udpSocket({
      socket: {
        data(_socket, _buf, _port, _addr) {
          // Not used for outgoing
        },
        error(socket, error) {
          console.error("UDP out socket error:", error);
        },
      },
    });

    // Create UDP socket for incoming (from laser)
    let gotAck = true;
    let ackValue = Buffer.alloc(0);
    let lastLen = 0;
    let packetType = PacketType.Laser;

    const inSocket = await Bun.udpSocket({
      port: this.config.fromLaserPort,
      socket: {
        data(inSock, buf, _port, _addr) {
          const data = Buffer.from(buf);

          // Single byte responses are ACKs
          if (data.length === 1) {
            if (ackValue.length === 0) {
              ackValue = data;
              gotAck = true;
            } else if (ackValue[0] !== data[0]) {
              gotAck = true;
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

          // Forward single-byte ACKs to client only if previous packet was small
          // (filter out ACKs for large data transfers to avoid spam)
          if (data.length === 1 && lastLen <= 500) {
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
        },
        error(socket, error) {
          console.error("UDP in socket error:", error);
        },
      },
    });

    // Connection state
    let packet = Buffer.alloc(0);
    let packetLen = 0;
    let lastTime = Date.now();
    let timeoutCheckInterval: Timer | null = null;

    const cleanup = () => {
      if (timeoutCheckInterval) {
        clearInterval(timeoutCheckInterval);
      }
      if (inSocket) {
        inSocket.close();
      }
      if (outSocket) {
        outSocket.close();
      }
    };

    try {
      // Set socket to handle data
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
                outSocket.send(
                  udpPacket,
                  this.config.toLaserPort,
                  this.config.laserIp,
                );
              } else {
                // Fragment packet - send in chunks without breaking commands
                // Note: This is a simplified fragmentation, real implementation
                // should be more sophisticated about command boundaries
                let offset = 0;
                while (offset < udpPacket.length) {
                  const chunkSize = Math.min(
                    MAX_UDP_SIZE,
                    udpPacket.length - offset,
                  );
                  const chunk = udpPacket.subarray(offset, offset + chunkSize);
                  outSocket.send(
                    chunk,
                    this.config.toLaserPort,
                    this.config.laserIp,
                  );
                  offset += chunkSize;
                }
              }

              lastLen = packetData.length;
              lastTime = Date.now();
              gotAck = false;
              break;
            }

            case PacketType.Ping: {
              // Respond with version
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
}
