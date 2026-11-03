import assert from 'node:assert/strict';
import test from 'node:test';
import { Chess } from 'chess.js';
import { OPERA_GAME } from '../src/demo.js';
import { BeerEngine, START_FEN, absPlyFromFen, countPieces, uciToMove } from '../src/engine.js';

function fensAfter(sans, from = START_FEN) {
  const chess = new Chess(from);
  return sans.map((san) => {
    const move = chess.move(san);
    return { fen: chess.fen(), lm: move.lan, san: move.san };
  });
}

function playOpera(intensity = 'normal') {
  const engine = new BeerEngine({ intensity });
  engine.start({ fen: START_FEN });
  const reports = fensAfter(OPERA_GAME.moves).map((p) => engine.position({ fen: p.fen, uci: p.lm }));
  const final = engine.finish({ status: 'mate', winner: 'white' });
  return { engine, reports, final };
}

test('Partida da Ópera: goles batem com as regras padrão', () => {
  const { engine, reports, final } = playOpera();
  assert.deepEqual(engine.tally, { w: { sips: 25, glasses: 0 }, b: { sips: 18, glasses: 1 } });
  const bxb5 = reports[20];
  assert.equal(bxb5.label, '11. Bxb5+');
  assert.deepEqual(bxb5.items.map((i) => [i.kind, i.who, i.sips]), [['capture', 'b', 1], ['check', 'b', 1]]);
  const castle = reports[22];
  assert.equal(castle.label, '12. O-O-O');
  assert.deepEqual(castle.items, [{ kind: 'castle', who: 'both', side: 'O-O-O', sips: 1 }]);
  assert.equal(reports[31].label, '16... Nxb8');
  assert.deepEqual(reports[31].items.map((i) => [i.piece, i.sips]), [['q', 9]]);
  assert.equal(reports[32].items.length, 0, 'xeque-mate não dá gole de xeque');
  assert.deepEqual(final.result, { status: 'mate', winner: 'w', outcome: 'win' });
});

test('intensidade leve: metade arredondada para cima e meio copo', () => {
  const { engine } = playOpera('leve');
  assert.deepEqual(engine.tally, { w: { sips: 16, glasses: 0 }, b: { sips: 14, glasses: 0.5 } });
});

test('en passant: peão + bônus de humilhação', () => {
  const engine = new BeerEngine();
  engine.start({ fen: START_FEN });
  const steps = fensAfter(['e4', 'Nf6', 'e5', 'd5', 'exd6']);
  let last;
  for (const s of steps) last = engine.position({ fen: s.fen, uci: s.lm });
  assert.deepEqual(last.items.map((i) => [i.kind, i.who, i.sips]), [['capture', 'b', 1], ['enPassant', 'b', 2]]);
  assert.equal(engine.tally.b.sips, 3);
});

test('promoção capturando com xeque soma tudo para quem sofre', () => {
  const from = 'r3k3/1P6/8/8/8/8/8/4K3 w - - 0 40';
  const engine = new BeerEngine();
  engine.start({ fen: from });
  const [step] = fensAfter(['bxa8=Q+'], from);
  const report = engine.position({ fen: step.fen, uci: step.lm });
  assert.equal(report.label, '40. bxa8=Q+');
  assert.deepEqual(report.items.map((i) => [i.kind, i.sips]), [['capture', 5], ['promotion', 3], ['check', 1]]);
  assert.equal(engine.tally.b.sips, 9);
});

test('roque em UCI do tipo rei-captura-torre (e1h1) também conta', () => {
  const from = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 10';
  const engine = new BeerEngine();
  engine.start({ fen: from });
  const [step] = fensAfter(['O-O'], from);
  const report = engine.position({ fen: step.fen, uci: 'e1h1' });
  assert.equal(report.label, '10. O-O');
  assert.deepEqual(engine.tally, { w: { sips: 1, glasses: 0 }, b: { sips: 1, glasses: 0 } });
  assert.deepEqual(uciToMove('e8a8', new Chess(from.replace(' w ', ' b '))), { from: 'e8', to: 'c8' });
});

test('pulo de vários lances: conta pelas peças que sumiram (e ignora promoção)', () => {
  const engine = new BeerEngine();
  engine.start({ fen: START_FEN });
  const steps = fensAfter(['e4', 'd5', 'exd5', 'Qxd5']);
  const report = engine.position({ fen: steps[3].fen });
  assert.equal(report.jump, true);
  assert.deepEqual(report.items.map((i) => [i.who, i.piece, i.count, i.sips]), [['w', 'p', 1, 1], ['b', 'p', 1, 1]]);

  const promo = new BeerEngine();
  promo.start({ fen: '8/1P6/8/7k/8/8/p7/4K3 w - - 0 50' });
  const r = promo.position({ fen: '1Q6/8/8/7k/8/8/8/4K3 b - - 0 51' });
  assert.deepEqual(r.items.map((i) => [i.who, i.piece]), [['b', 'p']], 'peão que virou dama não é perda');
});

test('entrou no meio: lances antes da entrada não contam, e retrocesso só sincroniza', () => {
  const steps = fensAfter(['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qxa2', 'Rxa2']);
  const engine = new BeerEngine();
  const start = engine.start({ fen: steps[3].fen, turns: 4 });
  assert.equal(start.midGame, true);
  assert.equal(start.moveNumber, 3);
  assert.equal(engine.position({ fen: steps[1].fen }), null, 'posição antiga = sem goles');
  for (const i of [2, 3]) {
    const r = engine.position({ fen: steps[i].fen, uci: steps[i].lm });
    assert.equal(r.items.length, 0, 'lance anterior à entrada não conta');
  }
  assert.equal(engine.position({ fen: steps[3].fen, uci: steps[3].lm }), null, 'repetido = nada');
  engine.position({ fen: steps[4].fen, uci: steps[4].lm });
  const qxa2 = engine.position({ fen: steps[5].fen, uci: steps[5].lm });
  assert.deepEqual(qxa2.items.map((i) => [i.who, i.piece]), [['w', 'p']]);
  const rxa2 = engine.position({ fen: steps[6].fen, uci: steps[6].lm });
  assert.deepEqual(rxa2.items.map((i) => [i.who, i.piece, i.sips]), [['b', 'q', 9]]);
  assert.deepEqual(engine.tally, { w: { sips: 1, glasses: 0 }, b: { sips: 9, glasses: 0 } });
});

test('catchUp completa os lances finais que o stream segurou', () => {
  const steps = fensAfter(OPERA_GAME.moves);
  const engine = new BeerEngine();
  engine.start({ fen: START_FEN });
  for (const s of steps.slice(0, 30)) engine.position({ fen: s.fen, uci: s.lm });
  const reports = engine.catchUp([...OPERA_GAME.moves]);
  assert.deepEqual(reports.map((r) => r.label), ['16. Qb8+', '16... Nxb8', '17. Rd8#']);
  engine.finish({ status: 'mate' }); // sem winner: deduz pelo mate
  assert.deepEqual(engine.tally, { w: { sips: 25, glasses: 0 }, b: { sips: 18, glasses: 1 } });
  assert.equal(engine.result.winner, 'w');

  const wrong = new BeerEngine();
  wrong.start({ fen: START_FEN });
  wrong.position({ fen: fensAfter(['d4'])[0].fen, uci: 'd2d4' });
  assert.equal(wrong.catchUp([...OPERA_GAME.moves]), null, 'partida que não bate = null');
});

test('resultados: abandono, empate, tempo sem material, abortada e desconhecido', () => {
  const cases = [
    [{ status: 'resign', winner: 'black' }, 'win', { w: { sips: 0, glasses: 1 }, b: { sips: 0, glasses: 0 } }],
    [{ status: { id: 34, name: 'draw' } }, 'draw', { w: { sips: 3, glasses: 0 }, b: { sips: 3, glasses: 0 } }],
    [{ status: 'stalemate' }, 'draw', { w: { sips: 3, glasses: 0 }, b: { sips: 3, glasses: 0 } }],
    [{ status: 'outoftime' }, 'draw', { w: { sips: 3, glasses: 0 }, b: { sips: 3, glasses: 0 } }],
    [{ status: 'aborted' }, 'aborted', { w: { sips: 0, glasses: 0 }, b: { sips: 0, glasses: 0 } }],
    [{ status: 'resign' }, 'other', { w: { sips: 0, glasses: 0 }, b: { sips: 0, glasses: 0 } }],
  ];
  for (const [input, outcome, tally] of cases) {
    const engine = new BeerEngine();
    engine.start({ fen: START_FEN });
    engine.finish(input);
    assert.equal(engine.result.outcome, outcome, JSON.stringify(input));
    assert.deepEqual(engine.tally, tally, JSON.stringify(input));
    assert.equal(engine.finish(input), null, 'só termina uma vez');
  }
});

test('FEN só com o tabuleiro ainda funciona', () => {
  const engine = new BeerEngine();
  engine.start({ fen: START_FEN });
  const steps = fensAfter(['e4', 'd5', 'exd5']);
  for (const s of steps) engine.position({ fen: s.fen.split(' ')[0], uci: s.lm });
  assert.equal(engine.tally.b.sips, 1);
});

test('utilitários de FEN', () => {
  assert.equal(absPlyFromFen(START_FEN), 0);
  assert.equal(absPlyFromFen('8/8/8/8/8/8/8/8 b - - 0 20'), 39);
  assert.equal(absPlyFromFen('8/8/8/8/8/8/8/8'), null);
  assert.deepEqual(countPieces(START_FEN).w, { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 });
  assert.equal(uciToMove('xx', null), null);
});
