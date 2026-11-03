// Reprise da Partida da Ópera (Paul Morphy x Duque de Brunswick e Conde Isouard, Paris, 1858)
// no mesmo formato do stream do Lichess — serve para ver o bot funcionando sem jogar.

import { Chess } from 'chess.js';
import { START_FEN } from './engine.js';
import { sleep } from './util.js';

export const OPERA_GAME = Object.freeze({
  white: 'Morphy',
  black: 'Duque & Conde',
  moves: Object.freeze(
    'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#'.split(' '),
  ),
  status: 'mate',
  winner: 'white',
});

export function demoFeed({ delayMs = 2_000, game = OPERA_GAME } = {}) {
  return {
    async *stream(signal) {
      const info = {
        id: 'demo',
        variant: { key: 'standard', name: 'Standard' },
        speed: 'classical',
        initialFen: START_FEN,
        fen: START_FEN,
        turns: 0,
        status: { id: 20, name: 'started' },
        players: { white: { user: { name: game.white } }, black: { user: { name: game.black } } },
      };
      yield info;
      const chess = new Chess();
      for (const san of game.moves) {
        await sleep(delayMs, signal);
        if (signal?.aborted) return;
        const move = chess.move(san);
        yield { fen: chess.fen(), lm: move.lan };
      }
      await sleep(delayMs, signal);
      if (signal?.aborted) return;
      yield { ...info, fen: chess.fen(), turns: game.moves.length, status: { id: 30, name: game.status }, winner: game.winner };
    },
  };
}
