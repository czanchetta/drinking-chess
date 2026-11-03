// Dublês para testar a mesa e os botões sem Discord nem Lichess de verdade.

import { START_FEN } from '../../src/engine.js';

/** Sessão de partida controlada pelo teste. */
export class FakeSession {
  constructor(opts) {
    this.opts = opts;
    this.gameId = opts.gameId;
    this.onEnd = opts.onEnd;
    this.players = opts.players;
    this.status = 'waiting';
    this.started = false;
    this.engine = { result: null, tally: { w: { sips: 0, glasses: 0 }, b: { sips: 0, glasses: 0 } } };
  }

  get active() {
    return this.status === 'waiting' || this.status === 'live';
  }

  stop() {
    if (!this.active) return false;
    this.status = 'stopped';
    this.onEnd?.(this);
    return true;
  }

  begin() {
    this.started = true;
    this.status = 'live';
  }

  /** winner: 'w' | 'b' | null (empate) | 'aborted' */
  end(winner, tally = null) {
    this.started = true;
    this.status = 'finished';
    const outcome = winner === 'aborted' ? 'aborted' : winner ? 'win' : 'draw';
    this.engine.result = { status: 'resign', winner: winner === 'w' || winner === 'b' ? winner : null, outcome };
    if (tally) this.engine.tally = tally;
    this.onEnd?.(this);
  }

  expire() {
    this.status = 'expired';
    this.onEnd?.(this);
  }
}

export class FakeManager {
  constructor() {
    this.sessions = [];
    this.room = true;
  }

  hasRoom() {
    return this.room;
  }

  watch(opts) {
    if (!this.room) throw Object.assign(new Error('Limite'), { code: 'LIMIT' });
    const session = new FakeSession(opts);
    this.sessions.push(session);
    return { session, existing: false };
  }

  get last() {
    return this.sessions[this.sessions.length - 1];
  }
}

function challengeFor(prefix, n) {
  const id = `${prefix}${String(n).padStart(4, '0')}`;
  const url = `https://lichess.org/${id}`;
  return { id, url, urlWhite: `${url}?color=white`, urlBlack: `${url}?color=black` };
}

/** Lichess falso: cria desafios com ids em sequência e, se pedirem stream, fica esperando. */
export function fakeLichess(prefix = 'Game') {
  let n = 0;
  const calls = [];
  return {
    calls,
    fail: null,
    gameUrl: (id) => `https://lichess.org/${id}`,
    async createOpenChallenge(opts) {
      calls.push(opts);
      if (this.fail) throw this.fail;
      n += 1;
      return challengeFor(prefix, n);
    },
    async *streamGame(_id, { signal } = {}) {
      await new Promise((resolve) => {
        if (!signal || signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
    },
    async exportGame() {
      throw Object.assign(new Error('sem export'), { status: 404 });
    },
  };
}

/** Lichess falso com stream controlado pelo teste: lichess.feed(id).push(msg). */
export function scriptedLichess(prefix = 'Real') {
  const base = fakeLichess(prefix);
  const feeds = new Map();
  const feed = (id) => {
    if (!feeds.has(id)) {
      const items = [];
      let wake = null;
      feeds.set(id, {
        push(msg) {
          items.push(msg);
          wake?.();
        },
        async *iterate(signal) {
          while (!signal?.aborted) {
            if (items.length) {
              yield items.shift();
              continue;
            }
            await new Promise((resolve) => {
              wake = resolve;
              signal?.addEventListener('abort', resolve, { once: true });
            });
            wake = null;
          }
        },
      });
    }
    return feeds.get(id);
  };
  base.feed = feed;
  base.streamGame = async function* streamGame(id, { signal } = {}) {
    yield* feed(id).iterate(signal);
  };
  return base;
}

export function gameInfo(id, overrides = {}) {
  return {
    id,
    variant: { key: 'standard', name: 'Standard' },
    speed: 'blitz',
    rated: false,
    initialFen: START_FEN,
    fen: START_FEN,
    turns: 0,
    status: { id: 20, name: 'started' },
    players: { white: {}, black: {} },
    ...overrides,
  };
}

/** Interação do Discord de mentira: guarda as chamadas em `calls`. */
export function fakeInteraction({ kind, sub = null, options = {}, customId = null, userId, channelId = 'c1' }) {
  const calls = [];
  const it = {
    calls,
    kind,
    channelId,
    customId,
    commandName: 'beerchess',
    user: { id: userId, username: `user${userId}`, globalName: null },
    member: { displayName: `Jogador ${userId}` },
    deferred: false,
    replied: false,
    isButton: () => kind === 'button',
    isChatInputCommand: () => kind === 'command',
    inGuild: () => true,
    options: {
      getSubcommand: () => sub,
      getString: (name) => options[name] ?? null,
      getUser: (name) => (options[name] ? { id: options[name] } : null),
    },
    async reply(payload) {
      it.replied = true;
      calls.push(['reply', payload]);
    },
    async update(payload) {
      it.replied = true;
      calls.push(['update', payload]);
    },
    async deferUpdate() {
      it.deferred = true;
      calls.push(['deferUpdate']);
    },
    async deferReply() {
      it.deferred = true;
      calls.push(['deferReply']);
    },
    async editReply(payload) {
      calls.push(['editReply', payload]);
    },
    async followUp(payload) {
      calls.push(['followUp', payload]);
    },
  };
  return it;
}

/** Componentes de uma mensagem em JSON (valida os builders do discord.js no caminho). */
export function componentsJson(payload) {
  return (payload.components ?? []).map((row) => (typeof row.toJSON === 'function' ? row.toJSON() : row));
}

export function buttons(payload) {
  return componentsJson(payload).flatMap((row) => row.components);
}

/** PRNG determinístico (mulberry32). */
export function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
