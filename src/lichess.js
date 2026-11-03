// Cliente mínimo da API pública do Lichess (https://lichess.org/api).
// Nenhum endpoint usado aqui exige token; LICHESS_TOKEN é opcional.

export class LichessError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LichessError';
    this.status = status;
  }
}

const GAME_ID = /^[A-Za-z0-9]{8}(?:[A-Za-z0-9]{4})?$/;
const SKIP_SEGMENTS = new Set(['embed', 'game', 'export', 'api', 'stream']);

/** Aceita link de partida/desafio do Lichess (inclusive com /white, /black ou id de jogador) ou o código de 8 letras. */
export function parseGameId(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  let candidate = text;
  if (/lichess\.org/i.test(text)) {
    try {
      const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
      candidate = url.pathname.split('/').filter((s) => s && !SKIP_SEGMENTS.has(s.toLowerCase()))[0] ?? '';
    } catch {
      return null;
    }
  }
  return GAME_ID.test(candidate) ? candidate.slice(0, 8) : null;
}

/** Lê NDJSON de um corpo de resposta (ignora as linhas vazias de keep-alive). */
export async function* readNdjson(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const parsed = safeJson(line);
        if (parsed !== undefined) yield parsed;
      }
      newline = buffer.indexOf('\n');
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) {
    const parsed = safeJson(rest);
    if (parsed !== undefined) yield parsed;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readJson(res) {
  const text = await res.text();
  return text ? safeJson(text) : undefined;
}

export class LichessClient {
  constructor({ baseUrl = 'https://lichess.org', token = null, userAgent = 'beer-chess-discord-bot/1.0', fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
  }

  gameUrl(id) {
    return `${this.baseUrl}/${id}`;
  }

  headers(extra = {}) {
    const headers = { 'User-Agent': this.userAgent, ...extra };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  async request(path, init = {}) {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (err) {
      if (err?.name === 'AbortError' || init.signal?.aborted) throw err;
      throw new LichessError(`Sem conexão com o Lichess (${err?.message ?? err})`, 0);
    }
  }

  /**
   * Desafio aberto e casual: qualquer pessoa com o link entra (sem precisar de conta).
   * clockLimit/clockIncrement em segundos; clockLimit null = sem relógio.
   */
  async createOpenChallenge({ clockLimit = 300, clockIncrement = 3, name = 'Beer Chess', expiresInMs = null } = {}) {
    const body = new URLSearchParams({ rated: 'false', variant: 'standard', rules: 'noRematch' });
    if (clockLimit != null) {
      body.set('clock.limit', String(clockLimit));
      body.set('clock.increment', String(clockIncrement ?? 0));
    }
    if (name) body.set('name', name);
    if (expiresInMs) body.set('expiresAt', String(Date.now() + expiresInMs));
    const res = await this.request('/api/challenge/open', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }),
      body: body.toString(),
    });
    const data = await readJson(res);
    if (!res.ok) throw new LichessError(errorText(data, res), res.status);
    if (!data?.id) throw new LichessError('Resposta inesperada do Lichess ao criar o desafio', res.status);
    const url = data.url ?? this.gameUrl(data.id);
    return {
      id: data.id,
      url,
      urlWhite: data.urlWhite ?? `${url}?color=white`,
      urlBlack: data.urlBlack ?? `${url}?color=black`,
    };
  }

  /** Partida exportada em JSON: { status, winner, moves: [SAN...], initialFen }. */
  async exportGame(id, { signal } = {}) {
    const query = 'moves=true&clocks=false&evals=false&opening=false&literate=false&pgnInJson=false';
    const res = await this.request(`/game/export/${encodeURIComponent(id)}?${query}`, {
      headers: this.headers({ Accept: 'application/json' }),
      signal,
    });
    const data = await readJson(res);
    if (!res.ok) throw new LichessError(errorText(data, res), res.status);
    return {
      status: data?.status ?? null,
      winner: data?.winner ?? null,
      moves: typeof data?.moves === 'string' && data.moves.trim() ? data.moves.trim().split(/\s+/) : [],
      initialFen: data?.initialFen ?? null,
    };
  }

  /**
   * Stream de posições de uma partida (GET /api/stream/game/{id}).
   * Primeiro vem a descrição da partida, depois { fen, lm, wc, bc } a cada lance e,
   * no fim, a descrição de novo com o resultado. Se nada chegar em `idleMs`
   * (nem keep-alive), a conexão é derrubada para o chamador reconectar.
   */
  async *streamGame(id, { signal, idleMs = 120_000 } = {}) {
    const local = new AbortController();
    const onAbort = () => local.abort(signal.reason);
    if (signal) {
      if (signal.aborted) return;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => local.abort(new LichessError('Stream parado', 0)), idleMs);
    };
    try {
      arm();
      const res = await this.request(`/api/stream/game/${encodeURIComponent(id)}`, {
        headers: this.headers({ Accept: 'application/x-ndjson' }),
        signal: local.signal,
      });
      if (!res.ok) {
        const data = await readJson(res).catch(() => undefined);
        throw new LichessError(errorText(data, res), res.status);
      }
      if (!res.body) return;
      const touched = (async function* touch(body) {
        for await (const chunk of body) {
          arm();
          yield chunk;
        }
      })(res.body);
      yield* readNdjson(touched);
    } catch (err) {
      if (signal?.aborted) return;
      if (local.signal.aborted && local.signal.reason instanceof LichessError) throw local.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      local.abort();
    }
  }
}

function errorText(data, res) {
  if (data && typeof data.error === 'string') return data.error;
  if (data && typeof data.error === 'object') return JSON.stringify(data.error);
  return `HTTP ${res.status}`;
}
