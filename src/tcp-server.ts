import { EventEmitter } from "events";
import {
  ConnectionHandler,
  type ConnectionConfig,
} from "./connection-handler.ts";
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
  ) {
    super();
    this.config = config;
    this.connectionConfig = connectionConfig;
    this.status = status;
    this.connectionHandler = new ConnectionHandler(connectionConfig, status);
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

    // Override the socket's close handler to process next connection
    const originalClose = socket.close;
    socket.close = () => {
      if (originalClose) {
        originalClose();
      }
      this.currentConnection = null;
      this.isProcessingConnection = false;
      this.processNextConnection();
    };

    try {
      await this.connectionHandler.handleConnection(socket);
    } catch (error) {
      this.status.error(`Failed to handle connection: ${error}`);
      this.currentConnection = null;
      this.isProcessingConnection = false;
      this.processNextConnection();
    }
  }

  private processNextConnection(): void {
    if (this.connectionQueue.length > 0 && !this.isProcessingConnection) {
      const nextSocket = this.connectionQueue.shift();
      if (nextSocket && !nextSocket.closed) {
        this.processConnection(nextSocket);
      } else if (nextSocket && nextSocket.closed) {
        // Socket was closed while waiting, try next one
        this.processNextConnection();
      }
    }
  }

  getConnectionStats() {
    return {
      current: this.currentConnection ? 1 : 0,
      queued: this.connectionQueue.length,
      processing: this.isProcessingConnection,
    };
  }
}
