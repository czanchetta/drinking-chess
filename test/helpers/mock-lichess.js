// Servidor HTTP falso que imita os endpoints do Lichess usados pelo bot.
import http from 'node:http';
import { Chess } from 'chess.js';
import { OPERA_GAME } from '../../src/demo.js';
import { START_FEN } from '../../src/engine.js';

/** Posições da Partida da Ópera no formato do stream: [{ fen, lm }] para cada meio-lance. */
export function operaPositions() {
  const chess = new Chess();
  return OPERA_GAME.moves.map((san) => {
    const move = chess.move(san);
    return { fen: chess.fen(), lm: move.lan };
  });
}

export function operaInfo(overrides = {}) {
  return {
    id: 'Opera858',
    variant: { key: 'standard', name: 'Standard', short: 'Std' },
    speed: 'blitz',
    perf: 'blitz',
    rated: false,
    initialFen: START_FEN,
    fen: START_FEN,
    player: 'white',
    turns: 0,
    startedAtTurn: 0,
    source: 'friend',
    status: { id: 20, name: 'started' },
    createdAt: 1_700_000_000_000,
    lastMove: '',
    players: { white: { user: { name: 'Morphy', id: 'morphy' } }, black: { user: { name: 'duque_conde', id: 'duque_conde' } } },
    ...overrides,
  };
}

/**
 * connections: um item por conexão ao stream, na ordem.
 *   { status: 404 } | { status: 429 }
 *   { lines: [obj | ''], end: 'close' | 'hang' }  ('' = keep-alive)
 * Depois de usar todas, repete a última.
 */
export async function startMockLichess({ connections = [], exportData = null, challenge = null } = {}) {
  const requests = [];
  let streamCount = 0;
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body });

    if (req.method === 'POST' && url.pathname === '/api/challenge/open') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(challenge ?? {
        id: 'Opera858', url: 'https://lichess.org/Opera858', status: 'created', challenger: null, destUser: null,
        rated: false, open: {}, urlWhite: 'https://lichess.org/Opera858?color=white', urlBlack: 'https://lichess.org/Opera858?color=black',
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/stream/game/')) {
      const conn = connections[Math.min(streamCount, connections.length - 1)] ?? { status: 404 };
      streamCount += 1;
      if (conn.status && conn.status !== 200) {
        res.writeHead(conn.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: conn.status === 404 ? 'Not found' : 'Too many requests' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const line of conn.lines ?? []) {
        if (res.destroyed) return;
        // quebra cada linha em dois pedaços para testar o leitor de NDJSON
        const text = line === '' ? '\n' : `${JSON.stringify(line)}\n`;
        const cut = Math.floor(text.length / 2);
        res.write(text.slice(0, cut));
        await new Promise((r) => setTimeout(r, 1));
        res.write(text.slice(cut));
      }
      if (conn.end !== 'hang') res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/game/export/')) {
      if (!exportData) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"Not found"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(exportData));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get streamCount() {
      return streamCount;
    },
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
