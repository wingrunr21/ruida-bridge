import type { Status } from './types.ts';

export interface StatusData {
    status: string;
    uptime: number;
    version: [number, number];
    laser_ip: string;
    server_port: number;
    connections: {
        current: number;
        queued: number;
        processing: boolean;
    };
    timestamp: string;
}

export class StatusServer {
    private server: any = null;
    private status: Status;
    private startTime: Date;

    constructor(status: Status) {
        this.status = status;
        this.startTime = new Date();
    }

    start(getStatusData: () => StatusData): void {
        this.server = Bun.serve({
            // Let Bun handle PORT and HOST environment variables natively
            fetch: (request) => {
                const url = new URL(request.url);
                
                if (url.pathname === '/status') {
                    const statusData = getStatusData();
                    return new Response(JSON.stringify(statusData, null, 2), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                
                return new Response('Not Found', { status: 404 });
            }
        });

        this.status.info(`Status server started on ${this.server.hostname}:${this.server.port}`);
    }

    stop(): void {
        if (this.server) {
            this.server.stop();
        }
    }

    getUptime(): number {
        return Math.floor((Date.now() - this.startTime.getTime()) / 1000);
    }
}