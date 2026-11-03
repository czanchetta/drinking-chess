// O que cada subcomando do /beerchess faz.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { CLOCKS, DEFAULT_CLOCK } from './commands.js';
import { demoFeed } from './demo.js';
import { formatRules, formatScoreboard } from './format.js';
import { parseGameId } from './lichess.js';
import { DEFAULT_RULES, INTENSITIES, normalizeIntensity } from './rules.js';

const BEER = 0xf2a900;
const WATCH_WAIT_MS = 10 * 60_000; // /assistir: espera até 10 min a partida aparecer

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral };
}

function friendlyError(err) {
  if (err?.code === 'LIMIT') return `${err.message}. Termina uma antes (ou usa \`/beerchess parar\`).`;
  if (err?.name === 'LichessError') {
    if (err.status === 429) return 'o Lichess pediu um tempinho (limite de requisições). Tenta de novo em 1 minuto.';
    return `o Lichess respondeu: ${err.message}`;
  }
  return 'algo deu errado aqui. Tenta de novo daqui a pouco.';
}

export function createHandler({ manager, lichess, rules = DEFAULT_RULES, challengeWaitMs, demoDelayMs = 2_000, log = () => {} }) {
  const players = (interaction) => ({
    w: { discordId: interaction.options.getUser('brancas')?.id },
    b: { discordId: interaction.options.getUser('pretas')?.id },
  });

  async function novo(interaction) {
    const clockKey = interaction.options.getString('tempo') ?? DEFAULT_CLOCK;
    const clock = CLOCKS[clockKey] ?? CLOCKS[DEFAULT_CLOCK];
    const intensity = normalizeIntensity(interaction.options.getString('intensidade'));
    if (!manager.hasRoom()) {
      await interaction.reply(ephemeral(`🍻 Já tem ${manager.maxGames} partidas rolando. Termina uma antes (ou usa \`/beerchess parar\`).`));
      return;
    }
    await interaction.deferReply();
    const challenge = await lichess.createOpenChallenge({
      clockLimit: clock.limit,
      clockIncrement: clock.increment,
      expiresInMs: challengeWaitMs,
    });
    const who = players(interaction);
    manager.watch({
      gameId: challenge.id,
      channelId: interaction.channelId,
      players: who,
      intensity,
      clockLabel: clock.label,
      waitForStartMs: challengeWaitMs,
    });
    const mentions = [
      who.w.discordId && `<@${who.w.discordId}> joga de **brancas**`,
      who.b.discordId && `<@${who.b.discordId}> de **pretas**`,
    ].filter(Boolean);
    const embed = new EmbedBuilder()
      .setColor(BEER)
      .setTitle('🍺 Beer Chess — partida criada')
      .setDescription([
        `${clock.label} · casual · intensidade ${INTENSITIES[intensity].label}`,
        'Cada um clica no botão da sua cor — não precisa de conta no Lichess.',
        'Eu aviso aqui quem bebe. Regras: `/beerchess regras`',
      ].join('\n'))
      .setFooter({ text: `Partida ${challenge.id}` });
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(challenge.urlWhite).setLabel('Jogar de brancas').setEmoji('⬜'),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(challenge.urlBlack).setLabel('Jogar de pretas').setEmoji('⬛'),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(challenge.url).setLabel('Assistir').setEmoji('👀'),
    );
    await interaction.editReply({
      content: mentions.length ? `${mentions.join(', ')} — cliquem no botão da sua cor 👇` : '',
      embeds: [embed],
      components: [buttons],
      allowedMentions: { users: [...new Set([who.w.discordId, who.b.discordId].filter(Boolean))] },
    });
  }

  async function assistir(interaction) {
    const gameId = parseGameId(interaction.options.getString('partida', true));
    if (!gameId) {
      await interaction.reply(ephemeral('Não entendi esse link. Manda algo como `https://lichess.org/AbCdEfGh` ou só o código `AbCdEfGh`.'));
      return;
    }
    const { existing } = manager.watch({
      gameId,
      channelId: interaction.channelId,
      players: players(interaction),
      intensity: normalizeIntensity(interaction.options.getString('intensidade')),
      waitForStartMs: WATCH_WAIT_MS,
    });
    await interaction.reply(existing
      ? ephemeral('Já estou de olho nessa partida aqui 👀')
      : { content: `👀 Combinado! Acompanhando ${lichess.gameUrl(gameId)} — aviso aqui quem bebe.`, allowedMentions: { parse: [] } });
  }

  async function placar(interaction) {
    const text = formatScoreboard(manager.scoreboard(interaction.channelId));
    await interaction.reply({ content: text.slice(0, 2000), allowedMentions: { parse: [] } });
  }

  async function parar(interaction) {
    const raw = interaction.options.getString('partida');
    const gameId = raw ? parseGameId(raw) : null;
    if (raw && !gameId) {
      await interaction.reply(ephemeral('Não entendi esse link/código.'));
      return;
    }
    const count = manager.stop(interaction.channelId, gameId);
    await interaction.reply(count
      ? `⏹️ Parei de acompanhar ${count === 1 ? '1 partida' : `${count} partidas`}. O placar continua no \`/beerchess placar\`.`
      : ephemeral('Não tinha nenhuma partida rolando neste canal.'));
  }

  async function regras(interaction) {
    await interaction.reply({ content: formatRules(rules, interaction.options.getString('intensidade')), allowedMentions: { parse: [] } });
  }

  async function demo(interaction) {
    const { existing } = manager.demo({
      channelId: interaction.channelId,
      feed: demoFeed({ delayMs: demoDelayMs }),
      intensity: normalizeIntensity(interaction.options.getString('intensidade')),
    });
    await interaction.reply(existing
      ? ephemeral('Já tem uma demo rolando aqui — espera ela acabar 🍿')
      : '🎭 Reprise da **Partida da Ópera** (Paris, 1858): Morphy sacrifica a dama e dá mate em 17 lances. Acompanha aqui 👇');
  }

  const routes = { novo, assistir, placar, parar, regras, demo };

  return async function onInteraction(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'beerchess') return;
    if (!interaction.inGuild()) {
      await interaction.reply(ephemeral('Usa o /beerchess dentro de um servidor 😉'));
      return;
    }
    const sub = interaction.options.getSubcommand();
    const route = routes[sub];
    if (!route) return;
    try {
      await route(interaction);
    } catch (err) {
      log(`/beerchess ${sub} falhou: ${err?.stack ?? err}`);
      const content = `💥 Não deu: ${friendlyError(err)}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
      } else {
        await interaction.reply(ephemeral(content)).catch(() => {});
      }
    }
  };
}
