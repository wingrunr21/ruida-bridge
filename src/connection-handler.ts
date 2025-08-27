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

  constructor(config: ConnectionConfig, status: Status) {
    this.config = config;
    this.status = status;
  }

  async handleConnection(socket: any): Promise<void> {
    const clientAddr = `${socket.remoteAddress}`;
    this.status.ok(`Connection from: ${clientAddr}`);

    // Create UDP socket for outgoing (to laser)
    // Use ephemeral port for outgoing - the important part is the destination
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

    const outSocket = await Bun.udpSocket(outSocketOptions);
    console.debug(
      `Created outgoing UDP socket${this.config.bridgeHost ? ` bound to ${this.config.bridgeHost}` : ""}`,
    );

    // Create UDP socket for incoming (from laser)
    let gotAck = true;
    let ackValue = Buffer.alloc(0);
    let lastLen = 0;
    let packetType = PacketType.Laser;

    const socketOptions: any = {
      port: this.config.fromLaserPort,
      socket: {
        data(inSock: any, buf: any, _port: any, _addr: any) {
          const data = Buffer.from(buf);
          console.debug(
            `Received UDP response: ${data.length} bytes from laser`,
          );
          console.debug(`Response data: ${data.toString("hex")}`);

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
        error(socket: any, error: any) {
          console.error("UDP in socket error:", error);
        },
      },
    };

    if (this.config.bridgeHost) {
      socketOptions.hostname = this.config.bridgeHost;
    }

    const inSocket = await Bun.udpSocket(socketOptions);
    console.debug(
      `Created incoming UDP socket on port ${this.config.fromLaserPort}${this.config.bridgeHost ? ` bound to ${this.config.bridgeHost}` : ""}`,
    );
    console.debug(
      `Bridge will send packets to laser at ${this.config.laserIp}:${this.config.toLaserPort}`,
    );

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
                console.debug(
                  `Sending UDP packet: ${udpPacket.length} bytes to ${this.config.laserIp}:${this.config.toLaserPort}`,
                );
                console.debug(`Packet data: ${udpPacket.toString("hex")}`);
                outSocket.send(
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
                  const chunkSize = Math.min(
                    MAX_UDP_SIZE,
                    udpPacket.length - offset,
                  );
                  const fragment = udpPacket.subarray(
                    offset,
                    offset + chunkSize,
                  );

                  console.debug(
                    `Sending fragment ${fragmentIndex + 1}: ${fragment.length} bytes to ${this.config.laserIp}:${this.config.toLaserPort}`,
                  );
                  console.debug(`Fragment data: ${fragment.toString("hex")}`);
                  outSocket.send(
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
