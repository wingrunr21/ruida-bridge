import { EventEmitter } from "events";
import {
  ConnectionHandler,
  type ConnectionConfig,
} from "./connection-handler.ts";
import type { UdpRelay } from "./udp-relay.ts";
import type { Status } from "./types.ts";

export interface ServerConfig {
  hostname: string;
  port: number;
}

export class TcpServer extends EventEmitter {
  private config: ServerConfig;
  private connectionConfig: ConnectionConfig;
  private status: Status;
  private server: any = null;
  private connectionHandler: ConnectionHandler;
  private currentConnection: any = null;
  private connectionQueue: any[] = [];
  private isProcessingConnection: boolean = false;

  constructor(
    config: ServerConfig,
    connectionConfig: ConnectionConfig,
    status: Status,
    udpRelay: UdpRelay,
  ) {
    super();
    this.config = config;
    this.connectionConfig = connectionConfig;
    this.status = status;
    this.connectionHandler = new ConnectionHandler(
      connectionConfig,
      status,
      udpRelay,
    );
  }

  start(): void {
    this.server = Bun.listen({
      hostname: this.config.hostname,
      port: this.config.port,
      socket: {
        open: (socket) => {
          this.handleNewConnection(socket);
        },
        data: (_socket, _data) => {
          // Handled per-socket in ConnectionHandler
        },
        drain: (_socket) => {
          // Handled per-socket in ConnectionHandler
        },
        close: (_socket) => {
          // Handled per-socket in ConnectionHandler
        },
        error: (socket, error) => {
          this.status.error(`Server socket error: ${error.message}`);
        },
      },
    });

    this.status.ok(
      `TCP server listening on ${this.config.hostname}:${this.config.port}`,
    );
    this.emit("started");
  }

  stop(): void {
    if (this.server) {
      // Close current connection if any
      if (this.currentConnection) {
        this.currentConnection.end();
      }

      // Close all queued connections
      this.connectionQueue.forEach((socket) => socket.end());
      this.connectionQueue = [];

      this.server.stop();
      this.server = null;
      this.status.info("TCP server stopped");
      this.emit("stopped");
    }
  }

  private handleNewConnection(socket: any): void {
    // Handle connections sequentially
    if (this.isProcessingConnection || this.currentConnection) {
      // Queue this connection for later processing
      this.connectionQueue.push(socket);
      this.status.info(
        `Connection queued, ${this.connectionQueue.length} in queue`,
      );
    } else {
      // Process this connection immediately
      this.processConnection(socket);
    }
  }

  private async processConnection(socket: any): Promise<void> {
    this.currentConnection = socket;
    this.isProcessingConnection = true;

    // Set up proper cleanup when connection ends
    const cleanup = () => {
      if (this.currentConnection === socket) {
        this.currentConnection = null;
        this.isProcessingConnection = false;
        this.processNextConnection();
      }
    };

    // Handle socket close event properly
    const originalSocketClose = socket.close;
    socket.close = () => {
      cleanup();
      if (originalSocketClose) {
        originalSocketClose();
      }
    };

    // Also listen for socket errors to ensure cleanup
    const originalSocketError = socket.error;
    socket.error = (socket: any, error: Error) => {
      this.status.error(`Socket error: ${error.message}`);
      cleanup();
      if (originalSocketError) {
        originalSocketError(socket, error);
      }
    };

    try {
      await this.connectionHandler.handleConnection(socket);
    } catch (error) {
      this.status.error(`Failed to handle connection: ${error}`);
      cleanup();
    }
  }

  private processNextConnection(): void {
    // Clean up any closed sockets from the queue first
    this.connectionQueue = this.connectionQueue.filter(
      (socket) => !socket.closed,
    );

    if (this.connectionQueue.length > 0 && !this.isProcessingConnection) {
      const nextSocket = this.connectionQueue.shift();
      if (nextSocket && !nextSocket.closed) {
        this.processConnection(nextSocket);
      } else {
        // Try next connection (recursive cleanup)
        this.processNextConnection();
      }
    }
  }

  getConnectionStats() {
    // Clean up closed connections before reporting stats
    this.connectionQueue = this.connectionQueue.filter(
      (socket) => !socket.closed,
    );

    return {
      current: this.currentConnection ? 1 : 0,
      queued: this.connectionQueue.length,
      processing: this.isProcessingConnection,
    };
  }
}
