#!/usr/bin/env bun

import { parseArgs } from "util";
import { RuidaBridgeApp, type AppConfig } from "./src/app.ts";
import { ConsoleStatus } from "./src/types.ts";
import packageJson from "./package.json";

function showHelp(): void {
  console.log(`
Ruida Bridge - High-performance TCP-to-UDP relay for Ruida laser controllers

Usage: bun run index.ts [OPTIONS]

Options:
  -l, --laser-ip <IP>     IP address of the Ruida laser controller
                          (default: LASER_IP env var or 10.0.3.3)
  -p, --bridge-port <PORT> TCP bridge port to listen on
                          (default: BRIDGE_PORT env var or 5005)
                          Note: Port 5005 required for LightBurn Bridge compatibility
  -h, --help              Show this help message
  -v, --version           Show version information

Environment Variables:
  LASER_IP               Laser controller IP Address. Needs to match the controller configuration.
  BRIDGE_PORT            TCP bridge port to listen on. Lightburn Bridge requires port 5005.
  BRIDGE_HOST            Hostname/IP to bind UDP sockets to (defaults to 10.0.3.1).
  HOST                   Host to bind servers to (Bun native).
  PORT                   Status server port (Bun native, defaults to 3000).

Examples:
  bun run index.ts --laser-ip 192.168.1.200
  bun run index.ts --bridge-port 5006 --laser-ip 10.0.1.100
  LASER_IP=10.0.3.3 HOST=0.0.0.0 PORT=3001 bun run index.ts
`);
}

function showVersion(): void {
  console.log(`Ruida Bridge v${packageJson.version}`);
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "laser-ip": { type: "string", short: "l" },
      "bridge-port": { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: false,
  });

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (args.version) {
    showVersion();
    process.exit(0);
  }

  // Configuration from args, env vars, or defaults
  // Let Bun handle HOST natively for status server
  const config: AppConfig = {
    laser_ip: args["laser-ip"] || Bun.env.LASER_IP || "10.0.3.3",
    server_port: parseInt(args["bridge-port"] || Bun.env.BRIDGE_PORT || "5005"),
    server_ip: Bun.env.HOST || "0.0.0.0", // Fallback for TCP server only
    bridge_host: Bun.env.BRIDGE_HOST || "10.0.3.1",
  };

  const status = new ConsoleStatus();
  const app = new RuidaBridgeApp(config, status);

  // Handle graceful shutdown
  let isShuttingDown = false;

  const shutdown = async () => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    status.info("Shutdown signal received");
    app.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  status.info("Starting Ruida Bridge...");

  try {
    await app.start();

    // Keep the process alive
    return new Promise((resolve) => {
      app.on("stopped", resolve);
    });
  } catch (error) {
    status.error(`Failed to start Ruida Bridge: ${error}`);
    process.exit(1);
  }
}

// Only run if this is the main module
if (import.meta.main) {
  main().catch((error) => {
    console.error("Unhandled error:", error);
    process.exit(1);
  });
}

export { main };
