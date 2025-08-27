# Ruida Bridge

A high-performance TCP-to-UDP relay bridge for Ruida laser controllers.

## Overview

Ruida Bridge acts as a relay between TCP clients (like LightBurn) and UDP-based Ruida laser controllers. It provides:

- **High Performance**: Built with Bun's native networking APIs for minimal overhead
- **Connection Queuing**: Handles multiple client connections sequentially to prevent conflicts
- **Protocol Translation**: Converts between TCP packet format and UDP communication
- **Docker Support**: Ready-to-deploy containerized solution
- **Flexible Configuration**: Command-line arguments, environment variables, and defaults

## Quick Start

### Prerequisites

- [Bun](https://bun.com) v1.2.0 or later
- Docker (optional, for containerized deployment)

### Installation

```bash
bun install
```

### Running the Bridge

**Basic usage:**
```bash
bun start
```

**With custom laser IP:**
```bash
bun start --laser-ip 192.168.1.200
```

**With custom port:**
```bash
bun start --bridge-port 5006 --laser-ip 10.0.1.100
```

**Using environment variables:**
```bash
LASER_IP=10.0.3.3 BRIDGE_PORT=5005 BRIDGE_HOST=10.0.3.1 bun start
```

## Configuration

### Command Line Options

- `-l, --laser-ip <IP>`: IP address of the Ruida laser controller (default: 10.0.3.3)
- `-p, --bridge-port <PORT>`: TCP bridge port to listen on (default: 5005)
- `-h, --help`: Show help message
- `-v, --version`: Show version information

### Environment Variables

- `LASER_IP`: Default laser controller IP address
- `BRIDGE_PORT`: Default TCP bridge port
- `BRIDGE_HOST`: Hostname/IP to bind UDP sockets to (defaults to 10.0.3.1)
- `PORT`: Status server port (Bun native, defaults to 3000)
- `HOST`: Host to bind servers to (Bun native)

### Network Ports

- **TCP 5005**: Client connections (configurable, **must be 5005 for LightBurn Bridge compatibility**)
- **UDP 40200**: Incoming from laser (fixed)
- **UDP 50200**: Outgoing to laser (fixed)

## Docker Deployment

### Pre-built Images (Recommended)

```bash
# Latest release
docker pull ghcr.io/wingrunr21/ruida-bridge:latest

# Specific version
docker pull ghcr.io/wingrunr21/ruida-bridge:v1.0.0

# Latest main branch
docker pull ghcr.io/wingrunr21/ruida-bridge:main
```

### Using Docker Compose

```bash
# Build and start the service
bun run docker:build
docker-compose -f docker/docker-compose.yml up -d

# Or use the npm script
bun run docker:run
```

### Manual Docker build

```bash
docker build -f docker/Dockerfile -t ruida-bridge .
docker run -p 5005:5005 -p 40200:40200/udp -p 50200:50200/udp \
  -e LASER_IP=10.0.3.3 ruida-bridge
```

### Environment Configuration

Copy `.env.example` to `.env` and customize:

```bash
cp .env.example .env
# Edit .env with your settings
```

## How It Works

1. **Client Connection**: TCP clients (like LightBurn) connect to the bridge on port 5005
2. **Packet Processing**: Bridge receives TCP packets and extracts the payload
3. **UDP Relay**: Payload is forwarded to the laser controller via UDP on port 50200
4. **Response Handling**: UDP responses from the laser (port 40200) are wrapped and sent back via TCP
5. **Connection Management**: Connections are processed sequentially to prevent laser communication conflicts

## Protocol Details

The bridge handles two packet types:
- **Laser packets (0x4C)**: Forwarded to/from the laser controller
- **Ping packets (0x50)**: Responded to with bridge version information

Packet format: `[type:1][length:2][data:length]`

## Development

### Scripts

- `bun start`: Run the bridge
- `bun dev`: Run with file watching for development  
- `bun run build`: Build the project
- `bun test`: Run tests (when available)

### Project Structure

```
├── src/
│   └── relay.ts          # Core relay implementation
├── docker/
│   ├── Dockerfile        # Multi-stage Docker build
│   └── docker-compose.yml # Docker Compose configuration
├── index.ts              # CLI entry point
├── package.json          # Project configuration
└── tsconfig.json         # TypeScript configuration
```

## Compatibility

Compatible with:
- **LightBurn software** (requires server port 5005 for Bridge compatibility mode)
- Ruida laser controllers (RDC6442G, RDC6445G, etc.)
- Any TCP client that speaks the Ruida protocol

### LightBurn Bridge Compatibility

This bridge is designed to be compatible with LightBurn's Bridge feature. For proper compatibility:

1. **Server Port**: Must use port 5005 (default)
2. **Laser IP**: Set to match your laser controller (default: 10.0.3.3)
3. **Network**: Ensure the bridge can reach both your computer and laser controller

In LightBurn, configure your laser device to use "Bridge" connection type and point it to the machine running this bridge.

## License

MIT License - see the LICENSE file for details.
