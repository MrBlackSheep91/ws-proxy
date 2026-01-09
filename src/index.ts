/**
 * WebSocket Proxy Server
 *
 * Purpose: SSL termination for VPS WebSocket connection
 * Flow: Browser (wss://) → Railway Proxy → VPS (ws://)
 *
 * Railway provides automatic SSL via Let's Encrypt
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';

const PORT = parseInt(process.env.PORT || '3000', 10);
const VPS_WS_URL = process.env.VPS_WS_URL || 'ws://159.223.170.27:8002';

// Connection tracking
interface ConnectionStats {
  activeConnections: number;
  totalConnections: number;
  lastActivity: Date;
}

const stats: ConnectionStats = {
  activeConnections: 0,
  totalConnections: 0,
  lastActivity: new Date(),
};

// HTTP server for health checks
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      connections: stats.activeConnections,
      totalConnections: stats.totalConnections,
      lastActivity: stats.lastActivity.toISOString(),
    }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs: WebSocket, req: IncomingMessage) => {
  stats.activeConnections++;
  stats.totalConnections++;
  stats.lastActivity = new Date();

  // Parse URL to extract symbol and timeframe
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathParts = url.pathname.split('/').filter(Boolean);

  // Expected path: /ws/tick/EURUSD or /ws/tick/BTCUSD
  const symbol = pathParts[2] || 'EURUSD';
  const timeframe = url.searchParams.get('timeframe') || '1';

  // VPS symbols have a suffix (e.g., EURUSD-)
  // Add suffix if not already present
  const vpsSymbol = symbol.endsWith('-') ? symbol : `${symbol}-`;

  console.log(`[Proxy] New connection: ${symbol} -> ${vpsSymbol} TF:${timeframe} (active: ${stats.activeConnections})`);

  // Connect to VPS WebSocket with suffixed symbol
  const vpsUrl = `${VPS_WS_URL}/ws/tick/${vpsSymbol}?timeframe=${timeframe}`;
  let vpsWs: WebSocket | null = null;
  let isClosing = false;

  const connectToVps = () => {
    if (isClosing) return;

    try {
      vpsWs = new WebSocket(vpsUrl);

      vpsWs.on('open', () => {
        console.log(`[Proxy] VPS connected for ${symbol}`);
      });

      vpsWs.on('message', (data: Buffer | string) => {
        stats.lastActivity = new Date();
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data.toString());
        }
      });

      vpsWs.on('close', (code: number) => {
        console.log(`[Proxy] VPS disconnected for ${symbol} (code: ${code})`);
        if (!isClosing && clientWs.readyState === WebSocket.OPEN) {
          // Try to reconnect after 2 seconds
          setTimeout(connectToVps, 2000);
        }
      });

      vpsWs.on('error', (err: Error) => {
        console.error(`[Proxy] VPS error for ${symbol}:`, err.message);
        vpsWs?.close();
      });

    } catch (err) {
      console.error(`[Proxy] Failed to connect to VPS for ${symbol}:`, err);
    }
  };

  // Initial connection
  connectToVps();

  // Forward client messages to VPS (heartbeat responses)
  clientWs.on('message', (data: Buffer | string) => {
    if (vpsWs?.readyState === WebSocket.OPEN) {
      vpsWs.send(data.toString());
    }
  });

  // Handle client disconnect
  clientWs.on('close', () => {
    isClosing = true;
    stats.activeConnections--;
    console.log(`[Proxy] Client disconnected: ${symbol} (active: ${stats.activeConnections})`);
    vpsWs?.close();
  });

  // Handle client errors
  clientWs.on('error', (err: Error) => {
    console.error(`[Proxy] Client error for ${symbol}:`, err.message);
    isClosing = true;
    vpsWs?.close();
  });

  // Send initial ping to verify connection
  setTimeout(() => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send('ping');
    }
  }, 1000);
});

// Heartbeat to keep connections alive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('ping');
    }
  });
}, 30000); // Every 30 seconds

// Start server
server.listen(PORT, () => {
  console.log(`[WS Proxy] Running on port ${PORT}`);
  console.log(`[WS Proxy] VPS target: ${VPS_WS_URL}`);
  console.log(`[WS Proxy] Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[WS Proxy] Shutting down...');
  wss.clients.forEach((ws) => ws.close());
  server.close(() => {
    console.log('[WS Proxy] Server closed');
    process.exit(0);
  });
});
