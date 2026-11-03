import assert from 'node:assert/strict';
import test from 'node:test';
import { GameManager } from '../src/session.js';
import { TableManager, assignColors, pairKey, pickPair, rotateQueue } from '../src/table.js';
import { buttons, FakeManager, fakeLichess, gameInfo, scriptedLichess, seeded } from './helpers/fakes.js';

const KEEP_ORDER = () => 0.9999; // shuffle não troca nada; empate de cor = brancas para o segundo da dupla
const tally = (w, b, wg = 0, bg = 0) => ({ w: { sips: w, glasses: wg }, b: { sips: b, glasses: bg } });

function setup({ format = 'rei', random = KEEP_ORDER, players = ['A', 'B', 'C'] } = {}) {
  const posts = [];
  const manager = new FakeManager();
  const lichess = fakeLichess();
  const tables = new TableManager({ manager, lichess, send: async (_c, p) => posts.push(p), random, challengeWaitMs: 60_000 });
  const [host, ...rest] = players;
  const { table } = tables.open({ channelId: 'c1', host: { id: host, name: host }, format, clockKey: '3+2' });
  for (const id of rest) table.join({ id, name: id });
  return { posts, manager, lichess, tables, table };
}

test('funções de pareamento', () => {
  const stats = new Map(['A', 'B', 'C'].map((id) => [id, { turns: 0, lastPlayed: 0, whites: 0 }]));
  const seated = new Set(['A', 'B', 'C']);
  assert.deepEqual(pickPair({ format: 'rei', queue: ['C', 'A', 'B'], seated, stats }), ['C', 'A']);
  assert.equal(pickPair({ format: 'rei', queue: ['C', 'X'], seated, stats }), null, 'quem saiu não conta');
  assert.deepEqual(rotateQueue(['A', 'B', 'C', 'D'], { white: 'A', black: 'B', winner: 'B' }), ['B', 'C', 'D', 'A']);
  assert.deepEqual(rotateQueue(['A', 'B', 'C'], { white: 'A', black: 'B', winner: null }), ['C', 'A', 'B']);
  stats.get('A').whites = 2;
  assert.deepEqual(assignColors(['A', 'B'], stats), { white: 'B', black: 'A' }, 'brancas para quem jogou menos de brancas');
  stats.get('A').turns = 1;
  stats.get('B').turns = 1;
  const faced = new Map([[pairKey('C', 'A'), 3]]);
  assert.deepEqual(pickPair({ format: 'rodizio', queue: [], seated, stats, faced, random: KEEP_ORDER }), ['C', 'B'],
    'rodízio: quem jogou menos entra, contra quem enfrentou menos');
});

test('quem ganha fica: sorteio inicial, links privados, vencedor fica e placar no fim', async () => {
  const { posts, manager, lichess, table } = setup();
  assert.equal(await table.start(), true);
  const g1 = table.current;
  assert.deepEqual([g1.white, g1.black], ['B', 'A']);
  assert.deepEqual(lichess.calls[0], { clockLimit: 180, clockIncrement: 2, expiresInMs: 60_000, name: 'Beer Chess - partida 1' });
  assert.equal(manager.last.opts.pingStart, false, 'quem joga já foi chamado no post da dupla');
  assert.deepEqual(manager.last.opts.players, { w: { discordId: 'B' }, b: { discordId: 'A' } });

  const post1 = posts[0];
  assert.match(post1.content, /Partida 1\*\* · quem ganha fica · 3\+2/);
  assert.match(post1.content, /⬜ <@B> \*\*x\*\* ⬛ <@A>/);
  assert.match(post1.content, /⏳ Na fila: <@C>/);
  assert.deepEqual(post1.allowedMentions, { users: ['B', 'A'] });
  const [meuLink, assistir, entrar, sair, encerrar] = buttons(post1);
  assert.equal(meuLink.custom_id, `bc:l:${table.id}:Game0001`);
  assert.equal(assistir.url, 'https://lichess.org/Game0001');
  assert.deepEqual([entrar, sair, encerrar].map((b) => b.custom_id), ['entrar', 'sair', 'encerrar'].map((a) => `bc:m:${table.id}:${a}:P`));

  // A (pretas) vence: fica na mesa; B vai para o fim da fila; C entra
  manager.last.end('b', tally(4, 2, 1, 0));
  await table.idle();
  const g2 = table.current;
  assert.equal(g2.number, 2);
  assert.deepEqual(new Set([g2.white, g2.black]), new Set(['A', 'C']));
  assert.match(posts[1].content, /👑 <@A> segue na mesa: 1 vitória/);
  assert.match(posts[1].content, /⏳ Na fila: <@B>/);
  assert.deepEqual(table.stats.get('B'), { ...table.stats.get('B'), games: 1, losses: 1, sips: 4, glasses: 1, whites: 1 });

  // C vence: A vai para o fim; C x B
  manager.last.end(g2.white === 'C' ? 'w' : 'b');
  await table.idle();
  assert.deepEqual(new Set([table.current.white, table.current.black]), new Set(['C', 'B']));
  assert.deepEqual(table.king, { id: 'C', streak: 1 });

  // empate: os dois para o fim da fila → A entra contra o primeiro deles
  manager.last.end(null, tally(3, 3));
  await table.idle();
  assert.equal(table.king, null);
  assert.ok([table.current.white, table.current.black].includes('A'));

  // pedem para encerrar com a partida 4 rolando: ela é a última
  manager.last.begin();
  const res = table.close({ by: 'B' });
  assert.deepEqual(res, { ok: true, closing: true });
  assert.equal(table.join({ id: 'D' }).ok, false);
  await table.idle();
  assert.match(posts[posts.length - 1].content, /<@B> pediu para encerrar: a partida 4 é a última/);
  manager.last.end('w');
  await table.idle();
  assert.equal(table.status, 'encerrada');
  assert.equal(lichess.calls.length, 4, 'não cria partida 5');
  const summary = posts[posts.length - 1].content;
  assert.match(summary, /Mesa encerrada\*\* depois de 4 partidas/);
  assert.match(summary, /🏆 Vitórias:/);
  assert.match(summary, /🍺 Goles: <@B> 7 goles \+ 1 copo/);
});

test('quem sai antes de começar: refaz a dupla; com menos de 2 pausa e volta sozinho', async () => {
  const { posts, manager, table } = setup();
  await table.start();
  const first = manager.last;
  assert.deepEqual(table.leave('A'), { ok: true, playing: true, cancelled: true });
  assert.equal(first.status, 'stopped');
  await table.idle();
  assert.match(posts[1].content, /🚪 <@A> saiu antes da partida 1 começar, então refiz a dupla/);
  assert.deepEqual(new Set([table.current.white, table.current.black]), new Set(['B', 'C']));

  table.leave('B');
  await table.idle();
  assert.equal(table.status, 'pausada');
  assert.match(posts[2].content, /precisa de pelo menos 2 jogadores/);

  const res = table.join({ id: 'D' });
  assert.equal(res.ok, true);
  await table.idle();
  assert.equal(table.status, 'jogando');
  assert.deepEqual(new Set([table.current.white, table.current.black]), new Set(['C', 'D']));
});

test('se alguém sai enquanto a partida é criada no Lichess, refaz a dupla', async () => {
  const { posts, lichess, table } = setup();
  const original = lichess.createOpenChallenge.bind(lichess);
  let first = true;
  lichess.createOpenChallenge = async (opts) => {
    const challenge = await original(opts);
    if (first) {
      first = false;
      table.leave('A');
    }
    return challenge;
  };
  await table.start();
  assert.deepEqual(new Set([table.current.white, table.current.black]), new Set(['B', 'C']));
  assert.equal(table.current.number, 1);
  assert.equal(posts.length, 1);
});

test('quem sai no meio da partida termina ela e fica de fora depois', async () => {
  const { manager, table } = setup();
  await table.start();
  manager.last.begin();
  assert.deepEqual(table.leave('A'), { ok: true, playing: true, cancelled: false });
  assert.equal(manager.last.status, 'live');
  manager.last.end('b'); // A (pretas) venceu, mas já saiu
  await table.idle();
  assert.equal(table.stats.get('A').wins, 1);
  assert.deepEqual(new Set([table.current.white, table.current.black]), new Set(['B', 'C']));
});

test('ninguém entrou / abortada / limite / erro do Lichess: pausa e Continuar retoma', async () => {
  const { posts, manager, lichess, table } = setup();
  await table.start();
  manager.last.expire();
  await table.idle();
  assert.equal(table.status, 'pausada');
  assert.match(posts[1].content, /Ninguém entrou na partida 1 a tempo/);
  const continuar = buttons(posts[1]).find((b) => b.custom_id.endsWith(':comecar:P'));
  assert.equal(continuar.label, 'Continuar');
  assert.equal(continuar.disabled, false);

  await table.start();
  assert.equal(table.current.number, 2);
  manager.last.end('aborted');
  await table.idle();
  assert.match(posts[posts.length - 1].content, /foi abortada/);
  assert.equal(table.played, 0, 'abortada não conta');

  manager.room = false;
  await table.start();
  assert.match(posts[posts.length - 1].content, /máximo de partidas/);

  manager.room = true;
  lichess.fail = Object.assign(new Error('Lichess fora do ar'), { status: 503 });
  await table.start();
  assert.match(posts[posts.length - 1].content, /Não consegui criar a partida no Lichess \(Lichess fora do ar\)/);

  lichess.fail = null;
  await table.start();
  assert.equal(table.status, 'jogando');
});

test('rodízio: todo mundo joga parecido, contra todo mundo, e quem chega depois não joga em sequência', async () => {
  const { manager, table } = setup({ format: 'rodizio', random: seeded(7) });
  const outcome = seeded(99);
  await table.start();
  for (let i = 0; i < 30; i += 1) {
    const r = outcome();
    manager.last.end(r < 0.45 ? 'w' : r < 0.9 ? 'b' : null);
    await table.idle();
  }
  const games = ['A', 'B', 'C'].map((id) => table.stats.get(id).games);
  assert.ok(Math.max(...games) - Math.min(...games) <= 1, `partidas por pessoa: ${games}`);
  for (const [a, b] of [['A', 'B'], ['A', 'C'], ['B', 'C']]) {
    const n = table.faced.get(pairKey(a, b));
    assert.ok(n >= 8 && n <= 12, `${a}x${b} jogaram ${n} vezes`);
  }
  const whites = ['A', 'B', 'C'].map((id) => table.stats.get(id).whites);
  assert.ok(Math.max(...whites) - Math.min(...whites) <= 2, `brancas: ${whites}`);

  table.join({ id: 'D' });
  const seq = [];
  for (let i = 0; i < 8; i += 1) {
    seq.push([table.current.white, table.current.black].includes('D'));
    manager.last.end('w');
    await table.idle();
  }
  assert.equal(seq.filter(Boolean).length, 4, `D jogou ${seq.filter(Boolean).length} de 8`);
  assert.ok(!seq.some((d, i) => d && seq[i + 1] && seq[i + 2]), 'D não joga 3 seguidas');
});

test('encerrar antes de jogar e /parar com partida rolando', async () => {
  const { posts, manager, table, tables } = setup();
  await table.start();
  const pending = manager.last;
  assert.equal(table.close({ by: 'A' }).ok, true);
  await table.idle();
  assert.equal(pending.status, 'stopped');
  assert.match(posts[posts.length - 1].content, /Ninguém chegou a jogar/);
  assert.equal(tables.inChannel('c1'), null);

  const { table: t2 } = tables.open({ channelId: 'c1', host: { id: 'A' } });
  t2.join({ id: 'B' });
  await t2.start();
  manager.last.begin();
  const res = t2.close({ by: 'A', force: true, announce: false });
  assert.equal(res.ok, true);
  assert.equal(manager.last.status, 'stopped', 'força para a partida');
  assert.match(res.summary.content, /Mesa encerrada/);
  await t2.idle();
  assert.equal(t2.status, 'encerrada');
});

test('integração com GameSession de verdade: resultado do stream gira a mesa', async () => {
  const posts = [];
  const send = async (_c, p) => posts.push(p);
  const lichess = scriptedLichess();
  const manager = new GameManager({ lichess, send, timing: { pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20 } });
  const tables = new TableManager({ manager, lichess, send, random: KEEP_ORDER, challengeWaitMs: 60_000 });
  const { table } = tables.open({ channelId: 'c1', host: { id: 'A' }, format: 'rei' });
  table.join({ id: 'B' });
  table.join({ id: 'C' });
  await table.start();
  const g1 = table.current;
  const feed = lichess.feed(g1.gameId);
  feed.push(gameInfo(g1.gameId));
  feed.push(gameInfo(g1.gameId, { status: { id: 31, name: 'resign' }, winner: 'black' }));
  await g1.session.done;
  await table.idle();

  const start = posts.find((p) => p.content?.startsWith('♟️ **Começou!**'));
  assert.deepEqual(start.allowedMentions, { users: [] }, 'sem ping repetido no começo');
  const result = posts.find((p) => p.content?.includes('Abandono!'));
  assert.match(result.content, /<@A> venceu/);
  assert.match(result.content, /<@B> \*\*vira o copo!\*\*/);
  assert.equal(table.played, 1);
  assert.equal(table.current.number, 2);
  assert.deepEqual(new Set([table.current.white, table.current.black]), new Set(['A', 'C']));
  assert.match(posts[posts.length - 1].content, /Partida 2/);
  tables.shutdown();
  await manager.shutdown();
});
