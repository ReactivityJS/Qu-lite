/**
 * WEBSOCKET SERVER (Node) - accepts peers and attaches each socket to the
 * bus exactly like a client connection (ws.js). Import from
 * `@qu/lite/ws-server` - it needs the `ws` package, browsers never load it.
 */
import { WebSocketServer } from 'ws';
import { attachSocket } from './ws.js';

/**
 * @param {{bus: import('@qu/events').EventBus, peerId: string}} qu
 * @param {{port?: number, host?: string, server?: import('node:http').Server, path?: string}} [options]
 * @returns {Promise<{port: number, close: () => Promise<void>, wss: WebSocketServer}>}
 */
export async function listenWs(qu, { port = 0, host, server, path } = {}) {
  const wss = new WebSocketServer(server ? { server, path } : { port, host, path });
  wss.on('connection', (socket) => attachSocket(qu, socket, { via: 'ws-server' }));
  if (!server) await new Promise((resolve, reject) => wss.once('listening', resolve).once('error', reject));
  return {
    wss,
    port: server ? server.address().port : wss.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}
