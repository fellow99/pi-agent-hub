import type { Response } from "express";

interface Client {
  hostId: string;
  response: Response;
}

export class SseHub {
  private readonly clients: Client[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => {
      for (const client of this.clients) client.response.write(`: hb ${Date.now()}\n\n`);
    }, 15_000);
    this.timer.unref();
  }

  add(hostId: string, response: Response): void {
    for (const client of this.clients.filter((candidate) => candidate.hostId === hostId)) {
      client.response.write("event: reset\ndata: {\"reason\":\"superseded\"}\n\n");
      client.response.end();
    }
    const client = { hostId, response };
    this.clients.push(client);
    response.on("close", () => {
      const index = this.clients.indexOf(client);
      if (index >= 0) this.clients.splice(index, 1);
    });
  }

  send(hostId: string, event: string, data: unknown): boolean {
    const targets = this.clients.filter((client) => client.hostId === hostId);
    for (const client of targets) {
      client.response.write(`id: ${Date.now()}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    return targets.length > 0;
  }

  size(): number {
    return this.clients.length;
  }
}
