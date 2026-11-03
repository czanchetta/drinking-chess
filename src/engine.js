// Motor do Beer Chess: recebe posições/lances de uma partida e diz quem bebe.
// Não faz rede nem Discord — só regras, para dar para testar isolado.

import { Chess } from 'chess.js';
import { DEFAULT_RULES, normalizeIntensity, scaleGlasses, scaleSips } from './rules.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const OTHER = Object.freeze({ w: 'b', b: 'w' });
const PIECE_TYPES = ['q', 'r', 'b', 'n', 'p'];
const ABORTED = new Set(['aborted', 'noStart']);
// Sem vencedor nestes status = empate (ex.: tempo esgotado contra material insuficiente).
const DRAWISH = new Set(['draw', 'stalemate', 'insufficientMaterialClaim', 'outoftime', 'timeout']);
const RUNNING = new Set(['created', 'started']);

export function boardPart(fen) {
  return String(fen ?? '').trim().split(/\s+/)[0];
}

/** Lance absoluto (meio-lance) a partir dos contadores do FEN; null se o FEN não tiver contadores. */
export function absPlyFromFen(fen) {
  const parts = String(fen ?? '').trim().split(/\s+/);
  if (parts.length < 6 || (parts[1] !== 'w' && parts[1] !== 'b')) return null;
  const fullmove = Number.parseInt(parts[5], 10);
  if (!Number.isFinite(fullmove) || fullmove < 1) return null;
  return (fullmove - 1) * 2 + (parts[1] === 'b' ? 1 : 0);
}

export function countPieces(fen) {
  const empty = () => ({ p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 });
  const counts = { w: empty(), b: empty() };
  for (const ch of boardPart(fen)) {
    const lower = ch.toLowerCase();
    if (!Object.hasOwn(counts.w, lower)) continue;
    counts[ch === lower ? 'b' : 'w'][lower] += 1;
  }
  return counts;
}

export function statusName(status) {
  if (typeof status === 'string') return status;
  return status?.name ?? 'unknown';
}

export function isFinishedStatus(status) {
  return !RUNNING.has(statusName(status));
}

/** Converte UCI do Lichess em lance do chess.js (aceita roque escrito como "rei captura torre"). */
export function uciToMove(uci, chess) {
  if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  const from = uci.slice(0, 2);
  let to = uci.slice(2, 4);
  const promotion = uci[4];
  if (chess?.get(from)?.type === 'k' && from[0] === 'e') {
    const rank = from[1];
    if (to === `h${rank}`) to = `g${rank}`;
    else if (to === `a${rank}`) to = `c${rank}`;
  }
  return promotion ? { from, to, promotion } : { from, to };
}

function moveLabel(fenBefore, san) {
  const parts = String(fenBefore).split(/\s+/);
  const number = parts[5] ?? '?';
  return parts[1] === 'b' ? `${number}... ${san}` : `${number}. ${san}`;
}

export class BeerEngine {
  constructor({ rules = DEFAULT_RULES, intensity = 'normal' } = {}) {
    this.rules = rules;
    this.intensity = normalizeIntensity(intensity);
    this.tally = { w: { sips: 0, glasses: 0 }, b: { sips: 0, glasses: 0 } };
    this.chess = null;
    this.fen = START_FEN;
    this.ply = 0;
    this.initialFen = START_FEN;
    this.countFromPly = 0; // lances até aqui não contam (entrou no meio da partida)
    this.result = null;
  }

  sips(n) {
    return scaleSips(n, this.intensity);
  }

  /** Primeira mensagem da partida. Tudo que aconteceu antes desta posição não conta. */
  start({ fen, initialFen, turns } = {}) {
    this.initialFen = initialFen && initialFen !== 'startpos' ? initialFen : START_FEN;
    this.resetTo(fen || this.initialFen);
    if (absPlyFromFen(this.fen) === null && Number.isInteger(turns)) this.ply = turns;
    this.countFromPly = this.ply;
    const basePly = absPlyFromFen(this.initialFen) ?? 0;
    return { ply: this.ply, moveNumber: Math.floor(this.ply / 2) + 1, midGame: this.ply > basePly };
  }

  /**
   * Nova posição vinda do stream. `uci` é o último lance (pode faltar).
   * Retorna um relatório { ply, label, items } ou null se nada mudou.
   */
  position({ fen, uci } = {}) {
    if (!fen || this.result) return null;
    const target = absPlyFromFen(fen);
    if (target !== null && target <= this.ply) {
      // Posição repetida ou anterior (atraso do stream / reconexão): só sincroniza, sem goles.
      if (boardPart(fen) !== boardPart(this.fen)) this.resetTo(fen);
      return null;
    }
    if (target === null && boardPart(fen) === boardPart(this.fen)) return null;
    if (uci && this.chess && (target === null || target === this.ply + 1)) {
      const report = this.tryMove(uci, fen);
      if (report) return report;
    }
    return this.jumpTo(fen);
  }

  tryMove(uci, fen) {
    const spec = uciToMove(uci, this.chess);
    if (!spec) return null;
    const before = this.chess.fen();
    let move = null;
    try {
      move = this.chess.move(spec);
    } catch {
      move = null;
    }
    if (!move) return null;
    if (fen && boardPart(this.chess.fen()) !== boardPart(fen)) {
      this.chess.undo();
      return null;
    }
    return this.afterMove(move, before);
  }

  afterMove(move, fenBefore) {
    this.fen = this.chess.fen();
    this.ply = absPlyFromFen(this.fen) ?? this.ply + 1;
    const victim = OTHER[move.color];
    const items = [];
    if (this.ply > this.countFromPly) {
      const r = this.rules;
      if (move.captured) {
        items.push({ kind: 'capture', who: victim, piece: move.captured, count: 1, sips: this.sips(r.pieces[move.captured]) });
        if (move.flags.includes('e')) items.push({ kind: 'enPassant', who: victim, sips: this.sips(r.enPassant) });
      }
      if (move.promotion) items.push({ kind: 'promotion', who: victim, piece: move.promotion, sips: this.sips(r.promotion) });
      if (move.flags.includes('k') || move.flags.includes('q')) {
        items.push({ kind: 'castle', who: 'both', side: move.flags.includes('k') ? 'O-O' : 'O-O-O', sips: this.sips(r.castle) });
      }
      if (this.chess.inCheck() && !this.chess.isCheckmate()) {
        items.push({ kind: 'check', who: victim, sips: this.sips(r.check) });
      }
    }
    return this.commit({ ply: this.ply, label: moveLabel(fenBefore, move.san), san: move.san, mover: move.color, items });
  }

  /** Pulo de vários lances (reconexão, fim com atraso): conta só as peças que sumiram do tabuleiro. */
  jumpTo(fen) {
    const prev = countPieces(this.fen);
    const next = countPieces(fen);
    this.resetTo(fen);
    const items = [];
    if (this.ply > this.countFromPly) {
      for (const color of ['w', 'b']) {
        let promotions = 0;
        for (const t of ['q', 'r', 'b', 'n']) promotions += Math.max(0, next[color][t] - prev[color][t]);
        for (const t of PIECE_TYPES) {
          let lost = Math.max(0, prev[color][t] - next[color][t]);
          if (t === 'p') lost = Math.max(0, lost - promotions);
          if (lost > 0) items.push({ kind: 'capture', who: color, piece: t, count: lost, sips: this.sips(this.rules.pieces[t]) * lost });
        }
      }
      if (this.chess?.inCheck() && !this.chess.isCheckmate()) {
        items.push({ kind: 'check', who: this.chess.turn(), sips: this.sips(this.rules.check) });
      }
    }
    return this.commit({ ply: this.ply, label: null, jump: true, items });
  }

  /**
   * Fim de partida com atraso: o stream do Lichess fica alguns lances atrás.
   * Recebe a lista SAN completa (export da partida) e reproduz os lances que faltaram.
   * Retorna os relatórios dos lances novos, ou null se não deu para alinhar.
   */
  catchUp(sanMoves) {
    if (!Array.isArray(sanMoves) || this.result) return null;
    const basePly = absPlyFromFen(this.initialFen) ?? 0;
    const done = this.ply - basePly;
    if (done < 0 || done > sanMoves.length) return null;
    let replay;
    try {
      replay = new Chess(this.initialFen);
      for (let i = 0; i < done; i += 1) replay.move(sanMoves[i]);
    } catch {
      return null;
    }
    if (boardPart(replay.fen()) !== boardPart(this.fen)) return null;
    this.chess = replay;
    const reports = [];
    for (let i = done; i < sanMoves.length; i += 1) {
      const before = this.chess.fen();
      let move = null;
      try {
        move = this.chess.move(sanMoves[i]);
      } catch {
        move = null;
      }
      if (!move) break;
      reports.push(this.afterMove(move, before));
    }
    return reports;
  }

  finish({ status, winner } = {}) {
    if (this.result) return null;
    const name = statusName(status);
    let win = winner === 'white' ? 'w' : winner === 'black' ? 'b' : null;
    if (!win && name === 'mate' && this.chess?.isCheckmate()) win = OTHER[this.chess.turn()];
    const items = [];
    let outcome;
    if (win) {
      outcome = 'win';
      const glasses = scaleGlasses(this.rules.loserGlasses, this.intensity);
      if (glasses > 0) items.push({ kind: 'loss', who: OTHER[win], glasses });
    } else if (ABORTED.has(name)) {
      outcome = 'aborted';
    } else if (DRAWISH.has(name)) {
      outcome = 'draw';
      items.push({ kind: 'draw', who: 'both', sips: this.sips(this.rules.draw) });
    } else {
      outcome = 'other'; // resultado desconhecido: ninguém bebe por engano
    }
    this.result = { status: name, winner: win, outcome };
    return this.commit({ ply: this.ply, result: this.result, items });
  }

  commit(report) {
    report.items = report.items.filter((item) => (item.sips ?? 0) > 0 || (item.glasses ?? 0) > 0);
    for (const item of report.items) {
      for (const color of item.who === 'both' ? ['w', 'b'] : [item.who]) {
        this.tally[color].sips += item.sips ?? 0;
        this.tally[color].glasses += item.glasses ?? 0;
      }
    }
    return report;
  }

  resetTo(fen) {
    let full = String(fen).trim();
    if (full.split(/\s+/).length < 6) full = this.completeFen(boardPart(full));
    try {
      this.chess = new Chess(full);
      this.fen = this.chess.fen();
    } catch {
      this.chess = null;
      this.fen = full;
    }
    const ply = absPlyFromFen(this.fen);
    if (ply !== null) this.ply = ply;
  }

  // FEN só com o tabuleiro: supõe que é a vez do outro lado e deduz roques possíveis.
  completeFen(board) {
    const [, turn = 'w', , , , full = '1'] = this.fen.split(/\s+/);
    const nextTurn = OTHER[turn] ?? 'w';
    const fullmove = turn === 'b' ? Number(full) + 1 : Number(full);
    const rows = board.split('/');
    const expand = (row) => (row ?? '').replace(/\d/g, (d) => '.'.repeat(Number(d)));
    const r1 = expand(rows[7]);
    const r8 = expand(rows[0]);
    let castling = '';
    if (r1[4] === 'K') castling += (r1[7] === 'R' ? 'K' : '') + (r1[0] === 'R' ? 'Q' : '');
    if (r8[4] === 'k') castling += (r8[7] === 'r' ? 'k' : '') + (r8[0] === 'r' ? 'q' : '');
    return `${board} ${nextTurn} ${castling || '-'} - 0 ${fullmove || 1}`;
  }
}
