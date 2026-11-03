// Ponto de entrada: conecta no Discord, registra o /beerchess e liga as partidas.

import http from 'node:http';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { buildCommands } from './commands.js';
import { inviteUrl, loadConfig } from './config.js';
import { createHandler } from './handlers.js';
import { LichessClient } from './lichess.js';
import { GameManager } from './session.js';
import { timestamp } from './util.js';

const log = (...args) => console.log(`[${timestamp()}]`, ...args);

try {
  process.loadEnvFile();
} catch {
  // sem .env: usa só as variáveis de ambiente
}

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const lichess = new LichessClient({
  baseUrl: config.lichessUrl,
  token: config.lichessToken,
  userAgent: config.userAgent,
});

const manager = new GameManager({
  lichess,
  log,
  maxGames: config.maxGames,
  send: async (channelId, payload) => {
    const channel = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));
    if (!channel?.isSendable()) throw new Error('não tenho permissão para mandar mensagem nesse canal');
    return channel.send(payload);
  },
});

const onInteraction = createHandler({
  manager,
  lichess,
  log,
  challengeWaitMs: config.challengeWaitMinutes * 60_000,
});

client.once(Events.ClientReady, async (ready) => {
  log(`Conectado como ${ready.user.tag} em ${ready.guilds.cache.size} servidor(es)`);
  try {
    const commands = buildCommands();
    if (config.guildId) await ready.application.commands.set(commands, config.guildId);
    else await ready.application.commands.set(commands);
    log(`/beerchess registrado ${config.guildId ? `no servidor ${config.guildId}` : 'em todos os servidores'}`);
  } catch (err) {
    log('Falha ao registrar os comandos:', err?.message ?? err);
  }
  log(`Link para convidar o bot: ${inviteUrl(ready.application.id)}`);
});

client.on(Events.InteractionCreate, (interaction) => {
  onInteraction(interaction).catch((err) => log('Erro na interação:', err?.stack ?? err));
});

client.on(Events.Error, (err) => log('Erro do Discord:', err?.message ?? err));
process.on('unhandledRejection', (err) => log('Promessa rejeitada sem tratamento:', err?.stack ?? err));

let server = null;
if (config.port) {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, discord: client.isReady(), games: manager.activeCount }));
  });
  server.listen(config.port, () => log(`Health check em :${config.port}`));
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log(`${signal} recebido, desligando…`);
  await manager.shutdown().catch(() => {});
  await client.destroy().catch(() => {});
  server?.close();
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.discordToken).catch((err) => {
  console.error(`Não consegui entrar no Discord: ${err?.message ?? err}. Confira o DISCORD_TOKEN e a conexão.`);
  process.exit(1);
});
