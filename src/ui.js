// Mensagens com botões da mesa de Beer Chess (/beerchess mesa).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { copos, goles } from './format.js';
import { INTENSITIES } from './rules.js';

const BEER = 0xf2a900;
const MAX_LISTED = 20;

export const mention = (id) => `<@${id}>`;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const partidas = (n) => `${n} ${n === 1 ? 'partida' : 'partidas'}`;

// custom_id dos botões: bc:m:<mesa>:<ação>:<L = mensagem da mesa | P = post da partida/pausa>
//                       bc:l:<mesa>:<partida>  (🎟️ Meu link)
export function controlId(table, action, where) {
  return `bc:m:${table.id}:${action}:${where}`;
}

export function linkId(table, game) {
  return `bc:l:${table.id}:${game.gameId}`;
}

export function parseCustomId(customId) {
  const parts = String(customId ?? '').split(':');
  if (parts[0] !== 'bc') return null;
  if (parts[1] === 'm' && parts.length === 5) return { kind: 'mesa', tableId: parts[2], action: parts[3], where: parts[4] };
  if (parts[1] === 'l' && parts.length === 4) return { kind: 'link', tableId: parts[2], gameId: parts[3] };
  return null;
}

function control(table, action, where, label, emoji, style, disabled) {
  return new ButtonBuilder()
    .setCustomId(controlId(table, action, where))
    .setLabel(label)
    .setEmoji(emoji)
    .setStyle(style)
    .setDisabled(Boolean(disabled));
}

export function controlsRow(table, where, { withStart = true } = {}) {
  const closed = table.status === 'encerrada';
  const ending = closed || table.closing;
  const row = new ActionRowBuilder().addComponents(
    control(table, 'entrar', where, 'Entrar', '🙋', ButtonStyle.Success, ending),
    control(table, 'sair', where, 'Sair', '🚪', ButtonStyle.Secondary, closed),
  );
  if (withStart) {
    const blocked = ending || table.status === 'jogando' || table.seatedCount < 2;
    row.addComponents(control(table, 'comecar', where, table.gameCount ? 'Continuar' : 'Começar', '▶️', ButtonStyle.Primary, blocked));
  }
  row.addComponents(control(table, 'encerrar', where, 'Encerrar mesa', '🛑', ButtonStyle.Danger, ending));
  return row;
}

function statusText(table) {
  if (table.status === 'encerrada') return `Mesa encerrada · ${partidas(table.played)}`;
  if (table.closing) return `Última partida rolando (partida ${table.current?.number ?? table.gameCount})`;
  if (table.status === 'jogando') return `Rolando a partida ${table.current?.number ?? table.gameCount}`;
  if (table.status === 'pausada') return 'Mesa pausada';
  return 'Esperando a galera';
}

/** A mensagem fixa da mesa (resposta do /beerchess mesa), atualizada quando alguém entra ou sai. */
export function lobbyPayload(table) {
  const seated = [...table.seated];
  const listed = seated.slice(0, MAX_LISTED).map((id, i) => `${i + 1}. ${mention(id)}${id === table.hostId ? ' · anfitrião' : ''}`);
  if (seated.length > MAX_LISTED) listed.push(`… e mais ${seated.length - MAX_LISTED}`);
  const embed = new EmbedBuilder()
    .setColor(BEER)
    .setTitle('🍺 Mesa de Beer Chess')
    .setDescription([
      `**${capitalize(table.formatInfo.label)}:** ${table.formatInfo.hint}.`,
      `⏱️ ${table.clock.label} · casual · intensidade ${INTENSITIES[table.intensity].label}`,
      '',
      'Cliquem em 🙋 **Entrar**. Com 2 ou mais, ▶️ **Começar**: eu sorteio quem joga com quem, cada jogador pega o link da sua cor e quem estiver de fora assiste.',
    ].join('\n'))
    .addFields({ name: `Na mesa (${seated.length})`, value: listed.join('\n') || '_ninguém ainda_' })
    .setFooter({ text: statusText(table) });
  return { embeds: [embed], components: [controlsRow(table, 'L')], allowedMentions: { parse: [] } };
}

/** Post de cada partida da mesa: quem joga, quem espera e o botão 🎟️ Meu link. */
export function pairingPayload(table, game, { note = null } = {}) {
  const lines = [];
  if (note) lines.push(note);
  lines.push(`♟️ **Partida ${game.number}** · ${table.formatInfo.label} · ${table.clock.label}`);
  lines.push(`⬜ ${mention(game.white)} **x** ⬛ ${mention(game.black)}`);
  const king = table.king;
  if (table.format === 'rei' && king && (king.id === game.white || king.id === game.black)) {
    lines.push(`👑 ${mention(king.id)} segue na mesa: ${king.streak === 1 ? '1 vitória' : `${king.streak} vitórias seguidas`}`);
  }
  const waiting = table.waiting(game);
  if (waiting.length) {
    lines.push(table.format === 'rei'
      ? `⏳ Na fila: ${waiting.map(mention).join(' → ')}`
      : `👀 Assistindo: ${waiting.map(mention).join(', ')}`);
  }
  lines.push('Cliquem em 🎟️ **Meu link**: cada jogador recebe o link da própria cor (só ele vê) e quem está de fora recebe o link para assistir.');
  const links = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(linkId(table, game)).setLabel('Meu link').setEmoji('🎟️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setURL(game.urls.url).setLabel('Assistir').setEmoji('👀').setStyle(ButtonStyle.Link),
  );
  return {
    content: lines.join('\n'),
    components: [links, controlsRow(table, 'P', { withStart: false })],
    allowedMentions: { users: [game.white, game.black] },
  };
}

const PAUSES = Object.freeze({
  faltam: () => '⏸️ Mesa pausada: precisa de pelo menos 2 jogadores. Assim que mais alguém clicar em 🙋 **Entrar**, eu sigo sozinho.',
  ausentes: (g) => `⏸️ Ninguém entrou na partida ${g.number} a tempo. Mesa pausada: cliquem em ▶️ **Continuar** quando voltarem.`,
  abortada: (g) => `⏸️ A partida ${g.number} foi abortada no Lichess. ▶️ **Continuar** cria outra.`,
  parada: (g) => `⏸️ Pararam de acompanhar a partida ${g.number}. ▶️ **Continuar** cria a próxima.`,
  erro: (g) => `⏸️ Perdi o fio da partida ${g.number}. ▶️ **Continuar** cria a próxima.`,
  limite: () => '⏸️ O bot já está acompanhando o máximo de partidas ao mesmo tempo. ▶️ **Continuar** quando alguma acabar.',
  lichess: (g, detail) => `⏸️ Não consegui criar a partida no Lichess${detail ? ` (${detail})` : ''}. ▶️ **Continuar** tenta de novo.`,
});

export function pausePayload(table, { reason, game = null, note = null, detail = null }) {
  const text = (PAUSES[reason] ?? PAUSES.erro)(game ?? { number: table.gameCount }, detail);
  return {
    content: [note, text].filter(Boolean).join('\n'),
    components: [controlsRow(table, 'P')],
    allowedMentions: { parse: [] },
  };
}

function drinks(stats) {
  return `${goles(stats.sips)}${stats.glasses > 0 ? ` + ${copos(stats.glasses)}` : ''}`;
}

export function closedPayload(table) {
  const played = [...table.stats.values()].filter((s) => s.games > 0);
  if (!played.length) {
    return { content: '🏁 **Mesa encerrada.** Ninguém chegou a jogar — fica para a próxima 🍻', allowedMentions: { parse: [] } };
  }
  const byWins = [...played].sort((a, b) => b.wins - a.wins || a.losses - b.losses);
  const byDrinks = [...played].sort((a, b) => b.glasses - a.glasses || b.sips - a.sips);
  return {
    content: [
      `🏁 **Mesa encerrada** depois de ${partidas(table.played)}.`,
      `🏆 Vitórias: ${byWins.map((s) => `${mention(s.id)} ${s.wins}`).join(' · ')}`,
      `🍺 Goles: ${byDrinks.map((s) => `${mention(s.id)} ${drinks(s)}`).join(' · ')}`,
    ].join('\n'),
    allowedMentions: { parse: [] },
  };
}

/** Resposta do 🎟️ Meu link: só quem clicou vê. */
export function linkReply(table, game, userId) {
  const over = game.session ? !game.session.active : false;
  let content;
  let url = game.urls.url;
  let label = 'Assistir';
  let emoji = '👀';
  if (!over && userId === game.white) {
    content = `⬜ Você joga de **brancas** na partida ${game.number}. Esse link é só seu: não passe adiante.`;
    url = game.urls.urlWhite;
    label = 'Jogar de brancas';
    emoji = '⬜';
  } else if (!over && userId === game.black) {
    content = `⬛ Você joga de **pretas** na partida ${game.number}. Esse link é só seu: não passe adiante.`;
    url = game.urls.urlBlack;
    label = 'Jogar de pretas';
    emoji = '⬛';
  } else if (over) {
    content = `A partida ${game.number} já acabou. Dá para rever no Lichess:`;
    label = 'Ver partida';
  } else {
    content = `👀 Você está de fora da partida ${game.number}: dá para assistir ao vivo.`;
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setURL(url).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Link),
  );
  return { content, components: [row], flags: MessageFlags.Ephemeral };
}

/** Linha da mesa no /beerchess placar. */
export function tableLine(table) {
  const parts = [`🪑 **Mesa** (${table.formatInfo.label})`, partidas(table.played)];
  if (table.current) parts.push(`agora: ${mention(table.current.white)} x ${mention(table.current.black)}`);
  if (table.format === 'rei' && table.king) {
    parts.push(`👑 ${mention(table.king.id)} (${table.king.streak} ${table.king.streak === 1 ? 'vitória' : 'seguidas'})`);
  }
  if (table.status === 'pausada') parts.push('pausada');
  return parts.join(' · ');
}
