import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERA_GAME, demoFeed } from '../src/demo.js';
import { LichessClient } from '../src/lichess.js';
import { GameManager } from '../src/session.js';
import { operaInfo, operaPositions, startMockLichess } from './helpers/mock-lichess.js';

const FAST = { pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20, rateLimitMs: 20, idleMs: 2_000 };
const OPERA_EXPORT = { id: 'Opera858', status: 'mate', winner: 'white', moves: OPERA_GAME.moves.join(' ') };

function setup(mock, extra = {}) {
  const posts = [];
  const manager = new GameManager({
    lichess: new LichessClient({ baseUrl: mock.url }),
    send: async (channelId, payload) => posts.push({ channelId, ...payload }),
    timing: FAST,
    ...extra,
  });
  return { manager, posts };
}

const players = { w: { discordId: '111' }, b: { discordId: '222' } };

test('fluxo completo: espera o desafio, acompanha com atraso e completa o final pelo export', async () => {
  const pos = operaPositions();
  const finalInfo = operaInfo({ fen: pos[32].fen, turns: 33, status: { id: 30, name: 'mate' }, winner: 'white' });
  const mock = await startMockLichess({
    connections: [
      { status: 404 },
      { status: 404 },
      // stream "3 lances atrás": as posições 31–33 nunca chegam, só o resultado
      { lines: [operaInfo(), { fen: operaInfo().fen }, ...pos.slice(0, 30).flatMap((p) => [p, '']), finalInfo], end: 'close' },
    ],
    exportData: OPERA_EXPORT,
  });
  try {
    const { manager, posts } = setup(mock);
    const { session } = manager.watch({ gameId: 'Opera858', channelId: 'c1', players, clockLabel: '5+3' });
    await session.done;
    assert.equal(session.status, 'finished');
    assert.deepEqual(session.tally, { w: { sips: 25, glasses: 0 }, b: { sips: 18, glasses: 1 } });

    const start = posts[0];
    assert.match(start.content, /Começou!.*<@111> \(brancas\) x <@222> \(pretas\) · 5\+3 · casual/);
    assert.deepEqual(start.allowedMentions, { users: ['111', '222'] }, 'início pinga os dois');
    const turn = posts.find((p) => p.content.startsWith('`4... Bxf3`'));
    assert.match(turn.content, /<@111>: perdeu um cavalo ♞ → \*\*3 goles\*\*/);
    assert.deepEqual(turn.allowedMentions, { users: [] }, 'lance não pinga ninguém');

    const catchUp = posts[posts.length - 2].content;
    assert.match(catchUp, /`16\. Qb8\+`[\s\S]*levou xeque[\s\S]*`16\.\.\. Nxb8`[\s\S]*perdeu a dama/);
    const result = posts[posts.length - 1];
    assert.match(result.content, /Xeque-mate!\*\* <@111> venceu/);
    assert.match(result.content, /<@222> \*\*vira o copo!\*\*/);
    assert.match(result.content, /<@111> 25 goles · <@222> 18 goles \+ 1 copo/);
    assert.deepEqual(result.allowedMentions, { users: ['111', '222'] });
    assert.equal(mock.streamCount, 3);
    assert.equal(mock.requests.filter((r) => r.path.startsWith('/game/export/')).length, 1);
  } finally {
    await mock.close();
  }
});

test('reconecta quando o stream cai e conta as peças que sumiram no meio tempo', async () => {
  const pos = operaPositions();
  const mock = await startMockLichess({
    connections: [
      { lines: [operaInfo(), ...pos.slice(0, 18)], end: 'close' },
      {
        lines: [
          operaInfo({ fen: pos[21].fen, turns: 22 }), // voltou já no lance 22
          ...pos.slice(22),
          operaInfo({ fen: pos[32].fen, turns: 33, status: { id: 30, name: 'mate' }, winner: 'white' }),
        ],
        end: 'close',
      },
    ],
    exportData: null, // export indisponível: segue só pelo FEN
  });
  try {
    const { manager, posts } = setup(mock);
    const { session } = manager.watch({ gameId: 'Opera858', channelId: 'c1', players: {} });
    await session.done;
    // 19.Nxb5 cxb5 20.Bxb5+ Nbd7 caíram no buraco: conta 2 peões das pretas e 1 cavalo das brancas,
    // mas o xeque do lance 21 se perde.
    assert.deepEqual(session.tally, { w: { sips: 25, glasses: 0 }, b: { sips: 17, glasses: 1 } });
    const jump = posts.find((p) => p.content.includes('alguns lances depois'));
    assert.match(jump.content, /\*\*Morphy\*\*: perdeu um cavalo/);
    assert.match(jump.content, /\*\*duque\\_conde\*\*: perdeu 2 peões/);
    assert.equal(mock.streamCount, 2);
  } finally {
    await mock.close();
  }
});

test('desiste se ninguém entra no desafio', async () => {
  const mock = await startMockLichess({ connections: [{ status: 404 }] });
  try {
    const { manager, posts } = setup(mock);
    const { session } = manager.watch({ gameId: 'Opera858', channelId: 'c1', players, waitForStartMs: 60 });
    await session.done;
    assert.equal(session.status, 'expired');
    assert.equal(posts.length, 1);
    assert.match(posts[0].content, /Parei de esperar/);
    assert.equal(manager.activeCount, 0);
  } finally {
    await mock.close();
  }
});

test('429 espera e tenta de novo', async () => {
  const pos = operaPositions();
  const mock = await startMockLichess({
    connections: [
      { status: 429 },
      { lines: [operaInfo(), ...pos, operaInfo({ fen: pos[32].fen, status: { id: 30, name: 'mate' }, winner: 'white' })], end: 'close' },
    ],
    exportData: OPERA_EXPORT,
  });
  try {
    const { manager } = setup(mock);
    const { session } = manager.watch({ gameId: 'Opera858', channelId: 'c1', players });
    await session.done;
    assert.equal(session.status, 'finished');
    assert.deepEqual(session.tally.b, { sips: 18, glasses: 1 });
  } finally {
    await mock.close();
  }
});

test('variante não suportada e partida já encerrada não contam nada', async () => {
  const mock = await startMockLichess({
    connections: [
      { lines: [operaInfo({ variant: { key: 'crazyhouse', name: 'Crazyhouse' } })], end: 'hang' },
      { lines: [operaInfo({ status: { id: 31, name: 'resign' }, winner: 'black' })], end: 'hang' },
    ],
  });
  try {
    const { manager, posts } = setup(mock);
    const a = manager.watch({ gameId: 'Crazy001', channelId: 'c1', players }).session;
    await a.done;
    const b = manager.watch({ gameId: 'Done0001', channelId: 'c1', players }).session;
    await b.done;
    assert.match(posts[0].content, /Crazyhouse/);
    assert.match(posts[1].content, /já terminou/);
    assert.equal(a.status, 'stopped');
    assert.equal(b.status, 'stopped');
    assert.deepEqual(b.tally, { w: { sips: 0, glasses: 0 }, b: { sips: 0, glasses: 0 } });
  } finally {
    await mock.close();
  }
});

test('parar interrompe a partida e libera vaga; limite de partidas simultâneas', async () => {
  const mock = await startMockLichess({ connections: [{ lines: [operaInfo()], end: 'hang' }] });
  try {
    const { manager, posts } = setup(mock, { maxGames: 1 });
    const { session } = manager.watch({ gameId: 'Opera858', channelId: 'c1', players });
    assert.throws(() => manager.watch({ gameId: 'Outra001', channelId: 'c1', players }), { code: 'LIMIT' });
    assert.equal(manager.watch({ gameId: 'Opera858', channelId: 'c1', players }).existing, true);
    while (!session.started) await new Promise((r) => setTimeout(r, 5));
    assert.equal(manager.stop('c1'), 1);
    await session.done;
    assert.equal(session.status, 'stopped');
    assert.equal(manager.activeCount, 0);
    assert.equal(posts.length, 1, 'só a mensagem de início');
  } finally {
    await mock.close();
  }
});

test('demo + placar da noite', async () => {
  const posts = [];
  const manager = new GameManager({ lichess: { gameUrl: (id) => `https://lichess.org/${id}` }, send: async (c, p) => posts.push(p), timing: FAST });
  const { session } = manager.demo({ channelId: 'c9', feed: demoFeed({ delayMs: 0 }) });
  assert.equal(manager.demo({ channelId: 'c9', feed: demoFeed({ delayMs: 0 }) }).existing, true);
  await session.done;
  assert.equal(manager.activeCount, 0, 'demo não ocupa vaga de stream');
  assert.equal(posts.length, 16);
  const board = manager.scoreboard('c9');
  assert.equal(board.games.length, 1);
  assert.equal(board.games[0].demo, true);
  assert.deepEqual(board.night, [], 'demo não entra no placar da noite');

  // duas partidas "de verdade" com os mesmos amigos somam no placar da noite
  for (const [id, tally] of [['Game0001', { w: 3, b: 7 }], ['Game0002', { w: 10, b: 1 }]]) {
    const fake = manager.demo({ channelId: 'c10', feed: { async *stream() {} } }).session;
    fake.stop();
    fake.demo = false;
    fake.started = true;
    fake.gameId = id;
    fake.players = { w: { discordId: id === 'Game0001' ? '111' : '222' }, b: { discordId: id === 'Game0001' ? '222' : '111' } };
    fake.engine.tally = { w: { sips: tally.w, glasses: 0 }, b: { sips: tally.b, glasses: id === 'Game0001' ? 1 : 0 } };
    manager.sessions.delete(fake.key);
    manager.sessions.set(`c10:${id}`, fake);
  }
  const night = manager.scoreboard('c10').night;
  assert.deepEqual(night.map((r) => [r.label, r.sips, r.glasses]), [['<@222>', 17, 1], ['<@111>', 4, 0]]);
});
