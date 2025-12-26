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
  private isHandshakeComplete = false;
  private pendingFragments: Buffer[] = [];
  private currentFragmentIndex = 0;
  private retryCount = 0;
  private maxRetries = 3;
  private handshakeRetryCount = 0;
  private maxHandshakeRetries = 3;
  private keepaliveInterval: Timer | null = null;

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

        // Handle single-byte ACK responses
        if (buf.length === 1) {
          const ackByte = buf[0];
          this.handleAckResponse(ackByte);
        } else {
          // Multi-byte responses (data responses)
          this.status.debug(`Received data response: ${buf.toString("hex")}`);
          this.gotAck = true;
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

      // Send handshake
      this.sendHandshake();
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
      // Send disconnect packet
      this.sendDisconnect();

      // Clear keepalive interval
      if (this.keepaliveInterval) {
        clearInterval(this.keepaliveInterval);
        this.keepaliveInterval = null;
      }

      if (this.socket) {
        this.socket.close();
        this.socket = null;
      }

      this.callbacks.clear();
      this.isStarted = false;
      this.isHandshakeComplete = false;
      this.handshakeRetryCount = 0;
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

    switch (ackByte) {
      case RUIDA_PROTOCOL.ACK_SUCCESS:
        this.status.debug("ACK Success - ready for next chunk");
        this.gotAck = true;
        this.retryCount = 0;

        // If we have pending fragments, send the next one
        if (this.pendingFragments.length > 0) {
          this.currentFragmentIndex++;
          if (this.currentFragmentIndex < this.pendingFragments.length) {
            this.sendFragment(this.currentFragmentIndex);
          } else {
            // All fragments sent
            this.pendingFragments = [];
            this.currentFragmentIndex = 0;
          }
        }
        break;

      case RUIDA_PROTOCOL.ACK_ERROR:
        this.status.error("ACK Error - checksum error or busy");
        this.gotAck = false;

        // Retry first chunk, abort subsequent chunks
        if (
          this.currentFragmentIndex === 0 &&
          this.retryCount < this.maxRetries
        ) {
          this.retryCount++;
          this.status.warn(
            `Retrying first chunk (attempt ${this.retryCount}/${this.maxRetries})`,
          );
          setTimeout(() => {
            if (this.pendingFragments.length > 0) {
              this.sendFragment(0);
            }
          }, 100);
        } else {
          this.status.error("Aborting transmission due to error");
          this.pendingFragments = [];
          this.currentFragmentIndex = 0;
          this.retryCount = 0;
          this.gotAck = true; // Reset to allow new packets
        }
        break;

      case RUIDA_PROTOCOL.ACK_CHECKSUM_MATCH:
        this.status.ok("Handshake complete - checksum match");
        this.isHandshakeComplete = true;
        this.gotAck = true;
        this.handshakeRetryCount = 0; // Reset retry count on success

        // Start keepalive
        this.startKeepalive();
        break;

      case RUIDA_PROTOCOL.ACK_CHECKSUM_FAIL:
        this.status.error("Handshake failed - checksum mismatch");
        this.isHandshakeComplete = false;
        this.gotAck = false;
        break;

      default:
        this.status.warn(`Unknown ACK byte: 0x${ackByte.toString(16)}`);
        this.gotAck = true;
        break;
    }
  }

  private sendHandshake(): void {
    if (!this.socket) {
      this.status.error("Cannot send handshake - socket not initialized");
      return;
    }

    if (this.handshakeRetryCount >= this.maxHandshakeRetries) {
      this.status.warn(
        `Handshake failed after ${this.maxHandshakeRetries} attempts - controller may not support handshake protocol`,
      );
      this.status.info(
        "Proceeding without handshake - first data packet will serve as implicit handshake",
      );
      return;
    }

    this.handshakeRetryCount++;
    this.status.info(
      `Sending handshake (0xCC) to laser (attempt ${this.handshakeRetryCount}/${this.maxHandshakeRetries})`,
    );

    // Create handshake packet with proper encoding and checksum
    const handshakeData = Buffer.from([RUIDA_PROTOCOL.CMD_CONNECT]);

    // Encode the handshake byte using Ruida protocol scrambling
    const encodedData = this.encodeBytes(handshakeData);

    // Calculate checksum for the encoded data (MSB first)
    let checksum = 0;
    for (const byte of encodedData) {
      checksum += byte;
    }
    checksum = checksum & 0xffff;

    // Create packet with 2-byte checksum header
    const checksumHeader = Buffer.from([
      (checksum >> 8) & 0xff, // MSB first
      checksum & 0xff,
    ]);
    const handshakePacket = Buffer.concat([checksumHeader, encodedData]);

    this.status.debug(`Handshake packet: ${handshakePacket.toString("hex")}`);

    this.socket.send(
      handshakePacket,
      this.config.toLaserPort,
      this.config.laserIp,
    );

    // Set a timeout for handshake response
    setTimeout(() => {
      if (!this.isHandshakeComplete) {
        this.status.debug("Handshake timeout - will retry if under limit");
        this.sendHandshake();
      }
    }, RUIDA_PROTOCOL.HANDSHAKE_TIMEOUT);
  }

  private sendDisconnect(): void {
    if (!this.socket) {
      return;
    }

    this.status.debug("Sending disconnect (0xCD) to laser");

    // Create disconnect packet with proper encoding and checksum
    const disconnectData = Buffer.from([RUIDA_PROTOCOL.CMD_DISCONNECT]);
    const encodedData = this.encodeBytes(disconnectData);

    let checksum = 0;
    for (const byte of encodedData) {
      checksum += byte;
    }
    checksum = checksum & 0xffff;

    const checksumHeader = Buffer.from([
      (checksum >> 8) & 0xff,
      checksum & 0xff,
    ]);
    const disconnectPacket = Buffer.concat([checksumHeader, encodedData]);

    this.socket.send(
      disconnectPacket,
      this.config.toLaserPort,
      this.config.laserIp,
    );
  }

  private startKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
    }

    this.keepaliveInterval = setInterval(() => {
      if (this.socket && this.isHandshakeComplete && this.gotAck) {
        this.status.debug("Sending keepalive (0xCE) to laser");

        // Create keepalive packet with proper encoding and checksum
        const keepaliveData = Buffer.from([RUIDA_PROTOCOL.CMD_KEEPALIVE]);
        const encodedData = this.encodeBytes(keepaliveData);

        let checksum = 0;
        for (const byte of encodedData) {
          checksum += byte;
        }
        checksum = checksum & 0xffff;

        const checksumHeader = Buffer.from([
          (checksum >> 8) & 0xff,
          checksum & 0xff,
        ]);
        const keepalivePacket = Buffer.concat([checksumHeader, encodedData]);

        this.socket.send(
          keepalivePacket,
          this.config.toLaserPort,
          this.config.laserIp,
        );
      }
    }, RUIDA_PROTOCOL.KEEPALIVE_INTERVAL);
  }

  private sendFragment(fragmentIndex: number): void {
    if (fragmentIndex >= this.pendingFragments.length) {
      this.status.error(`Invalid fragment index: ${fragmentIndex}`);
      return;
    }

    const fragment = this.pendingFragments[fragmentIndex];
    if (!fragment) {
      this.status.error(`Fragment ${fragmentIndex} is undefined`);
      return;
    }

    this.status.debug(
      `Sending fragment ${fragmentIndex + 1}/${this.pendingFragments.length}: ${fragment.length} bytes`,
    );
    this.status.debug(`Fragment data: ${fragment.toString("hex")}`);

    this.socket.send(fragment, this.config.toLaserPort, this.config.laserIp);
    this.gotAck = false;
  }

  private swizzleByte(b: number, magic: number = 0x88): number {
    // Reference implementation from jnweiger/ruida-laser
    // Swap high bit and low bit, then XOR with magic and increment
    const fb = b & 0x80; // Get high bit
    const lb = b & 0x01; // Get low bit
    let res_b = b - fb - lb; // Clear both bits
    res_b |= lb << 7; // Swap: low bit to high position
    res_b |= fb >> 7; // Swap: high bit to low position
    res_b ^= magic;
    res_b = (res_b + 1) & 0xff;
    return res_b;
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

    // Note: Handshake completion is not required for data transmission
    // Some Ruida controllers may not implement the handshake protocol
    // The first data packet will serve as an implicit handshake
    if (!this.isHandshakeComplete) {
      this.status.debug(
        "Handshake not complete, but proceeding with data transmission",
      );
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
      // Fragment the packet
      this.status.info(
        `Fragmenting large packet: ${udpPacket.length} bytes into chunks of ${MAX_UDP_SIZE}`,
      );

      this.pendingFragments = [];
      for (let i = 0; i < udpPacket.length; i += MAX_UDP_SIZE) {
        const fragment = udpPacket.subarray(
          i,
          Math.min(i + MAX_UDP_SIZE, udpPacket.length),
        );
        this.pendingFragments.push(fragment);
      }

      this.status.debug(`Created ${this.pendingFragments.length} fragments`);

      // Send first fragment
      this.currentFragmentIndex = 0;
      this.sendFragment(0);
    }
  }
}
