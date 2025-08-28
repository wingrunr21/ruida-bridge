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

interface ConnectionState {
  packet: Buffer;
  packetLen: number;
  packetType: number;
  gotAck: boolean;
  lastLen: number;
  lastTime: number;
  timeoutCheckInterval: Timer | null;
  udpCallback: UdpRelayCallbacks;
}

export class ConnectionHandler {
  private config: ConnectionConfig;
  private status: Status;
  private udpRelay: UdpRelay;
  private connectionStates = new Map<any, ConnectionState>();

  constructor(config: ConnectionConfig, status: Status, udpRelay: UdpRelay) {
    this.config = config;
    this.status = status;
    this.udpRelay = udpRelay;
  }

  async handleConnection(socket: any): Promise<void> {
    const clientAddr = `${socket.remoteAddress}`;
    this.status.ok(`Connection from: ${clientAddr}`);

    // Create callback for UDP responses
    const udpCallback: UdpRelayCallbacks = {
      onLaserResponse: (data: Buffer) => {
        // Forward UDP responses to TCP client
        const state = this.connectionStates.get(socket);
        if (state) {
          this.forwardUdpResponseToTcp(socket, data, state.lastLen);
        }
      },
    };

    // Initialize connection state
    const connectionState: ConnectionState = {
      packet: Buffer.alloc(0),
      packetLen: 0,
      packetType: 0,
      gotAck: true,
      lastLen: 0,
      lastTime: Date.now(),
      timeoutCheckInterval: null,
      udpCallback: udpCallback,
    };

    this.connectionStates.set(socket, connectionState);

    // Register for UDP responses
    this.udpRelay.registerCallback(udpCallback);

    try {
      // Set up timeout checking
      connectionState.timeoutCheckInterval = setInterval(() => {
        const state = this.connectionStates.get(socket);
        if (
          !state ||
          state.gotAck ||
          Date.now() - state.lastTime <= RUIDA_PROTOCOL.LASER_TIMEOUT
        ) {
          return;
        }
        this.status.error("Laser timeout error");
        this.cleanupConnection(socket);
        socket.end();
      }, 1000);

      // Connection is set up and ready for data
    } catch (error) {
      this.status.error(`Connection handling error: ${error}`);
      this.cleanupConnection(socket);
      socket.end();
      throw error;
    }
  }

  handleData(socket: any, data: Uint8Array): void {
    const state = this.connectionStates.get(socket);
    if (!state) {
      this.status.error("No connection state found for socket data");
      return;
    }

    if (!state.gotAck) {
      return;
    }

    const buf = Buffer.from(data);
    state.packet = Buffer.concat([state.packet, buf]);

    this.status.debug(`Received TCP data: ${buf.toString("hex")}`);
    this.status.debug(`Current packet buffer: ${state.packet.toString("hex")}`);

    // Parse packet header (3 bytes: type, length high, length low)
    if (state.packetLen === 0 && state.packet.length >= 3) {
      state.packetType = state.packet[0] ?? 0;
      state.packetLen = ((state.packet[1] ?? 0) << 8) + (state.packet[2] ?? 0);
      state.packet = state.packet.slice(3);

      this.status.debug(
        `Parsed packet header: type=${state.packetType.toString(16)}, len=${state.packetLen}`,
      );
    }

    // Process complete packet
    if (state.packetLen > 0 && state.packet.length >= state.packetLen) {
      const packetData = state.packet.slice(0, state.packetLen);
      state.packet = state.packet.slice(state.packetLen);
      state.packetLen = 0;

      this.status.debug(
        `Processing packet: type=${state.packetType.toString(16)}, data=${packetData.toString("hex")}`,
      );

      if (state.packetType === PacketType.Laser) {
        // 'L' - Laser packet
        // Send payload to laser via UDP
        this.udpRelay.sendToLaser(packetData);
        this.status.debug(
          `Got laser packet. Forwarded to laser: ${packetData.toString("hex")}`,
        );

        state.lastLen = packetData.length;
        state.lastTime = Date.now();
        state.gotAck = false;
      } else if (state.packetType === PacketType.Ping) {
        // 'P' - Protocol/Ping packet
        // Respond with version
        const response = Buffer.from([
          PacketType.Ping, // 'P'
          0x00,
          0x02, // Length: 2
          ...this.config.version,
        ]);
        this.status.debug(
          `Got Ping packet. Responded with version: ${response.toString("hex")}`,
        );
        socket.write(response);
      } else {
        // Unknown packet types are dropped (not forwarded to laser)
        this.status.error(
          `Unhandled packet type 0x${state.packetType.toString(16)} (${String.fromCharCode(state.packetType)})`,
        );
      }
    }
  }

  cleanupConnection(socket: any): void {
    const state = this.connectionStates.get(socket);
    if (state) {
      if (state.timeoutCheckInterval) {
        clearInterval(state.timeoutCheckInterval);
      }
      this.udpRelay.unregisterCallback(state.udpCallback);
      this.connectionStates.delete(socket);
    }
  }

  private forwardUdpResponseToTcp(
    socket: any,
    data: Buffer,
    lastLen: number,
  ): void {
    const state = this.connectionStates.get(socket);

    // Mark that we got an ACK for single byte responses
    if (data.length === 1 && state) {
      state.gotAck = true;
    }

    // Forward UDP response to TCP client (matching LightBurn Bridge behavior)
    // Only forward if lastLen <= 500 OR data.length > 1 (same as LightBurn Bridge)
    if (data.length > 1 || lastLen <= 500) {
      if (socket && !socket.closed) {
        const header = Buffer.from([
          PacketType.Laser, // UDP responses are laser data
          (data.length >> 8) & 0xff,
          data.length & 0xff,
        ]);
        try {
          socket.write(Buffer.concat([header, data]));
          this.status.debug(
            `Forwarded UDP response to TCP: ${data.toString("hex")}`,
          );
        } catch {
          // Connection might be closed
        }
      }
    }
  }
}
