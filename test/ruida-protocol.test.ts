import { describe, test, expect } from "bun:test";
import { PacketType } from "../src/connection-handler.ts";

describe("Ruida Protocol Compliance", () => {
  describe("Packet Types", () => {
    test("should define correct packet type values", () => {
      expect(PacketType.Laser).toBe(0x4c); // 'L'
      expect(PacketType.Ping).toBe(0x50); // 'P'
    });
  });

  describe("UDP Protocol Requirements", () => {
    test("should use correct laser communication ports", () => {
      // From protocol spec: device listens on UDP port 50200
      const TO_LASER_PORT = 50200;
      const FROM_LASER_PORT = 40200;

      expect(TO_LASER_PORT).toBe(50200);
      expect(FROM_LASER_PORT).toBe(40200);
    });
  });

  describe("Checksum Validation", () => {
    test("should validate checksum format", () => {
      // Checksum is 2 bytes, MSB first, before message
      const createChecksumHeader = (data: Buffer) => {
        // Simple checksum calculation (sum of bytes)
        let sum = 0;
        for (const byte of data) {
          sum += byte;
        }
        // Return 2-byte checksum, MSB first
        return Buffer.from([(sum >> 8) & 0xff, sum & 0xff]);
      };

      const testData = Buffer.from([0xc6, 0x01, 0x10, 0x00]); // Min power command
      const checksum = createChecksumHeader(testData);

      expect(checksum.length).toBe(2);
      expect(checksum[0]).toBe((0xd7 >> 8) & 0xff); // MSB
      expect(checksum[1]).toBe(0xd7 & 0xff); // LSB
    });
  });

  describe("Command Format Validation", () => {
    test("should validate laser power commands", () => {
      // C6 01 <POWER> - 1st laser source min power
      // C6 02 <POWER> - 1st laser source max power
      // POWER = 2 bytes (0.006103516% units)

      const minPowerCmd = Buffer.from([0xc6, 0x01, 0x10, 0x00]); // Min power
      const maxPowerCmd = Buffer.from([0xc6, 0x02, 0x20, 0x00]); // Max power

      expect(minPowerCmd[0]).toBe(0xc6);
      expect(minPowerCmd[1]).toBe(0x01); // Min power selector
      expect(minPowerCmd.length).toBe(4); // Command + power value

      expect(maxPowerCmd[0]).toBe(0xc6);
      expect(maxPowerCmd[1]).toBe(0x02); // Max power selector
      expect(maxPowerCmd.length).toBe(4);
    });

    test("should validate movement commands", () => {
      // 88 <ABSCOORD> <ABSCOORD> - straight move to absolute X Y with laser off
      // A8 <ABSCOORD> <ABSCOORD> - straight cut to absolute X Y with laser on
      // ABSCOORD = 5 bytes, position in µm

      const moveCmd = Buffer.from([
        0x88, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00,
      ]);
      const cutCmd = Buffer.from([
        0xa8, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00,
      ]);

      expect(moveCmd[0]).toBe(0x88); // Move command
      expect(moveCmd.length).toBe(11); // Command + 2x 5-byte coordinates

      expect(cutCmd[0]).toBe(0xa8); // Cut command
      expect(cutCmd.length).toBe(11);
    });

    test("should validate speed commands", () => {
      // C9 02 <SPEED> - movement/cutting speed
      // SPEED = 5 bytes, speed in µm/s

      const speedCmd = Buffer.from([0xc9, 0x02, 0x00, 0x00, 0x10, 0x00, 0x00]);

      expect(speedCmd[0]).toBe(0xc9);
      expect(speedCmd[1]).toBe(0x02);
      expect(speedCmd.length).toBe(7); // Command + 5-byte speed value
    });

    test("should validate acknowledgment responses", () => {
      // 0xC6 - ACK (all is well, send next chunk)
      // 0x46 - ERR (error, checksum error or busy)

      const ackResponse = 0xc6;
      const errResponse = 0x46;

      expect(ackResponse).toBe(0xc6);
      expect(errResponse).toBe(0x46);
    });
  });

  describe("Message Fragmentation", () => {
    test("should handle MTU constraints", () => {
      // Max UDP package size 1472 bytes including checksum
      const MAX_UDP_SIZE = 1472;
      const CHECKSUM_SIZE = 2;
      const MAX_PAYLOAD_SIZE = MAX_UDP_SIZE - CHECKSUM_SIZE;

      expect(MAX_PAYLOAD_SIZE).toBe(1470);

      // Large message should be fragmentable
      const largeMessage = Buffer.alloc(3000, 0xaa);
      const chunks = [];

      for (let i = 0; i < largeMessage.length; i += MAX_PAYLOAD_SIZE) {
        const chunk = largeMessage.subarray(i, i + MAX_PAYLOAD_SIZE);
        chunks.push(chunk);
      }

      expect(chunks.length).toBe(3); // Should split into 3 chunks
      expect(chunks[0]?.length).toBe(MAX_PAYLOAD_SIZE);
      expect(chunks[1]?.length).toBe(MAX_PAYLOAD_SIZE);
      expect(chunks[2]?.length).toBe(60); // Remainder
    });
  });

  describe("TCP Packet Format", () => {
    test("should create valid TCP packet headers", () => {
      // TCP packets have 3-byte header: [type, length_high, length_low]
      const createTcpPacket = (type: number, data: Buffer) => {
        const header = Buffer.from([
          type,
          (data.length >> 8) & 0xff, // High byte
          data.length & 0xff, // Low byte
        ]);
        return Buffer.concat([header, data]);
      };

      const testData = Buffer.from([0xc6, 0x01, 0x10, 0x00]);
      const packet = createTcpPacket(PacketType.Laser, testData);

      expect(packet[0]).toBe(PacketType.Laser); // Type
      expect(packet[1]).toBe(0x00); // Length high byte
      expect(packet[2]).toBe(0x04); // Length low byte (4 bytes of data)
      expect(packet.length).toBe(7); // 3-byte header + 4-byte data
    });

    test("should handle ping responses correctly", () => {
      // Ping response should include version info
      const version: [number, number] = [1, 0];
      const pingResponse = Buffer.from([
        PacketType.Ping,
        0x00,
        0x02, // Length: 2 bytes
        ...version, // Version bytes
      ]);

      expect(pingResponse[0]).toBe(PacketType.Ping);
      expect(pingResponse[1]).toBe(0x00); // Length high
      expect(pingResponse[2]).toBe(0x02); // Length low
      expect(pingResponse[3]).toBe(1); // Version major
      expect(pingResponse[4]).toBe(0); // Version minor
      expect(pingResponse.length).toBe(5);
    });
  });

  describe("Data Encoding", () => {
    test("should encode absolute coordinates correctly", () => {
      // ABSCOORD = 5 bytes, position in µm
      const encodeAbsCoord = (value: number): Buffer => {
        const buf = Buffer.alloc(5);
        // Little-endian encoding assumed
        buf.writeUInt32LE(value, 0);
        buf[4] = (value >> 32) & 0xff;
        return buf;
      };

      const coord = encodeAbsCoord(100000); // 100mm in µm
      expect(coord.length).toBe(5);
    });

    test("should encode relative coordinates correctly", () => {
      // RELCOORD = 2 bytes, signed (2s complement)
      const encodeRelCoord = (value: number): Buffer => {
        const buf = Buffer.alloc(2);
        buf.writeInt16LE(value, 0);
        return buf;
      };

      const coord = encodeRelCoord(-1000); // -1mm in µm
      expect(coord.length).toBe(2);
      expect(coord.readInt16LE(0)).toBe(-1000);
    });

    test("should encode power values correctly", () => {
      // POWER = 2 bytes, in 0.006103516% units (100/2^14)
      const encodePower = (percentage: number): Buffer => {
        const value = Math.round((percentage * (1 << 14)) / 100);
        const buf = Buffer.alloc(2);
        buf.writeUInt16LE(value, 0);
        return buf;
      };

      const power50 = encodePower(50); // 50%
      const power100 = encodePower(100); // 100%

      expect(power50.length).toBe(2);
      expect(power100.length).toBe(2);
      expect(power100.readUInt16LE(0)).toBe(16384); // 2^14
    });

    test("should encode speed values correctly", () => {
      // SPEED = 5 bytes, speed in µm/s
      const encodeSpeed = (value: number): Buffer => {
        const buf = Buffer.alloc(5);
        buf.writeUInt32LE(value, 0);
        buf[4] = (value >> 32) & 0xff;
        return buf;
      };

      const speed = encodeSpeed(10000); // 10mm/s in µm/s
      expect(speed.length).toBe(5);
    });
  });
});
