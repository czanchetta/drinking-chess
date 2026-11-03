import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { LichessClient, LichessError, parseGameId, readNdjson } from '../src/lichess.js';
import { operaInfo, startMockLichess } from './helpers/mock-lichess.js';

test('parseGameId entende links, links de jogador e códigos', () => {
  const cases = {
    'https://lichess.org/AbCdEfGh': 'AbCdEfGh',
    'https://lichess.org/AbCdEfGh/black': 'AbCdEfGh',
    'lichess.org/AbCdEfGhIjKl': 'AbCdEfGh',
    'https://lichess.org/AbCdEfGh?color=white': 'AbCdEfGh',
    'https://lichess.org/embed/game/AbCdEfGh?theme=auto': 'AbCdEfGh',
    '  AbCdEfGh  ': 'AbCdEfGh',
    'https://lichess.org/@/fulano': null,
    'https://example.com/AbCdEfGh': null,
    'curto': null,
    '': null,
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(parseGameId(input), expected, input);
});

test('readNdjson junta pedaços, pula keep-alive e linhas quebradas', async () => {
  const enc = new TextEncoder();
  async function* chunks() {
    yield enc.encode('{"a":');
    yield enc.encode('1}\n\n');
    yield enc.encode('lixo\n{"b":2}\n{"c"');
    yield enc.encode(':3}');
  }
  const out = [];
  for await (const obj of readNdjson(chunks())) out.push(obj);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('createOpenChallenge cria desafio casual e devolve os links das cores', async () => {
  const mock = await startMockLichess();
  try {
    const client = new LichessClient({ baseUrl: mock.url, userAgent: 'teste/1.0' });
    const ch = await client.createOpenChallenge({ clockLimit: 300, clockIncrement: 3, expiresInMs: 60_000 });
    assert.equal(ch.id, 'Opera858');
    assert.match(ch.urlWhite, /color=white$/);
    assert.match(ch.urlBlack, /color=black$/);
    const req = mock.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['user-agent'], 'teste/1.0');
    assert.equal(req.headers.authorization, undefined, 'sem token não manda Authorization');
    const form = new URLSearchParams(req.body);
    assert.equal(form.get('rated'), 'false');
    assert.equal(form.get('clock.limit'), '300');
    assert.equal(form.get('clock.increment'), '3');
    assert.equal(form.get('variant'), 'standard');
    assert.equal(form.get('rules'), 'noRematch');
    assert.ok(Number(form.get('expiresAt')) > Date.now());

    await client.createOpenChallenge({ clockLimit: null });
    const unlimited = new URLSearchParams(mock.requests[1].body);
    assert.equal(unlimited.has('clock.limit'), false, 'sem relógio = sem clock.limit');
  } finally {
    await mock.close();
  }
});

test('streamGame entrega as mensagens; 404 e 429 viram LichessError com status', async () => {
  const info = operaInfo();
  const mock = await startMockLichess({
    connections: [
      { lines: [info, '', { fen: 'x', lm: 'e2e4' }], end: 'close' },
      { status: 404 },
      { status: 429 },
    ],
  });
  try {
    const client = new LichessClient({ baseUrl: mock.url, token: 'segredo' });
    const got = [];
    for await (const msg of client.streamGame('Opera858')) got.push(msg);
    assert.deepEqual(got, [info, { fen: 'x', lm: 'e2e4' }]);
    assert.equal(mock.requests[0].headers.authorization, 'Bearer segredo');
    for (const status of [404, 429]) {
      await assert.rejects(async () => {
        for await (const _ of client.streamGame('Opera858')) { /* nada */ }
      }, (err) => err instanceof LichessError && err.status === status);
    }
  } finally {
    await mock.close();
  }
});

test('streamGame derruba conexão parada (sem keep-alive) para reconectar', async () => {
  const mock = await startMockLichess({ connections: [{ lines: [operaInfo()], end: 'hang' }] });
  try {
    const client = new LichessClient({ baseUrl: mock.url });
    const got = [];
    await assert.rejects(async () => {
      for await (const msg of client.streamGame('Opera858', { idleMs: 150 })) got.push(msg);
    }, (err) => err instanceof LichessError && /parado/.test(err.message));
    assert.equal(got.length, 1);
  } finally {
    await mock.close();
  }
});

test('streamGame termina quieto quando o sinal é abortado', async () => {
  const mock = await startMockLichess({ connections: [{ lines: [operaInfo()], end: 'hang' }] });
  try {
    const client = new LichessClient({ baseUrl: mock.url });
    const ctrl = new AbortController();
    const got = [];
    for await (const msg of client.streamGame('Opera858', { signal: ctrl.signal })) {
      got.push(msg);
      ctrl.abort();
    }
    assert.equal(got.length, 1);
  } finally {
    await mock.close();
  }
});

test('exportGame devolve lances SAN, status e vencedor', async () => {
  const mock = await startMockLichess({ exportData: { id: 'Opera858', status: 'mate', winner: 'white', moves: 'e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#' } });
  try {
    const client = new LichessClient({ baseUrl: mock.url });
    const game = await client.exportGame('Opera858');
    assert.deepEqual(game.moves, ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
    assert.equal(game.status, 'mate');
    assert.equal(game.winner, 'white');
    assert.match(mock.requests[0].search, /moves=true/);
    assert.equal(mock.requests[0].headers.accept, 'application/json');
  } finally {
    await mock.close();
  }
});

test('erro de rede vira LichessError com status 0', async () => {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  const client = new LichessClient({ baseUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(client.createOpenChallenge(), (err) => err instanceof LichessError && err.status === 0);
});
