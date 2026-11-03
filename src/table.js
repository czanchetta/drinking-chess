// Mesa de Beer Chess: o bot decide quem joga com quem, cria cada partida no Lichess,
// entrega o link certo para cada um e gira a mesa sozinho quando a partida acaba.

import { randomBytes } from 'node:crypto';
import { CLOCKS, DEFAULT_CLOCK } from './commands.js';
import { normalizeIntensity } from './rules.js';
import { closedPayload, mention, pairingPayload, pausePayload } from './ui.js';

const KEEP_CLOSED_MS = 12 * 60 * 60_000;

export const FORMATS = Object.freeze({
  rei: Object.freeze({
    key: 'rei',
    label: 'quem ganha fica',
    hint: 'quem ganha continua na mesa, quem perde vai para o fim da fila',
  }),
  rodizio: Object.freeze({
    key: 'rodizio',
    label: 'rodízio',
    hint: 'todo mundo joga igual: entra primeiro quem jogou menos, contra quem enfrentou menos',
  }),
});

export function normalizeFormat(value) {
  return Object.hasOwn(FORMATS, value ?? '') ? value : 'rei';
}

export function shuffle(list, random = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const byPriority = (stats) => (a, b) => {
  const sa = stats.get(a);
  const sb = stats.get(b);
  return sa.turns - sb.turns || sa.lastPlayed - sb.lastPlayed;
};

/**
 * Próxima dupla.
 * - rei ("quem ganha fica"): os dois primeiros da fila.
 * - rodízio: quem jogou menos (e esperou mais) contra quem ele enfrentou menos; empates no sorteio.
 */
export function pickPair({ format, queue, seated, stats, faced = new Map(), random = Math.random }) {
  if (format === 'rei') {
    const order = queue.filter((id) => seated.has(id));
    return order.length >= 2 ? [order[0], order[1]] : null;
  }
  const pool = shuffle([...seated], random).sort(byPriority(stats));
  if (pool.length < 2) return null;
  const [first, ...rest] = pool;
  const met = (id) => faced.get(pairKey(first, id)) ?? 0;
  const opponent = rest.sort((a, b) => stats.get(a).turns - stats.get(b).turns
    || met(a) - met(b)
    || stats.get(a).lastPlayed - stats.get(b).lastPlayed)[0];
  return [first, opponent];
}

/** Brancas para quem jogou menos de brancas; empate = sorteio. */
export function assignColors([a, b], stats, random = Math.random) {
  const wa = stats.get(a)?.whites ?? 0;
  const wb = stats.get(b)?.whites ?? 0;
  const aWhite = wa === wb ? random() < 0.5 : wa < wb;
  return aWhite ? { white: a, black: b } : { white: b, black: a };
}

/** Fila do "quem ganha fica": vencedor na frente, perdedor no fim; no empate, os dois vão para o fim. */
export function rotateQueue(queue, { white, black, winner }) {
  const rest = queue.filter((id) => id !== white && id !== black);
  if (winner === white || winner === black) return [winner, ...rest, winner === white ? black : white];
  return [...rest, white, black];
}

function newStats(id, name) {
  return { id, name, games: 0, wins: 0, losses: 0, draws: 0, whites: 0, sips: 0, glasses: 0, turns: 0, lastPlayed: 0 };
}

function lichessDetail(err) {
  if (err?.status === 429) return 'o Lichess pediu um tempinho';
  return err?.message ? String(err.message).slice(0, 120) : null;
}

export class Table {
  constructor({
    id, channelId, hostId, format, clockKey, intensity, manager, lichess, post,
    challengeWaitMs = 2 * 60 * 60_000, log = () => {}, random = Math.random, now = Date.now,
  }) {
    this.id = id;
    this.channelId = channelId;
    this.hostId = hostId;
    this.format = normalizeFormat(format);
    this.clockKey = Object.hasOwn(CLOCKS, clockKey ?? '') ? clockKey : DEFAULT_CLOCK;
    this.intensity = normalizeIntensity(intensity);
    this.manager = manager;
    this.lichess = lichess;
    this.post = post;
    this.challengeWaitMs = challengeWaitMs;
    this.log = log;
    this.random = random;
    this.now = now;
    this.status = 'aberta'; // aberta | jogando | pausada | encerrada
    this.pauseReason = null;
    this.closing = false; // pediram para encerrar: a partida atual é a última
    this.seated = new Set();
    this.queue = [];
    this.stats = new Map(); // fica com quem já saiu, para o resumo final
    this.faced = new Map();
    this.games = new Map();
    this.current = null;
    this.gameCount = 0; // partidas criadas
    this.played = 0; // partidas com resultado
    this.king = null;
    this.chain = Promise.resolve();
    this.closedAt = null;
  }

  get clock() {
    return CLOCKS[this.clockKey];
  }

  get formatInfo() {
    return FORMATS[this.format];
  }

  get seatedCount() {
    return this.seated.size;
  }

  isSeated(id) {
    return this.seated.has(id);
  }

  /** Tudo que mexe na mesa roda em fila, um de cada vez. */
  enqueue(task) {
    const run = this.chain.then(task).catch((err) => this.log(`[mesa ${this.id}] ${err?.stack ?? err}`));
    this.chain = run;
    return run;
  }

  /** Espera a fila esvaziar (útil nos testes). */
  async idle() {
    let last;
    do {
      last = this.chain;
      await last;
      await new Promise((resolve) => setImmediate(resolve));
    } while (last !== this.chain);
  }

  async send(payload) {
    try {
      return await this.post(payload);
    } catch (err) {
      this.log(`[mesa ${this.id}] não consegui postar: ${err?.message ?? err}`);
      return null;
    }
  }

  /** Quem está na mesa mas fora da partida, na ordem em que deve entrar. */
  waiting(game = this.current) {
    const playing = new Set(game ? [game.white, game.black] : []);
    const order = this.format === 'rei'
      ? this.queue.filter((id) => this.seated.has(id))
      : [...this.seated].sort(byPriority(this.stats));
    return order.filter((id) => !playing.has(id));
  }

  join({ id, name = null }) {
    if (this.status === 'encerrada') return { ok: false, message: 'Essa mesa já foi encerrada. Abram outra com `/beerchess mesa`.' };
    if (this.closing) return { ok: false, message: 'A mesa encerra depois desta partida.' };
    if (this.seated.has(id)) return { ok: false, message: 'Você já está na mesa 😉' };
    const minTurns = this.seated.size ? Math.min(...[...this.seated].map((s) => this.stats.get(s).turns)) : 0;
    const stats = this.stats.get(id) ?? newStats(id, name);
    if (name) stats.name = name;
    stats.turns = Math.max(stats.turns, minTurns); // no rodízio, quem chega depois não "deve" partidas
    this.stats.set(id, stats);
    this.seated.add(id);
    this.queue = [...this.queue.filter((q) => q !== id), id];
    if (this.status === 'pausada' && this.pauseReason === 'faltam' && this.seated.size >= 2) {
      this.enqueue(() => this.next());
    }
    return { ok: true, position: this.waiting().indexOf(id) + 1 };
  }

  leave(id) {
    if (!this.seated.has(id)) return { ok: false, message: 'Você não está na mesa.' };
    this.seated.delete(id);
    this.queue = this.queue.filter((q) => q !== id);
    const game = this.current;
    const playing = Boolean(game && (game.white === id || game.black === id));
    let cancelled = false;
    if (playing && !game.session?.started) {
      cancelled = true;
      this.cancel(game);
      const note = `🚪 ${mention(id)} saiu antes da partida ${game.number} começar, então refiz a dupla.`;
      this.enqueue(() => this.next({ note }));
    }
    return { ok: true, playing, cancelled };
  }

  cancel(game) {
    game.cancelled = true;
    if (this.current === game) this.current = null;
    game.session?.stop();
  }

  /** ▶️ Começar / Continuar. */
  start() {
    if (this.status === 'jogando' || this.status === 'encerrada' || this.closing) return Promise.resolve(false);
    if (this.format === 'rei' && this.gameCount === 0) {
      this.queue = shuffle(this.queue.filter((id) => this.seated.has(id)), this.random); // sorteio da primeira dupla
    }
    return this.enqueue(() => this.next()).then(() => true);
  }

  async next({ note = null } = {}) {
    if (this.status === 'encerrada' || this.current) return;
    if (this.closing) {
      await this.finishClose();
      return;
    }
    const pair = pickPair({
      format: this.format, queue: this.queue, seated: this.seated, stats: this.stats, faced: this.faced, random: this.random,
    });
    if (!pair) {
      await this.pause('faltam', { note });
      return;
    }
    if (!this.manager.hasRoom()) {
      await this.pause('limite', { note });
      return;
    }
    const { white, black } = assignColors(pair, this.stats, this.random);
    const number = this.gameCount + 1;
    let challenge;
    try {
      challenge = await this.lichess.createOpenChallenge({
        clockLimit: this.clock.limit,
        clockIncrement: this.clock.increment,
        expiresInMs: this.challengeWaitMs,
        name: `Beer Chess - partida ${number}`,
      });
    } catch (err) {
      this.log(`[mesa ${this.id}] criar desafio falhou: ${err?.message ?? err}`);
      await this.pause('lichess', { note, detail: lichessDetail(err) });
      return;
    }
    if (this.status === 'encerrada') return;
    if (!this.seated.has(white) || !this.seated.has(black)) {
      // alguém saiu enquanto a partida era criada: refaz a dupla (o desafio órfão expira sozinho)
      await this.next({ note });
      return;
    }
    const game = {
      number, gameId: challenge.id, white, black, urls: challenge, session: null, cancelled: false, outcome: null, winnerId: null,
    };
    try {
      game.session = this.manager.watch({
        gameId: game.gameId,
        channelId: this.channelId,
        players: { w: { discordId: white }, b: { discordId: black } },
        intensity: this.intensity,
        clockLabel: this.clock.label,
        waitForStartMs: this.challengeWaitMs,
        pingStart: false,
        onEnd: (session) => this.enqueue(() => this.afterGame(session)),
      }).session;
    } catch (err) {
      if (err?.code !== 'LIMIT') throw err;
      await this.pause('limite', { note });
      return;
    }
    this.gameCount = number;
    this.games.set(game.gameId, game);
    this.current = game;
    this.status = 'jogando';
    this.pauseReason = null;
    await this.send(pairingPayload(this, game, { note }));
  }

  async afterGame(session) {
    const game = this.games.get(session.gameId);
    if (!game) return;
    if (this.current === game) this.current = null;
    if (game.cancelled || this.status === 'encerrada') return;
    if (session.status !== 'finished') {
      if (this.closing) {
        await this.finishClose();
        return;
      }
      const reason = session.status === 'stopped' ? 'parada' : session.status === 'expired' ? 'ausentes' : 'erro';
      await this.pause(reason, { game });
      return;
    }
    const result = session.engine.result ?? {};
    const aborted = result.outcome === 'aborted';
    if (aborted) game.outcome = 'aborted';
    else this.record(game, session);
    if (this.closing) {
      await this.finishClose();
      return;
    }
    if (aborted) {
      await this.pause('abortada', { game });
      return;
    }
    if (this.format === 'rei') {
      this.queue = rotateQueue(this.queue, { white: game.white, black: game.black, winner: game.winnerId })
        .filter((id) => this.seated.has(id));
    }
    await this.next();
  }

  record(game, session) {
    const { tally, result } = session.engine;
    game.outcome = result.outcome;
    game.winnerId = result.winner === 'w' ? game.white : result.winner === 'b' ? game.black : null;
    this.played += 1;
    const key = pairKey(game.white, game.black);
    this.faced.set(key, (this.faced.get(key) ?? 0) + 1);
    for (const [color, id] of [['w', game.white], ['b', game.black]]) {
      const stats = this.stats.get(id);
      stats.games += 1;
      stats.turns += 1;
      stats.lastPlayed = game.number;
      if (color === 'w') stats.whites += 1;
      stats.sips += tally[color].sips;
      stats.glasses += tally[color].glasses;
      if (!game.winnerId) stats.draws += 1;
      else if (game.winnerId === id) stats.wins += 1;
      else stats.losses += 1;
    }
    if (!game.winnerId) this.king = null;
    else if (this.king?.id === game.winnerId) this.king = { id: game.winnerId, streak: this.king.streak + 1 };
    else this.king = { id: game.winnerId, streak: 1 };
  }

  async pause(reason, { game = null, note = null, detail = null } = {}) {
    if (this.status === 'encerrada') return;
    this.status = 'pausada';
    this.pauseReason = reason;
    await this.send(pausePayload(this, { reason, game, note, detail }));
  }

  /**
   * 🛑 Encerrar. Se a partida já começou, ela termina antes (a menos que `force`).
   * Com `announce: false`, devolve o resumo em vez de postar.
   */
  close({ by = null, force = false, announce = true } = {}) {
    if (this.status === 'encerrada') return { ok: false, message: 'Essa mesa já foi encerrada.' };
    const game = this.current;
    if (game && game.session?.started && !force) {
      if (this.closing) return { ok: false, message: 'A mesa já vai encerrar depois desta partida.' };
      this.closing = true;
      if (announce) {
        const who = by ? `${mention(by)} pediu para encerrar` : 'Encerrando a mesa';
        this.enqueue(() => this.send({ content: `🛑 ${who}: a partida ${game.number} é a última.`, allowedMentions: { parse: [] } }));
      }
      return { ok: true, closing: true };
    }
    if (game) this.cancel(game);
    this.markClosed();
    const summary = closedPayload(this);
    if (announce) this.enqueue(() => this.send(summary));
    return { ok: true, closing: false, summary };
  }

  markClosed() {
    this.status = 'encerrada';
    this.closing = false;
    this.closedAt = this.now();
  }

  async finishClose() {
    if (this.status === 'encerrada') return;
    this.markClosed();
    await this.send(closedPayload(this));
  }
}

export class TableManager {
  constructor({ manager, lichess, send, challengeWaitMs, log = () => {}, random = Math.random, now = Date.now }) {
    this.manager = manager;
    this.lichess = lichess;
    this.send = send;
    this.challengeWaitMs = challengeWaitMs;
    this.log = log;
    this.random = random;
    this.now = now;
    this.byId = new Map();
    this.byChannel = new Map();
  }

  open({ channelId, host, format, clockKey, intensity }) {
    this.prune();
    const current = this.inChannel(channelId);
    if (current) return { table: current, existing: true };
    let id;
    do id = randomBytes(4).toString('hex'); while (this.byId.has(id));
    const table = new Table({
      id,
      channelId,
      hostId: host.id,
      format,
      clockKey,
      intensity,
      manager: this.manager,
      lichess: this.lichess,
      post: (payload) => this.send(channelId, payload),
      challengeWaitMs: this.challengeWaitMs,
      log: this.log,
      random: this.random,
      now: this.now,
    });
    table.join(host);
    this.byId.set(id, table);
    this.byChannel.set(channelId, table);
    return { table, existing: false };
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  inChannel(channelId) {
    const table = this.byChannel.get(channelId);
    return table && table.status !== 'encerrada' ? table : null;
  }

  prune() {
    const now = this.now();
    for (const [id, table] of this.byId) {
      if (table.status !== 'encerrada' || now - table.closedAt <= KEEP_CLOSED_MS) continue;
      this.byId.delete(id);
      if (this.byChannel.get(table.channelId) === table) this.byChannel.delete(table.channelId);
    }
  }

  /** Desligando o bot: fecha as mesas sem postar nada. */
  shutdown() {
    for (const table of this.byId.values()) if (table.status !== 'encerrada') table.markClosed();
  }
}
