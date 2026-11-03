// Textos em português que o bot manda no Discord. Sem dependência do discord.js.

import { DEFAULT_RULES, INTENSITIES, normalizeIntensity, scaleGlasses, scaleSips } from './rules.js';

const PIECES = Object.freeze({
  p: { icon: '♟', one: 'um peão', many: 'peões' },
  n: { icon: '♞', one: 'um cavalo', many: 'cavalos' },
  b: { icon: '♝', one: 'um bispo', many: 'bispos' },
  r: { icon: '♜', one: 'uma torre', many: 'torres' },
  q: { icon: '♛', one: 'a dama', many: 'damas' },
});

const PROMOTED = Object.freeze({ q: 'dama', r: 'torre', b: 'bispo', n: 'cavalo' });

const STATUS_TEXT = Object.freeze({
  mate: 'Xeque-mate!',
  resign: 'Abandono!',
  outoftime: 'Acabou o tempo!',
  timeout: 'Saiu da partida!',
  draw: 'Empate!',
  stalemate: 'Afogamento!',
  insufficientMaterialClaim: 'Empate por material insuficiente!',
  variantEnd: 'Fim de jogo!',
  cheat: 'Partida encerrada pelo Lichess.',
  unknownFinish: 'Fim de jogo.',
  aborted: 'Partida abortada.',
  noStart: 'A partida nem começou.',
});

const SPEEDS = Object.freeze({
  ultraBullet: 'ultrabullet',
  bullet: 'bullet',
  blitz: 'blitz',
  rapid: 'rápida',
  classical: 'clássica',
  correspondence: 'sem pressa',
});

export function escapeMarkdown(text) {
  return String(text).replace(/[\\*_~`|>]/g, '\\$&');
}

export function formatNumber(n) {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

export function goles(n) {
  return `${formatNumber(n)} ${n === 1 ? 'gole' : 'goles'}`;
}

export function copos(n) {
  if (n === 0.5) return 'meio copo';
  return `${formatNumber(n)} ${n > 0 && n <= 1 ? 'copo' : 'copos'}`;
}

/** Nome para exibir: menção do Discord > usuário do Lichess > cor. */
export function playerName(players, color) {
  const p = players?.[color] ?? {};
  if (p.discordId) return `<@${p.discordId}>`;
  if (p.name) return `**${escapeMarkdown(p.name)}**`;
  return color === 'w' ? '**Brancas**' : '**Pretas**';
}

function describe(item) {
  switch (item.kind) {
    case 'capture': {
      const piece = PIECES[item.piece];
      const what = item.count > 1 ? `${item.count} ${piece.many}` : piece.one;
      return `perdeu ${what} ${piece.icon}`;
    }
    case 'enPassant':
      return 'en passant, que humilhação';
    case 'check':
      return 'levou xeque';
    case 'promotion':
      return `viu um peão virar ${PROMOTED[item.piece] ?? 'peça'} 👑`;
    default:
      return item.kind;
  }
}

/** Um lance com goles. Retorna null se ninguém bebe. */
export function formatTurn(report, players) {
  if (!report?.items?.length) return null;
  const lines = [report.jump ? '⏩ _alguns lances depois…_' : `\`${report.label}\``];
  const castle = report.items.filter((i) => i.who === 'both');
  for (const item of castle) {
    lines.push(`🏰 Roque! Brinde 🍻 ${playerName(players, 'w')} e ${playerName(players, 'b')} bebem **${goles(item.sips)}**`);
  }
  for (const color of ['w', 'b']) {
    const mine = report.items.filter((i) => i.who === color);
    if (!mine.length) continue;
    const total = mine.reduce((sum, i) => sum + (i.sips ?? 0), 0);
    const detail = mine.length === 1 ? describe(mine[0]) : mine.map((i) => `${describe(i)} (${i.sips})`).join(' + ');
    lines.push(`🍺 ${playerName(players, color)}: ${detail} → **${goles(total)}**`);
  }
  return lines.join('\n');
}

export function formatTally(tally, players) {
  const one = (color) => {
    const t = tally[color];
    const glass = t.glasses > 0 ? ` + ${copos(t.glasses)}` : '';
    return `${playerName(players, color)} ${goles(t.sips)}${glass}`;
  };
  return `${one('w')} · ${one('b')}`;
}

export function formatStart({ players, gameUrl, clockLabel, info, start, intensity, delayNote = true }) {
  const speed = clockLabel ?? SPEEDS[info?.speed] ?? info?.speed ?? '';
  const mode = info?.rated === true ? 'valendo rating' : info?.rated === false ? 'casual' : null;
  const extras = [speed, mode, intensity === 'leve' ? 'intensidade leve' : null].filter(Boolean).join(' · ');
  const lines = [
    `♟️ **Começou!** ${playerName(players, 'w')} (brancas) x ${playerName(players, 'b')} (pretas)${extras ? ` · ${extras}` : ''}`,
  ];
  if (gameUrl) lines.push(`🔗 ${gameUrl}`);
  if (start?.midGame) lines.push(`👀 Entrei no lance ${start.moveNumber} — conto a partir daqui.`);
  if (delayNote) {
    lines.push('_O Lichess entrega os lances com uns 3 de atraso para quem assiste (anti-trapaça), então os avisos chegam um pouco depois._');
  }
  return lines.join('\n');
}

export function formatResult({ report, players, tally, gameUrl, statusOverride }) {
  const result = report?.result ?? {};
  const head = STATUS_TEXT[statusOverride ?? result.status] ?? 'Fim de jogo.';
  const lines = [];
  if (result.outcome === 'win') {
    const loser = result.winner === 'w' ? 'b' : 'w';
    lines.push(`🏁 **${head}** ${playerName(players, result.winner)} venceu.`);
    const loss = report.items.find((i) => i.kind === 'loss');
    if (loss) {
      lines.push(loss.glasses === 1
        ? `🍺 ${playerName(players, loser)} **vira o copo!**`
        : `🍺 ${playerName(players, loser)} bebe **${copos(loss.glasses)}**!`);
    }
  } else if (result.outcome === 'draw') {
    const draw = report.items.find((i) => i.kind === 'draw');
    lines.push(`🤝 **${head}**${draw ? ` Brinde: ${playerName(players, 'w')} e ${playerName(players, 'b')} bebem **${goles(draw.sips)}**.` : ''}`);
  } else if (result.outcome === 'aborted') {
    lines.push(`🚫 ${head} Ninguém bebe (por enquanto).`);
  } else {
    lines.push(`🏁 ${head}`);
  }
  if (result.outcome !== 'aborted') lines.push('', `**Goles na partida:** ${formatTally(tally, players)}`);
  if (gameUrl) lines.push(`🔗 ${gameUrl}`);
  if (result.outcome !== 'aborted') lines.push('Revanche? `/beerchess novo`');
  return lines.join('\n');
}

export function formatRules(rules = DEFAULT_RULES, intensity = 'normal') {
  const key = normalizeIntensity(intensity);
  const s = (n) => scaleSips(n, key);
  const p = rules.pieces;
  const loserGlasses = scaleGlasses(rules.loserGlasses, key);
  const lines = [
    `🍺 **Regras do Beer Chess** — intensidade ${INTENSITIES[key].label}`,
    'Perdeu peça → bebe o valor dela (em goles):',
    `♟ peão ${s(p.p)} · ♞ cavalo ${s(p.n)} · ♝ bispo ${s(p.b)} · ♜ torre ${s(p.r)} · ♛ dama ${s(p.q)}`,
  ];
  if (rules.check) lines.push(`⚠️ Levou xeque → ${goles(s(rules.check))}`);
  if (rules.enPassant) lines.push(`🥷 Levou en passant → +${goles(s(rules.enPassant))} (humilhação)`);
  if (rules.promotion) lines.push(`👑 Adversário promoveu → ${goles(s(rules.promotion))}`);
  if (rules.castle) lines.push(`🏰 Roque → brinde: os dois bebem ${goles(s(rules.castle))}`);
  const end = [];
  if (loserGlasses) end.push(loserGlasses === 1 ? 'perdeu → vira o copo' : `perdeu → ${copos(loserGlasses)}`);
  if (rules.draw) end.push(`empate → os dois bebem ${goles(s(rules.draw))}`);
  if (end.length) lines.push(`🏁 Fim: ${end.join(' · ')}`);
  lines.push('_Vale com qualquer bebida, inclusive água. Bebam com moderação._ 😉');
  return lines.join('\n');
}

export function formatScoreboard({ games, night }) {
  if (!games.length) return 'Nenhuma partida por aqui ainda. Começa uma com `/beerchess novo` 🍺';
  const lines = ['🍺 **Placar**'];
  for (const g of games) {
    const state = g.status === 'live' ? `ao vivo, lance ${g.moveNumber}`
      : g.status === 'waiting' ? 'esperando os jogadores'
        : g.status === 'finished' ? 'encerrada' : 'parada';
    const title = g.demo ? 'Partida da Ópera (demo)' : `[${g.gameId}](${g.gameUrl})`;
    lines.push(`• ${title} — ${state}: ${formatTally(g.tally, g.players)}`);
  }
  if (night.length) {
    lines.push('', '🏆 **Placar da noite** (últimas 12 h)');
    night.forEach((row, index) => {
      const glass = row.glasses > 0 ? ` + ${copos(row.glasses)}` : '';
      lines.push(`${index + 1}. ${row.label} — ${goles(row.sips)}${glass}`);
    });
  }
  return lines.join('\n');
}
