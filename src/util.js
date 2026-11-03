/** Espera `ms`, mas acorda na hora se o sinal for abortado. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Divide textos em mensagens de até `limit` caracteres (limite do Discord é 2000). */
export function packMessages(texts, limit = 1900) {
  const out = [];
  let current = '';
  for (const text of texts.filter(Boolean)) {
    const next = current ? `${current}\n\n${text}` : text;
    if (next.length <= limit) {
      current = next;
    } else {
      if (current) out.push(current);
      current = text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
    }
  }
  if (current) out.push(current);
  return out;
}

export function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
