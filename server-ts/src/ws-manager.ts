/** WebSocket connection manager — port of server/ws_manager.py.
 *
 * Holds a Set of active @fastify/websocket connections and broadcasts JSON
 * payloads to all of them. Failed sends are removed from the set on the
 * next pass; @fastify/websocket already emits close events so we remove
 * eagerly there too. */

import type { WebSocket } from "@fastify/websocket";

class ConnectionManager {
  private active = new Set<WebSocket>();

  connect(ws: WebSocket): void {
    this.active.add(ws);
    ws.on("close", () => this.disconnect(ws));
    ws.on("error", () => this.disconnect(ws));
  }

  disconnect(ws: WebSocket): void {
    this.active.delete(ws);
  }

  broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const ws of this.active) {
      try {
        ws.send(payload);
      } catch {
        this.active.delete(ws);
      }
    }
  }

  size(): number {
    return this.active.size;
  }
}

export const manager = new ConnectionManager();
