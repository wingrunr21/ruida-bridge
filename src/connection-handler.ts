import type { Status } from "./types.ts";

export enum PacketType {
  Laser = 0x4c, // 'L'
  Ping = 0x50, // 'P'
}

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
    const outSocket = Bun.udpSocket({
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

    const inSocket = Bun.udpSocket({
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
          }

          // Forward to client via TCP
          if (socket && !socket.closed && (data.length > 1 || lastLen <= 500)) {
            const header = Buffer.from([
              packetType,
              (data.length >> 8) & 0xff,
              data.length & 0xff,
            ]);
            try {
              socket.write(Buffer.concat([header, data]));
            } catch {
              // Connection might be closed
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
      inSocket.close();
      outSocket.close();
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
          packetType = packet[0];
          packetLen = (packet[1] << 8) + packet[2];
          packet = packet.slice(3);
        }

        // Process complete packet
        if (packetLen > 0 && packet.length >= packetLen) {
          const packetData = packet.slice(0, packetLen);
          packet = packet.slice(packetLen);
          packetLen = 0;

          switch (packetType) {
            case PacketType.Laser:
              // Forward to laser via UDP
              outSocket.send(
                packetData,
                this.config.toLaserPort,
                this.config.laserIp,
              );
              lastLen = packetData.length;
              lastTime = Date.now();
              gotAck = false;
              break;

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
                `Unhandled packet type: 0x${packetType.toString(16)}`,
              );
          }
        }
      };

      // Timeout check
      timeoutCheckInterval = setInterval(() => {
        if (!gotAck && Date.now() - lastTime > 6000) {
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
