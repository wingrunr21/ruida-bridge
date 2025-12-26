# AGENTS.md

## Project Overview

This project builds a TypeScript relay server that allows proxying the Ruida protocol for a Ruida-based laser to client software such as LightBurn.

The project consists of:
- A socket relay server (TCP-to-UDP bridge)
- A `/status` HTTP endpoint for health checks
- Both services start up via `index.ts`

Logging should follow best practices with differentiated log levels.

## Setup Commands

- Install dependencies: `bun install`
- Start dev server: `bun dev`
- Start production: `bun start`
- Run tests: `bun test`
- Run tests with watch: `bun test:watch`
- Run tests with coverage: `bun test:coverage`
- Run linter: `bun run lint`
- Fix linting issues: `bun run lint:fix`
- Type check: `bun run typecheck`
- Build: `bun run build`

## Code Style

- Always write TypeScript that complies with the settings in `tsconfig.json`
- Use Bun runtime instead of Node.js, npm, pnpm, or vite
- Follow strict TypeScript settings (enabled in tsconfig.json)
- Use proper logging with differentiated log levels

## Testing Instructions

Before committing, ensure all checks pass:
- `bun run test` - Run the test suite
- `bun run lint` - Check code style and linting rules
- `bun run typecheck` - Verify TypeScript compilation

Fix any test failures, linting errors, or type errors before completing the task.

## Ruida Protocol

### Data Format

- Byte = 1 Bit Message Start Indicator + 7 Bit Payload
- Only one message (checksum + command) can be sent per UDP package
- Max UDP package size 1472 bytes including checksum; fragmented by simple cutting (even inside a command)

### Checksum

2 Bytes - sum of scrambled message bytes; MSB first.
Checksum has to be sent before message.

### UDP Transmission

- The device listens on a fixed UDP port 50200. IP address is configurable, but netmask is 255.255.255.0 fixed.
- The device sends responses from port 40200.
- An RD file is transferred as payload, same commands and syntax as with USB-Serial or USB-MassStorage.
- The payload is split in chunks with a well known maximum size (MTU = 1472 bytes including checksum). (The last packet is usually shorter)
- **Handshake**: Before sending data, a handshake must be performed by sending `0xCC` and waiting for `0xCC` response.
- Each chunk starts with a two byte checksum (MSB first), followed by payload data. Length of the payload is implicit by the UDP datagram size. (Would not work with TCP)
- Each chunk is acknowledged with a single byte response packet:
  - `0xC6`: Packet received successfully, send next chunk
  - `0x46`: Error (checksum or busy)
  - `0xCC`: Checksum match (for handshake)
  - `0xCF`: Checksum fail
- The first chunk should be retried when `0x46` was received. For subsequent chunks transmission should be aborted.
- **Control Bytes**:
  - `0xCC`: Connect/handshake packet (must be sent first)
  - `0xCD`: Disconnect packet (should be sent on connection close)
  - `0xCE`: Keepalive packet (for maintaining connection)

### Values

| Value | Length | Description |
|-------|--------|-------------|
| ABSCOORD | 5 Bytes | absolute position relative to job origin in µm |
| RELCOORD | 2 Bytes | relative position in µm; signed (2s complement) |
| SPEED | 5 Bytes | speed in µm/s |
| POWER | 2 Bytes | power in 0,006103516% (100/2^14) |
| CSTRING | variable zero terminated | |

### Commands

| Byte sequence | Description | How sure we are |
|---------------|-------------|-----------------|
| C6 01 [POWER] | 1st laser source min power | 99% |
| C6 21 [POWER] | 2nd laser source min power | 99% |
| C6 02 [POWER] | 1st laser source max power | 99% |
| C6 22 [POWER] | 2nd laser source max power | 99% |
| C9 02 [SPEED] | movement and/or (not sure) cutting speed | 80% |
| D9 00 02 [ABSCOORD] | move X | 99% |
| D9 00 03 [ABSCOORD] | move Y | 50% |
| D9 00 04 [ABSCOORD] | move Z | 50% |
| D9 00 05 [ABSCOORD] | move U | 50% |
| DA 00 XX XX | get XX XX from machine | 99% |
| DA 00 04 05 | saved job count | 99% |
| DA 01 XX XX [VALUE] | response to DA 00 XX XX | 99% |
| A8 [ABSCOORD] [ABSCOORD] | Straight cut to absolute X Y; turn laser on with configured speed and power | 99% |
| A9 [RELCOORD] [RELCOORD] | Straight cut to relative X Y; turn laser on with configured speed and power | 99% |
| E7 50 [ABSCOORD] [ABSCOORD] | Bounding box top left? | 30% |
| E7 51 [ABSCOORD] [ABSCOORD] | Bounding box bottom right? | 30% |
| E8 02 E7 01 [CSTRING] | Set filename for following transfer (transfer needs to be done really quickly after this!) | 90% |
| E8 01 XX XX | Read filename number XX XX | |
| 88 [ABSCOORD] [ABSCOORD] | straight move to absolute X Y as fast as possible; with laser off | 99% |
| 89 [RELCOORD] [RELCOORD] | straight move to relative X Y as fast as possible; with laser off | 80% |

### Existing Implementations

- [lightburn-bridge](https://github.com/cdedwards/lightburn-bridge) - decompiled Python for the [LightBurn Bridge](https://docs.lightburnsoftware.com/2.0/Reference/LightBurnBridge/) software
  - The relay implementation is in the `LBBridge/relay.py` file
- [RuidaProxy](https://github.com/jnweiger/ruida-laser/blob/master/RudiaProxy/RuidaProxy.py) - Proxy implementation by the company that makes the Ruida controller

### Background Research

- [Ruida - EduTech Wiki](https://edutechwiki.unige.ch/en/Ruida)
- [Ruida Protocol](https://github.com/jnweiger/ruida-laser/blob/master/doc/protocol.md)
- [ruida Rust Crate](https://crates.io/crates/ruida)
- [Sending Basic Commands](https://forum.lightburnsoftware.com/t/sending-basic-commands-via-udp-to-ruida/166604)
- [Data Format](https://forum.lightburnsoftware.com/t/what-data-format-does-lb-use-to-talk-to-ruida/57848)
- [Connect via Ethernet](https://forum.lightburnsoftware.com/t/how-do-i-connect-a-ruida-controller-with-ethernet/7672)

## Docker Setup

The Docker Compose stack consists of this project plus [go2rtc](https://github.com/AlexxIT/go2rtc) for camera integration. Both services should be run with host network access along with privileged access for go2rtc (as it needs to interact with hardware).

See `docker/docker-compose.yml` for the full configuration.

## Network Ports

- **TCP 5005**: Client connections (configurable, **must be 5005 for LightBurn Bridge compatibility**)
- **UDP 40200**: Incoming from laser (fixed)
- **UDP 50200**: Outgoing to laser (fixed)
- **TCP 3000**: Status/health endpoint (default)

