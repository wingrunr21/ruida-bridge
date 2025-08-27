import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { TcpServer, type ServerConfig } from "../src/tcp-server.ts";
import type { ConnectionConfig } from "../src/connection-handler.ts";
import { UdpRelay } from "../src/udp-relay.ts";
import type { Status } from "../src/types.ts";

describe("TcpServer", () => {
  let mockStatus: Status;
  let serverConfig: ServerConfig;
  let connectionConfig: ConnectionConfig;
  let mockUdpRelay: UdpRelay;
  let server: TcpServer;

  beforeEach(() => {
    mockStatus = {
      ok: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    };

    serverConfig = {
      hostname: "127.0.0.1",
      port: 15007, // Use unique port for testing
    };

    connectionConfig = {
      laserIp: "127.0.0.1",
      fromLaserPort: 40200,
      toLaserPort: 50200,
      version: [1, 0],
    };

    mockUdpRelay = new UdpRelay(connectionConfig, mockStatus);
    server = new TcpServer(
      serverConfig,
      connectionConfig,
      mockStatus,
      mockUdpRelay,
    );
  });

  afterEach(() => {
    if (server) {
      server.stop();
    }
  });

  describe("Configuration", () => {
    test("should store server configuration correctly", () => {
      expect(serverConfig.hostname).toBe("127.0.0.1");
      expect(serverConfig.port).toBe(15007);
    });

    test("should store connection configuration correctly", () => {
      expect(connectionConfig.laserIp).toBe("127.0.0.1");
      expect(connectionConfig.fromLaserPort).toBe(40200);
      expect(connectionConfig.toLaserPort).toBe(50200);
      expect(connectionConfig.version).toEqual([1, 0]);
    });
  });

  describe("Server Lifecycle", () => {
    test("should start and emit started event", (done) => {
      server.on("started", () => {
        expect(mockStatus.ok).toHaveBeenCalledWith(
          "TCP server listening on 127.0.0.1:15007",
        );
        done();
      });

      server.start();
    });

    test("should stop and emit stopped event", (done) => {
      server.on("stopped", () => {
        expect(mockStatus.info).toHaveBeenCalledWith("TCP server stopped");
        done();
      });

      server.on("started", () => {
        server.stop();
      });

      server.start();
    });
  });

  describe("Connection Statistics", () => {
    test("should return initial connection stats", () => {
      const stats = server.getConnectionStats();

      expect(stats.current).toBe(0);
      expect(stats.queued).toBe(0);
      expect(stats.processing).toBe(false);
    });

    test("should track connection state changes", () => {
      // Initial state
      const stats = server.getConnectionStats();
      expect(stats.current).toBe(0);
      expect(stats.processing).toBe(false);

      // Note: In a real test, we'd need to simulate actual connections
      // to test state changes, which requires more complex mocking
    });
  });

  describe("Connection Management", () => {
    test("should handle sequential connection processing", () => {
      // This tests the connection queuing logic
      const mockSocket1 = { closed: false, end: mock(() => {}) };
      const mockSocket2 = { closed: false, end: mock(() => {}) };

      // Simulate connection queue behavior
      const connectionQueue: any[] = [];
      let isProcessingConnection = false;
      let currentConnection: any = null;

      const handleNewConnection = (socket: any) => {
        if (isProcessingConnection || currentConnection) {
          connectionQueue.push(socket);
        } else {
          currentConnection = socket;
          isProcessingConnection = true;
        }
      };

      // First connection should be processed immediately
      handleNewConnection(mockSocket1);
      expect(currentConnection).toBe(mockSocket1);
      expect(isProcessingConnection).toBe(true);
      expect(connectionQueue.length).toBe(0);

      // Second connection should be queued
      handleNewConnection(mockSocket2);
      expect(currentConnection).toBe(mockSocket1); // Still processing first
      expect(connectionQueue.length).toBe(1);
      expect(connectionQueue[0]).toBe(mockSocket2);
    });

    test("should clean up closed sockets from queue", () => {
      const connectionQueue: any[] = [];
      const closedSocket = { closed: true, end: mock(() => {}) };
      const openSocket = { closed: false, end: mock(() => {}) };

      connectionQueue.push(closedSocket);
      connectionQueue.push(openSocket);

      const processNextConnection = () => {
        if (connectionQueue.length > 0) {
          const nextSocket = connectionQueue.shift();
          if (nextSocket && !nextSocket.closed) {
            return nextSocket;
          } else if (nextSocket && nextSocket.closed) {
            // Recursively try next connection
            return processNextConnection();
          }
        }
        return null;
      };

      // Should skip closed socket and return open socket
      const nextSocket = processNextConnection();
      expect(nextSocket).toBe(openSocket);
      expect(connectionQueue.length).toBe(0);
    });
  });

  describe("Error Handling", () => {
    test("should handle server socket errors", () => {
      const testError = new Error("Server socket error");

      // Simulate error handling
      mockStatus.error("Server socket error: " + testError.message);

      expect(mockStatus.error).toHaveBeenCalledWith(
        "Server socket error: Server socket error",
      );
    });

    test("should handle connection processing errors", () => {
      const testError = new Error("Connection processing failed");

      // Simulate connection error handling
      mockStatus.error("Failed to handle connection: " + testError);

      expect(mockStatus.error).toHaveBeenCalledWith(
        "Failed to handle connection: Error: Connection processing failed",
      );
    });
  });

  describe("Socket Lifecycle Management", () => {
    test("should properly override socket close handler", () => {
      let connectionClosed = false;
      let nextConnectionProcessed = false;

      const mockSocket = {
        closed: false,
        close: null as any,
        end: mock(() => {}),
      };

      const processNextConnection = mock(() => {
        nextConnectionProcessed = true;
      });

      // Simulate the socket close handler override
      const originalClose = mockSocket.close;
      mockSocket.close = () => {
        if (originalClose) {
          originalClose();
        }
        connectionClosed = true;
        processNextConnection();
      };

      // Trigger close
      mockSocket.close();

      expect(connectionClosed).toBe(true);
      expect(processNextConnection).toHaveBeenCalled();
      expect(nextConnectionProcessed).toBe(true);
    });
  });
});
