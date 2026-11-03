// Configuração via variáveis de ambiente (ou arquivo .env na pasta do projeto).

function intOr(value, fallback) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// Ver Canais + Enviar Mensagens + Inserir Links + Enviar Mensagens em Tópicos
export const BOT_PERMISSIONS = String(1024 + 2048 + 16384 + 2 ** 38);

export function inviteUrl(applicationId) {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`;
}

export function loadConfig(env = process.env) {
  const discordToken = env.DISCORD_TOKEN?.trim();
  if (!discordToken) {
    throw new Error('Falta a variável DISCORD_TOKEN (o token do bot, no Discord Developer Portal). Veja o README.');
  }
  return {
    discordToken,
    guildId: env.DISCORD_GUILD_ID?.trim() || null,
    lichessToken: env.LICHESS_TOKEN?.trim() || null,
    lichessUrl: env.LICHESS_URL?.trim() || 'https://lichess.org',
    userAgent: env.USER_AGENT?.trim() || 'beer-chess-discord-bot/1.0',
    port: intOr(env.PORT, null),
    // O Lichess aceita no máximo 8 streams de partida por IP.
    maxGames: clamp(intOr(env.MAX_GAMES, 6), 1, 8),
    challengeWaitMinutes: clamp(intOr(env.CHALLENGE_WAIT_MINUTES, 120), 5, 24 * 60),
  };
}
