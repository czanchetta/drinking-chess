import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommands, CLOCKS } from '../src/commands.js';
import { BOT_PERMISSIONS, inviteUrl, loadConfig } from '../src/config.js';
import { copos, escapeMarkdown, formatRules, formatScoreboard, formatTurn, goles, playerName } from '../src/format.js';
import { packMessages } from '../src/util.js';

test('plurais e nomes', () => {
  assert.equal(goles(1), '1 gole');
  assert.equal(goles(9), '9 goles');
  assert.equal(copos(0.5), 'meio copo');
  assert.equal(copos(1), '1 copo');
  assert.equal(copos(2.5), '2,5 copos');
  assert.equal(escapeMarkdown('magnus_carlsen*'), 'magnus\\_carlsen\\*');
  assert.equal(playerName({ w: { discordId: '42', name: 'x' } }, 'w'), '<@42>');
  assert.equal(playerName({ w: { name: 'dr_who' } }, 'w'), '**dr\\_who**');
  assert.equal(playerName({}, 'b'), '**Pretas**');
});

test('formatTurn agrupa por quem bebe e some quando ninguém bebe', () => {
  assert.equal(formatTurn({ label: '1. e4', items: [] }, {}), null);
  const text = formatTurn({
    label: '23... exf1=Q+',
    items: [
      { kind: 'capture', who: 'w', piece: 'r', count: 1, sips: 5 },
      { kind: 'promotion', who: 'w', piece: 'q', sips: 3 },
      { kind: 'check', who: 'w', sips: 1 },
    ],
  }, { w: { name: 'Ana' }, b: { name: 'Bia' } });
  assert.equal(text, '`23... exf1=Q+`\n🍺 **Ana**: perdeu uma torre ♜ (5) + viu um peão virar dama 👑 (3) + levou xeque (1) → **9 goles**');
});

test('regras refletem o objeto de regras e a intensidade', () => {
  const normal = formatRules();
  assert.match(normal, /♛ dama 9/);
  assert.match(normal, /perdeu → vira o copo/);
  const leve = formatRules(undefined, 'leve');
  assert.match(leve, /♛ dama 5/);
  assert.match(leve, /perdeu → meio copo/);
  assert.match(formatRules({ pieces: { p: 2, n: 4, b: 4, r: 6, q: 10 }, check: 0, enPassant: 0, promotion: 0, castle: 0, draw: 0, loserGlasses: 2 }), /♟ peão 2[\s\S]*perdeu → 2 copos/);
});

test('placar vazio e com partidas', () => {
  assert.match(formatScoreboard({ games: [], night: [] }), /Nenhuma partida/);
  const text = formatScoreboard({
    games: [{ gameId: 'AbCdEfGh', gameUrl: 'https://lichess.org/AbCdEfGh', status: 'live', moveNumber: 12, players: { w: { discordId: '1' }, b: { discordId: '2' } }, tally: { w: { sips: 4, glasses: 0 }, b: { sips: 1, glasses: 0 } } }],
    night: [{ label: '<@1>', sips: 4, glasses: 1 }],
  });
  assert.match(text, /ao vivo, lance 12: <@1> 4 goles · <@2> 1 gole/);
  assert.match(text, /1\. <@1> — 4 goles \+ 1 copo/);
});

test('packMessages respeita o limite do Discord', () => {
  const parts = packMessages(['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(10)]);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 1900));
  assert.equal(packMessages(['x'.repeat(5000)])[0].length, 1900);
});

test('comando /beerchess é válido para o Discord', () => {
  const [cmd] = buildCommands();
  assert.equal(cmd.name, 'beerchess');
  assert.deepEqual(cmd.options.map((o) => o.name), ['novo', 'assistir', 'placar', 'parar', 'regras', 'demo']);
  const walk = (node) => {
    assert.match(node.name, /^[-_\p{Ll}\p{N}]{1,32}$/u, node.name);
    assert.ok(node.description.length >= 1 && node.description.length <= 100, node.description);
    for (const choice of node.choices ?? []) assert.ok(choice.name.length <= 100 && choice.value.length <= 100);
    (node.options ?? []).forEach(walk);
  };
  walk(cmd);
  const novo = cmd.options[0];
  assert.deepEqual(novo.options.find((o) => o.name === 'tempo').choices.map((c) => c.value), Object.keys(CLOCKS));
  assert.equal(cmd.options[1].options[0].required, true, 'partida é obrigatória no /assistir');
});

test('config e link de convite', () => {
  assert.throws(() => loadConfig({}), /DISCORD_TOKEN/);
  const cfg = loadConfig({ DISCORD_TOKEN: ' abc ', MAX_GAMES: '50', CHALLENGE_WAIT_MINUTES: 'x', PORT: '8080' });
  assert.equal(cfg.discordToken, 'abc');
  assert.equal(cfg.maxGames, 8, 'Lichess aceita no máximo 8 streams por IP');
  assert.equal(cfg.challengeWaitMinutes, 120);
  assert.equal(cfg.port, 8080);
  assert.equal(BOT_PERMISSIONS, '274877926400');
  assert.equal(inviteUrl('123'), 'https://discord.com/oauth2/authorize?client_id=123&scope=bot%20applications.commands&permissions=274877926400');
});
