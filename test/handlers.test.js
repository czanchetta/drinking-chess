import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from '../src/handlers.js';
import { GameManager } from '../src/session.js';
import { TableManager } from '../src/table.js';
import { buttons, fakeInteraction, fakeLichess } from './helpers/fakes.js';

const EPHEMERAL = 64;

function setup() {
  const posts = [];
  const send = async (channelId, payload) => {
    posts.push({ channelId, ...payload });
    return { id: String(posts.length) };
  };
  const lichess = fakeLichess('Hndl');
  const manager = new GameManager({ lichess, send, timing: { pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20 } });
  const tables = new TableManager({ manager, lichess, send, random: () => 0.9999, challengeWaitMs: 60_000 });
  const handle = createHandler({ manager, lichess, tables, challengeWaitMs: 60_000 });
  return { posts, lichess, manager, tables, handle };
}

const button = (customId, userId) => fakeInteraction({ kind: 'button', customId, userId });
const command = (sub, userId, options = {}) => fakeInteraction({ kind: 'command', sub, userId, options });

test('mesa pelo Discord: abrir, entrar, começar, meu link, sair, encerrar', async () => {
  const { posts, tables, manager, handle } = setup();
  const open = command('mesa', 'A', { formato: 'rei', tempo: '3+2', intensidade: 'leve' });
  await handle(open);
  const [kind, lobby] = open.calls[0];
  assert.equal(kind, 'reply');
  const embed = lobby.embeds[0].toJSON();
  assert.equal(embed.title, '🍺 Mesa de Beer Chess');
  assert.match(embed.description, /Quem ganha fica:\*\* quem ganha continua na mesa/);
  assert.match(embed.description, /3\+2 · casual · intensidade leve/);
  assert.equal(embed.fields[0].name, 'Na mesa (1)');
  assert.match(embed.fields[0].value, /1\. <@A> · anfitrião/);
  const table = tables.inChannel('c1');
  assert.deepEqual(buttons(lobby).map((b) => b.custom_id), ['entrar', 'sair', 'comecar', 'encerrar'].map((a) => `bc:m:${table.id}:${a}:L`));
  assert.equal(buttons(lobby)[2].disabled, true, 'Começar só com 2 na mesa');

  const again = command('mesa', 'B');
  await handle(again);
  assert.equal(again.calls[0][1].flags, EPHEMERAL, 'uma mesa por canal');

  const joinB = button(`bc:m:${table.id}:entrar:L`, 'B');
  await handle(joinB);
  assert.equal(joinB.calls[0][0], 'update', 'a mensagem da mesa é atualizada no lugar');
  assert.match(joinB.calls[0][1].embeds[0].toJSON().fields[0].value, /2\. <@B>/);
  assert.equal(buttons(joinB.calls[0][1])[2].disabled, false);

  const twice = button(`bc:m:${table.id}:entrar:L`, 'B');
  await handle(twice);
  assert.equal(twice.calls[0][1].flags, EPHEMERAL);

  const outsider = button(`bc:m:${table.id}:comecar:L`, 'Z');
  await handle(outsider);
  assert.match(outsider.calls[0][1].content, /Entra na mesa primeiro/);

  await handle(button(`bc:m:${table.id}:entrar:L`, 'C'));
  const go = button(`bc:m:${table.id}:comecar:L`, 'A');
  await handle(go);
  assert.deepEqual(go.calls.map((c) => c[0]), ['deferUpdate', 'editReply']);
  assert.equal(go.calls[1][1].embeds[0].toJSON().footer.text, 'Rolando a partida 1');
  assert.ok(posts.some((p) => p.content?.includes('**Partida 1**')));
  const game = table.current;

  for (const [userId, url, label] of [
    [game.white, game.urls.urlWhite, 'Jogar de brancas'],
    [game.black, game.urls.urlBlack, 'Jogar de pretas'],
    ['C', game.urls.url, 'Assistir'],
  ]) {
    const click = button(`bc:l:${table.id}:${game.gameId}`, userId);
    await handle(click);
    const [type, reply] = click.calls[0];
    assert.equal(type, 'reply');
    assert.equal(reply.flags, EPHEMERAL, 'só quem clicou vê o link');
    const [link] = buttons(reply);
    assert.equal(link.url, url);
    assert.equal(link.label, label);
  }

  const leave = button(`bc:m:${table.id}:sair:P`, 'C');
  await handle(leave);
  assert.match(leave.calls[0][1].content, /🚪 <@C> saiu da mesa\./);
  assert.equal(table.isSeated('C'), false);

  const stale = button('bc:m:deadbeef:entrar:L', 'A');
  await handle(stale);
  assert.match(stale.calls[0][1].content, /não existe mais/);

  const end = button(`bc:m:${table.id}:encerrar:P`, 'B');
  await handle(end);
  assert.deepEqual(end.calls.map((c) => c[0]), ['deferUpdate']);
  await table.idle();
  assert.equal(table.status, 'encerrada');
  assert.match(posts[posts.length - 1].content, /Mesa encerrada/);
  assert.equal(manager.activeCount, 0, 'parou a partida que ninguém começou');

  const late = button(`bc:m:${table.id}:entrar:L`, 'D');
  await handle(late);
  assert.match(late.calls[0][1].content, /já foi encerrada/);
  await manager.shutdown();
});

test('/beerchess placar mostra a mesa e /beerchess parar fecha ela', async () => {
  const { tables, manager, handle } = setup();
  await handle(command('mesa', 'A'));
  const table = tables.inChannel('c1');
  await handle(button(`bc:m:${table.id}:entrar:L`, 'B'));
  await handle(button(`bc:m:${table.id}:comecar:L`, 'A'));

  const board = command('placar', 'A');
  await handle(board);
  assert.match(board.calls[0][1].content, /🪑 \*\*Mesa\*\* \(quem ganha fica\) · 0 partidas · agora: <@B> x <@A>/);

  const stop = command('parar', 'A');
  await handle(stop);
  assert.equal(stop.calls[0][0], 'reply');
  assert.match(stop.calls[0][1].content, /Mesa encerrada/);
  assert.equal(tables.inChannel('c1'), null);
  assert.equal(manager.activeCount, 0);

  const nothing = command('parar', 'A');
  await handle(nothing);
  assert.equal(nothing.calls[0][1].flags, EPHEMERAL);
  await manager.shutdown();
});

test('erro depois de responder vira aviso só para quem clicou', async () => {
  const { tables, manager, handle } = setup();
  await handle(command('mesa', 'A'));
  const table = tables.inChannel('c1');
  await handle(button(`bc:m:${table.id}:entrar:L`, 'B'));
  const broken = button(`bc:m:${table.id}:comecar:L`, 'A');
  broken.editReply = async () => {
    throw new Error('Discord fora do ar');
  };
  await handle(broken);
  const [type, payload] = broken.calls[broken.calls.length - 1];
  assert.equal(type, 'followUp');
  assert.equal(payload.flags, EPHEMERAL);
  assert.equal(table.status, 'jogando', 'a mesa seguiu mesmo assim');
  await manager.shutdown();
});
