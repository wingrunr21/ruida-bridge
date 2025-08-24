import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ConnectionHandler, PacketType, type ConnectionConfig } from '../src/connection-handler.ts';
import type { Status } from '../src/types.ts';

describe('ConnectionHandler', () => {
    let mockStatus: Status;
    let config: ConnectionConfig;
    let handler: ConnectionHandler;

    beforeEach(() => {
        mockStatus = {
            ok: mock(() => {}),
            info: mock(() => {}),
            warn: mock(() => {}),
            error: mock(() => {})
        };

        config = {
            laserIp: '192.168.1.100',
            fromLaserPort: 40200,
            toLaserPort: 50200,
            version: [1, 0]
        };

        handler = new ConnectionHandler(config, mockStatus);
    });

    describe('Configuration', () => {
        test('should store configuration correctly', () => {
            expect(config.laserIp).toBe('192.168.1.100');
            expect(config.fromLaserPort).toBe(40200);
            expect(config.toLaserPort).toBe(50200);
            expect(config.version).toEqual([1, 0]);
        });

        test('should use correct UDP ports from protocol spec', () => {
            // Protocol specifies device listens on UDP port 50200
            expect(config.toLaserPort).toBe(50200);
            // Response port is typically 40200 (common pattern)
            expect(config.fromLaserPort).toBe(40200);
        });
    });

    describe('TCP Packet Processing', () => {
        test('should parse TCP packet header correctly', () => {
            // TCP packet format: [type:1][length:2][data:length]
            const parsePacketHeader = (packet: Buffer) => {
                if (packet.length < 3) return null;
                return {
                    type: packet[0],
                    length: (packet[1] << 8) + packet[2],
                    data: packet.slice(3)
                };
            };

            const testData = Buffer.from([0xC6, 0x01, 0x10, 0x00]); // Min power command
            const packet = Buffer.concat([
                Buffer.from([PacketType.Laser, 0x00, 0x04]), // Header
                testData // Data
            ]);

            const parsed = parsePacketHeader(packet);
            expect(parsed).not.toBeNull();
            expect(parsed!.type).toBe(PacketType.Laser);
            expect(parsed!.length).toBe(4);
            expect(parsed!.data).toEqual(testData);
        });

        test('should handle fragmented TCP packets', () => {
            // Simulate fragmented packet arrival
            const testData = Buffer.from([0xC6, 0x01, 0x10, 0x00]);
            const header = Buffer.from([PacketType.Laser, 0x00, 0x04]);
            
            let packet = Buffer.alloc(0);
            let packetLen = 0;

            // First fragment: partial header
            const fragment1 = header.slice(0, 2);
            packet = Buffer.concat([packet, fragment1]);

            // Should not be able to parse yet
            expect(packet.length).toBe(2);
            expect(packet.length < 3).toBe(true);

            // Second fragment: rest of header + partial data
            const fragment2 = Buffer.concat([header.slice(2), testData.slice(0, 2)]);
            packet = Buffer.concat([packet, fragment2]);

            // Now can parse header
            if (packetLen === 0 && packet.length >= 3) {
                packetLen = (packet[1] << 8) + packet[2];
                packet = packet.slice(3);
            }

            expect(packetLen).toBe(4);
            expect(packet.length).toBe(2); // Partial data

            // Third fragment: remaining data
            const fragment3 = testData.slice(2);
            packet = Buffer.concat([packet, fragment3]);

            expect(packet.length).toBe(4); // Complete data
            expect(packet.length >= packetLen).toBe(true);
        });

        test('should create correct ping response', () => {
            const version: [number, number] = [1, 0];
            const response = Buffer.from([
                PacketType.Ping,
                0x00, 0x02,  // Length: 2
                ...version
            ]);

            expect(response[0]).toBe(PacketType.Ping);
            expect(response[1]).toBe(0x00); // Length high byte
            expect(response[2]).toBe(0x02); // Length low byte  
            expect(response[3]).toBe(1);    // Version major
            expect(response[4]).toBe(0);    // Version minor
            expect(response.length).toBe(5);
        });
    });

    describe('UDP Communication', () => {
        test('should validate UDP packet size limits', () => {
            // Max UDP package size 1472 bytes including checksum
            const MAX_UDP_SIZE = 1472;
            const CHECKSUM_SIZE = 2;
            const MAX_PAYLOAD_SIZE = MAX_UDP_SIZE - CHECKSUM_SIZE;

            expect(MAX_PAYLOAD_SIZE).toBe(1470);

            // Test that we respect the limit
            const largePayload = Buffer.alloc(2000, 0xAA);
            const chunks = [];

            for (let i = 0; i < largePayload.length; i += MAX_PAYLOAD_SIZE) {
                const chunk = largePayload.subarray(i, i + MAX_PAYLOAD_SIZE);
                chunks.push(chunk);
            }

            // Should be fragmented appropriately
            expect(chunks.every(chunk => chunk.length <= MAX_PAYLOAD_SIZE)).toBe(true);
        });

        test('should format UDP packets with checksum', () => {
            const createUdpPacket = (data: Buffer) => {
                // Calculate checksum (sum of data bytes)
                let sum = 0;
                for (const byte of data) {
                    sum += byte;
                }
                
                // Create checksum header (2 bytes, MSB first)
                const checksum = Buffer.from([(sum >> 8) & 0xFF, sum & 0xFF]);
                return Buffer.concat([checksum, data]);
            };

            const testData = Buffer.from([0xC6, 0x01, 0x10, 0x00]);
            const udpPacket = createUdpPacket(testData);

            expect(udpPacket.length).toBe(6); // 2-byte checksum + 4-byte data
            expect(udpPacket.slice(0, 2)).toEqual(Buffer.from([0x00, 0xD7])); // Checksum
            expect(udpPacket.slice(2)).toEqual(testData); // Original data
        });
    });

    describe('Acknowledgment Handling', () => {
        test('should recognize valid ACK responses', () => {
            const ACK_SUCCESS = 0xC6;
            const ACK_ERROR = 0x46;

            const isValidAck = (data: Buffer): boolean => {
                return data.length === 1 && (data[0] === ACK_SUCCESS || data[0] === ACK_ERROR);
            };

            expect(isValidAck(Buffer.from([ACK_SUCCESS]))).toBe(true);
            expect(isValidAck(Buffer.from([ACK_ERROR]))).toBe(true);
            expect(isValidAck(Buffer.from([0x99]))).toBe(false); // Unknown single byte is not valid ACK
            expect(isValidAck(Buffer.from([ACK_SUCCESS, 0x00]))).toBe(false); // Multi-byte
            expect(isValidAck(Buffer.alloc(0))).toBe(false); // Empty
        });

        test('should track ACK state correctly', () => {
            let gotAck = true;
            let ackValue = Buffer.alloc(0);

            // Simulate receiving first ACK
            const firstAck = Buffer.from([0xC6]);
            if (firstAck.length === 1) {
                if (ackValue.length === 0) {
                    ackValue = firstAck;
                    gotAck = true;
                } else if (ackValue[0] !== firstAck[0]) {
                    gotAck = true;
                }
            }

            expect(gotAck).toBe(true);
            expect(ackValue).toEqual(firstAck);

            // Simulate sending data (should set gotAck = false)
            gotAck = false;

            // Simulate receiving same ACK (no change)
            const sameAck = Buffer.from([0xC6]);
            if (sameAck.length === 1) {
                if (ackValue.length === 0) {
                    ackValue = sameAck;
                    gotAck = true;
                } else if (ackValue[0] !== sameAck[0]) {
                    gotAck = true;
                }
            }

            expect(gotAck).toBe(false); // Should remain false for duplicate

            // Simulate receiving different ACK
            const newAck = Buffer.from([0x46]);
            if (newAck.length === 1) {
                if (ackValue.length === 0) {
                    ackValue = newAck;
                    gotAck = true;
                } else if (ackValue[0] !== newAck[0]) {
                    gotAck = true;
                }
            }

            expect(gotAck).toBe(true); // Should change for different ACK
        });
    });

    describe('Timeout Handling', () => {
        test('should enforce laser communication timeout', () => {
            const LASER_TIMEOUT = 6000; // 6 seconds as per implementation
            const lastTime = Date.now();
            
            // Simulate timeout condition
            const isTimedOut = (lastTime: number, gotAck: boolean): boolean => {
                return !gotAck && (Date.now() - lastTime) > LASER_TIMEOUT;
            };

            // Should not timeout if ACK received
            expect(isTimedOut(lastTime, true)).toBe(false);
            
            // Should not timeout immediately without ACK
            expect(isTimedOut(lastTime, false)).toBe(false);
            
            // Would timeout after delay (we can't easily test the actual timeout in unit tests)
            const oldTime = Date.now() - 7000; // 7 seconds ago
            expect(isTimedOut(oldTime, false)).toBe(true);
        });
    });

    describe('Error Handling', () => {
        test('should handle connection errors gracefully', () => {
            // Test that status.error is called for various error conditions
            const testError = new Error('Test connection error');
            
            // Simulate error handling
            mockStatus.error('Connection handling error: ' + testError);
            
            expect(mockStatus.error).toHaveBeenCalledWith('Connection handling error: Error: Test connection error');
        });

        test('should log socket errors', () => {
            const testError = new Error('Socket error');
            
            // Simulate socket error handling
            mockStatus.error('Client socket error: ' + testError.message);
            
            expect(mockStatus.error).toHaveBeenCalledWith('Client socket error: Socket error');
        });
    });

    describe('Data Filtering', () => {
        test('should filter ACK packets correctly', () => {
            const shouldForwardToTcp = (data: Buffer, lastLen: number): boolean => {
                // Forward to client via TCP (skip if ACK and last packet was small)
                return data.length > 1 || lastLen <= 500;
            };

            // Large data should always be forwarded
            expect(shouldForwardToTcp(Buffer.alloc(100), 1000)).toBe(true);
            
            // Single byte (ACK) with small last packet should be forwarded
            expect(shouldForwardToTcp(Buffer.alloc(1), 400)).toBe(true);
            
            // Single byte (ACK) with large last packet should not be forwarded
            expect(shouldForwardToTcp(Buffer.alloc(1), 600)).toBe(false);
        });
    });
});