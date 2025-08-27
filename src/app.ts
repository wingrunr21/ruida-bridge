import { EventEmitter } from "events";
import { TcpServer, type ServerConfig } from "./tcp-server.ts";
import { StatusServer, type StatusData } from "./status-server.ts";
import type { ConnectionConfig } from "./connection-handler.ts";
import { UdpRelay } from "./udp-relay.ts";
import type { Status } from "./types.ts";

export interface AppConfig {
  laser_ip: string;
  server_port: number;
  server_ip: string;
  bridge_host?: string;
}

export class RuidaBridgeApp extends EventEmitter {
  private config: AppConfig;
  private status: Status;
  private tcpServer: TcpServer;
  private statusServer: StatusServer;
  private udpRelay: UdpRelay;
  private version: [number, number] = [1, 0];

  constructor(config: AppConfig, status: Status, udpRelay?: UdpRelay) {
    super();
    this.config = config;
    this.status = status;

    // Initialize servers
    const serverConfig: ServerConfig = {
      hostname: config.server_ip,
      port: config.server_port,
    };

    const connectionConfig: ConnectionConfig = {
      laserIp: config.laser_ip,
      fromLaserPort: 40200,
      toLaserPort: 50200,
      version: this.version,
      ...(config.bridge_host && { bridgeHost: config.bridge_host }),
    };

    this.udpRelay = udpRelay || new UdpRelay(connectionConfig, status);
    this.tcpServer = new TcpServer(
      serverConfig,
      connectionConfig,
      status,
      this.udpRelay,
    );
    this.statusServer = new StatusServer(status);

    // Handle shutdown signals
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  async start(): Promise<void> {
    // Start UDP relay first
    await this.udpRelay.start();

    // Start status server
    this.statusServer.start(() => this.getStatusData());

    // Start TCP server
    this.tcpServer.start();

    this.status.ok(`Ruida Bridge started`);
    this.status.info(`Laser IP: ${this.config.laser_ip}`);
    this.status.info(`Server Port: ${this.config.server_port}`);

    this.emit("started");
  }

  stop(): void {
    this.status.info("Ruida Bridge stopping...");

    // Stop servers
    if (this.tcpServer) {
      this.tcpServer.stop();
    }
    if (this.statusServer) {
      this.statusServer.stop();
    }
    if (this.udpRelay) {
      this.udpRelay.stop();
    }

    this.status.info("Ruida Bridge stopped");
    this.emit("stopped");
  }

  private getStatusData(): StatusData {
    const connectionStats = this.tcpServer.getConnectionStats();

    return {
      status: "healthy",
      uptime: this.statusServer.getUptime(),
      version: this.version,
      laser_ip: this.config.laser_ip,
      server_port: this.config.server_port,
      connections: {
        current: connectionStats.current,
        queued: connectionStats.queued,
        processing: connectionStats.processing,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
