// Uma partida acompanhada num canal do Discord + o gerente de todas elas.

import { BeerEngine, isFinishedStatus, statusName } from './engine.js';
import { formatResult, formatStart, formatTurn, playerName } from './format.js';
import { DEFAULT_RULES, normalizeIntensity } from './rules.js';
import { packMessages, sleep } from './util.js';

const SUPPORTED_VARIANTS = new Set(['standard', 'fromPosition']);
const KEEP_FINISHED_MS = 12 * 60 * 60_000;

export const DEFAULT_TIMING = Object.freeze({
  pollMs: 5_000, // intervalo entre tentativas enquanto ninguém aceitou o desafio
  waitForStartMs: 2 * 60 * 60_000, // desiste de esperar os jogadores depois disso
  idleMs: 120_000, // stream sem nenhum byte por esse tempo = reconecta
  rateLimitMs: 60_000, // HTTP 429: o Lichess pede 1 minuto de pausa
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  maxFailures: 12,
});

function backoff(failures, timing) {
  if (failures <= 0) return timing.backoffBaseMs;
  return Math.min(timing.backoffMaxMs, timing.backoffBaseMs * 2 ** (failures - 1));
}

function lichessName(player) {
  if (!player) return null;
  if (player.aiLevel) return `Stockfish nível ${player.aiLevel}`;
  return player.user?.name ?? player.user?.id ?? player.name ?? player.userId ?? null;
}

let demoCounter = 0;

export class GameSession {
  constructor({
    gameId, channelId, players = {}, intensity = 'normal', rules = DEFAULT_RULES, feed, post,
    gameUrl = null, clockLabel = null, waitForStart = true, waitForStartMs = null, demo = false,
    timing = {}, log = () => {}, onEnd = null, pingStart = true,
  }) {
    this.gameId = gameId;
    this.channelId = channelId;
    this.key = `${channelId}:${gameId}`;
    this.players = { w: { ...players.w }, b: { ...players.b } };
    this.intensity = normalizeIntensity(intensity);
    this.engine = new BeerEngine({ rules, intensity: this.intensity });
    this.feed = feed;
    this.post = post;
    this.gameUrl = gameUrl;
    this.clockLabel = clockLabel;
    this.waitForStart = waitForStart;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.waitForStartMs = waitForStartMs ?? this.timing.waitForStartMs;
    this.demo = demo;
    this.log = log;
    this.onEnd = onEnd; // chamado uma vez quando a sessão termina, por qualquer motivo
    this.pingStart = pingStart;
    this.status = 'waiting'; // waiting | live | finished | stopped | expired | error
    this.started = false;
    this.finished = false;
    this.stopped = false;
    this.abort = new AbortController();
    this.createdAt = Date.now();
    this.endedAt = null;
    this.done = null;
  }

  get active() {
    return !this.finished && !this.stopped && this.status !== 'error' && this.status !== 'expired';
  }

  get tally() {
    return this.engine.tally;
  }

  get moveNumber() {
    return Math.floor(this.engine.ply / 2) + 1;
  }

  start() {
    this.done = this.run()
      .catch((err) => {
        this.log(`[${this.gameId}] erro inesperado: ${err?.stack ?? err}`);
        this.status = 'error';
        this.endedAt = Date.now();
      })
      .finally(() => this.notifyEnd());
    return this;
  }

  // Sem await de propósito: quem ouve (a mesa) pode parar esta sessão e criar outra sem travar.
  notifyEnd() {
    if (!this.onEnd) return;
    try {
      Promise.resolve(this.onEnd(this)).catch((err) => this.log(`[${this.gameId}] onEnd falhou: ${err?.stack ?? err}`));
    } catch (err) {
      this.log(`[${this.gameId}] onEnd falhou: ${err?.stack ?? err}`);
    }
  }

  stop() {
    if (!this.active) return false;
    this.stopped = true;
    this.status = 'stopped';
    this.endedAt = Date.now();
    this.abort.abort();
    return true;
  }

  async say(texts, { ping = false } = {}) {
    const list = Array.isArray(texts) ? texts : [texts];
    const users = ping ? [...new Set(['w', 'b'].map((c) => this.players[c].discordId).filter(Boolean))] : [];
    for (const content of packMessages(list)) {
      try {
        await this.post({ content, allowedMentions: { users } });
      } catch (err) {
        this.log(`[${this.gameId}] não consegui postar no canal ${this.channelId}: ${err?.message ?? err}`);
      }
    }
  }

  async run() {
    const t = this.timing;
    const deadline = this.createdAt + this.waitForStartMs;
    let failures = 0;
    while (!this.stopped && !this.finished) {
      let received = false;
      try {
        for await (const msg of this.feed.stream(this.abort.signal)) {
          received = true;
          await this.handle(msg);
          if (this.finished || this.stopped) break;
        }
        if (this.finished || this.stopped) break;
        failures = received ? 0 : failures + 1; // stream fechou sem resultado: reconecta
      } catch (err) {
        if (this.stopped) break;
        if (err?.status === 404 && !this.started) {
          if (this.waitForStart && Date.now() < deadline) {
            await sleep(t.pollMs, this.abort.signal);
            continue;
          }
          await this.giveUp();
          return;
        }
        if (err?.status === 429) {
          this.log(`[${this.gameId}] Lichess pediu pausa (429); esperando ${t.rateLimitMs / 1000}s`);
          await sleep(t.rateLimitMs, this.abort.signal);
          continue;
        }
        failures = received ? 1 : failures + 1;
        this.log(`[${this.gameId}] stream caiu (${failures}): ${err?.message ?? err}`);
      }
      if (failures > t.maxFailures) {
        this.status = 'error';
        this.endedAt = Date.now();
        await this.say(`📡 Perdi a conexão com a partida ${this.gameUrl ?? this.gameId}. Usa \`/beerchess assistir\` para retomar.`);
        return;
      }
      await sleep(backoff(failures, t), this.abort.signal);
    }
  }

  async handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.id === 'string' && msg.status != null) {
      await this.onInfo(msg);
      return;
    }
    if (typeof msg.fen === 'string' && this.started) {
      const report = this.engine.position({ fen: msg.fen, uci: msg.lm });
      if (report?.items.length) await this.say(formatTurn(report, this.players));
    }
  }

  async onInfo(info) {
    const finished = isFinishedStatus(info.status);
    if (!this.started) {
      this.started = true;
      const variant = info.variant?.key ?? 'standard';
      if (!SUPPORTED_VARIANTS.has(variant)) {
        await this.say(`🙅 A partida ${this.gameUrl} é de ${info.variant?.name ?? variant}; aqui o beer chess só funciona no xadrez normal.`);
        this.stop();
        return;
      }
      for (const [color, side] of [['w', 'white'], ['b', 'black']]) {
        const name = lichessName(info.players?.[side]);
        if (name && !this.players[color].name) this.players[color].name = name;
      }
      if (finished) {
        await this.say(`🏁 A partida ${this.gameUrl} já terminou — nada para contar. Começa outra com \`/beerchess novo\`.`);
        this.stop();
        return;
      }
      this.status = 'live';
      const start = this.engine.start({ fen: info.fen, initialFen: info.initialFen, turns: info.turns });
      await this.say(formatStart({
        players: this.players, gameUrl: this.gameUrl, clockLabel: this.clockLabel, info, start,
        intensity: this.intensity, delayNote: !this.demo,
      }), { ping: this.pingStart });
      return;
    }
    if (finished) {
      await this.finish(info);
      return;
    }
    // Reconexão: sincroniza e conta peças que sumiram enquanto estava fora.
    const report = this.engine.position({ fen: info.fen });
    if (report?.items.length) await this.say(formatTurn(report, this.players));
  }

  async finish(info) {
    let status = statusName(info.status);
    let winner = info.winner ?? null;
    let moves = null;
    // O stream fica uns lances atrás: busca a partida completa para contar o finalzinho certo.
    if (this.feed.exportGame) {
      try {
        const exported = await this.feed.exportGame(this.abort.signal);
        moves = exported.moves;
        if (exported.status && isFinishedStatus(exported.status)) status = statusName(exported.status);
        winner = exported.winner ?? winner;
      } catch (err) {
        this.log(`[${this.gameId}] export falhou, sigo pelo FEN final: ${err?.message ?? err}`);
      }
    }
    let reports = moves ? this.engine.catchUp(moves) : null;
    if (reports === null) {
      const jump = info.fen ? this.engine.position({ fen: info.fen }) : null;
      reports = jump ? [jump] : [];
    }
    const turns = reports.map((r) => formatTurn(r, this.players)).filter(Boolean);
    if (turns.length) await this.say(turns);
    const report = this.engine.finish({ status, winner });
    this.finished = true;
    this.status = 'finished';
    this.endedAt = Date.now();
    await this.say(formatResult({ report, players: this.players, tally: this.engine.tally, gameUrl: this.gameUrl }), { ping: true });
  }

  async giveUp() {
    this.status = 'expired';
    this.endedAt = Date.now();
    await this.say(`⌛ Não encontrei a partida ${this.gameUrl ?? this.gameId} no Lichess (ou ninguém entrou nela a tempo). Parei de esperar.`);
  }

  snapshot() {
    return {
      gameId: this.gameId,
      gameUrl: this.gameUrl,
      status: this.status,
      demo: this.demo,
      moveNumber: this.moveNumber,
      players: this.players,
      tally: this.tally,
    };
  }
}

export class GameManager {
  constructor({ lichess, send, rules = DEFAULT_RULES, maxGames = 6, timing = {}, log = () => {} }) {
    this.lichess = lichess;
    this.send = send;
    this.rules = rules;
    this.maxGames = maxGames;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.log = log;
    this.sessions = new Map();
  }

  /** Partidas do Lichess sendo acompanhadas agora (o Lichess aceita até 8 streams por IP). */
  get activeCount() {
    return [...this.sessions.values()].filter((s) => s.active && !s.demo).length;
  }

  hasRoom() {
    return this.activeCount < this.maxGames;
  }

  watch({ gameId, channelId, players, intensity, clockLabel = null, waitForStartMs = null, onEnd = null, pingStart = true }) {
    const key = `${channelId}:${gameId}`;
    const existing = this.sessions.get(key);
    if (existing?.active) return { session: existing, existing: true };
    if (!this.hasRoom()) {
      const err = new Error(`Limite de ${this.maxGames} partidas simultâneas`);
      err.code = 'LIMIT';
      throw err;
    }
    const session = new GameSession({
      gameId,
      channelId,
      players,
      intensity,
      rules: this.rules,
      clockLabel,
      waitForStartMs,
      gameUrl: this.lichess.gameUrl(gameId),
      feed: {
        stream: (signal) => this.lichess.streamGame(gameId, { signal, idleMs: this.timing.idleMs }),
        exportGame: (signal) => this.lichess.exportGame(gameId, { signal }),
      },
      post: (payload) => this.send(channelId, payload),
      timing: this.timing,
      log: this.log,
      onEnd,
      pingStart,
    });
    this.sessions.set(key, session);
    session.start();
    return { session, existing: false };
  }

  demo({ channelId, feed, intensity }) {
    const running = [...this.sessions.values()].find((s) => s.demo && s.active && s.channelId === channelId);
    if (running) return { session: running, existing: true };
    demoCounter += 1;
    const session = new GameSession({
      gameId: `demo-${demoCounter}`,
      channelId,
      intensity,
      rules: this.rules,
      feed,
      demo: true,
      clockLabel: 'Partida da Ópera · Paris, 1858',
      post: (payload) => this.send(channelId, payload),
      timing: this.timing,
      log: this.log,
    });
    this.sessions.set(session.key, session);
    session.start();
    return { session, existing: false };
  }

  /** Para as partidas do canal (ou só uma). Retorna quantas parou. */
  stop(channelId, gameId = null) {
    let stopped = 0;
    for (const s of this.sessions.values()) {
      if (s.channelId !== channelId) continue;
      if (gameId && s.gameId !== gameId) continue;
      if (s.stop()) stopped += 1;
    }
    return stopped;
  }

  channelSessions(channelId, now = Date.now()) {
    for (const [key, s] of this.sessions) {
      if (!s.active && s.endedAt && now - s.endedAt > KEEP_FINISHED_MS) this.sessions.delete(key);
    }
    return [...this.sessions.values()].filter((s) => s.channelId === channelId);
  }

  scoreboard(channelId, now = Date.now()) {
    const sessions = this.channelSessions(channelId, now).filter((s) => s.started);
    const rows = new Map();
    for (const s of sessions) {
      if (s.demo) continue;
      for (const color of ['w', 'b']) {
        const p = s.players[color];
        const key = p.discordId ? `d:${p.discordId}` : p.name ? `l:${p.name.toLowerCase()}` : null;
        if (!key) continue;
        const row = rows.get(key) ?? { label: playerName(s.players, color), sips: 0, glasses: 0 };
        row.sips += s.tally[color].sips;
        row.glasses += s.tally[color].glasses;
        rows.set(key, row);
      }
    }
    const night = [...rows.values()]
      .filter((r) => r.sips > 0 || r.glasses > 0)
      .sort((a, b) => b.glasses - a.glasses || b.sips - a.sips);
    return { games: sessions.map((s) => s.snapshot()), night };
  }

  async shutdown() {
    const all = [...this.sessions.values()];
    for (const s of all) s.stop();
    await Promise.allSettled(all.map((s) => s.done));
  }
}
