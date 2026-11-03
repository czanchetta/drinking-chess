// Definição do comando /beerchess e seus subcomandos.

import { InteractionContextType, SlashCommandBuilder } from 'discord.js';

export const CLOCKS = Object.freeze({
  '3+2': { limit: 180, increment: 2, label: '3+2' },
  '5+3': { limit: 300, increment: 3, label: '5+3' },
  '10+0': { limit: 600, increment: 0, label: '10+0' },
  '10+5': { limit: 600, increment: 5, label: '10+5' },
  '15+10': { limit: 900, increment: 10, label: '15+10' },
  livre: { limit: null, increment: null, label: 'sem relógio' },
});
export const DEFAULT_CLOCK = '5+3';

const intensity = (option) => option
  .setName('intensidade')
  .setDescription('normal ou leve (metade dos goles)')
  .addChoices({ name: 'normal', value: 'normal' }, { name: 'leve (metade dos goles)', value: 'leve' });
const white = (option) => option.setName('brancas').setDescription('Quem joga de brancas');
const black = (option) => option.setName('pretas').setDescription('Quem joga de pretas');
const clock = (option) => option
  .setName('tempo')
  .setDescription(`Ritmo da partida (padrão ${DEFAULT_CLOCK})`)
  .addChoices(...Object.entries(CLOCKS).map(([value, c]) => ({ name: c.label, value })));
const format = (option) => option
  .setName('formato')
  .setDescription('Como a mesa gira (padrão: quem ganha fica)')
  .addChoices(
    { name: 'quem ganha fica (rei da mesa)', value: 'rei' },
    { name: 'rodízio (todo mundo joga igual)', value: 'rodizio' },
  );

export function buildCommands() {
  const command = new SlashCommandBuilder()
    .setName('beerchess')
    .setDescription('Xadrez com cerveja 🍺: acompanho a partida no Lichess e aviso quem bebe')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub
      .setName('novo')
      .setDescription('Cria uma partida casual no Lichess e aviso aqui quem bebe')
      .addUserOption(white)
      .addUserOption(black)
      .addStringOption(clock)
      .addStringOption(intensity))
    .addSubcommand((sub) => sub
      .setName('mesa')
      .setDescription('Abre uma mesa: eu sorteio quem joga com quem e mando o link de cada um')
      .addStringOption(format)
      .addStringOption(clock)
      .addStringOption(intensity))
    .addSubcommand((sub) => sub
      .setName('assistir')
      .setDescription('Acompanha uma partida do Lichess que vocês já criaram')
      .addStringOption((option) => option
        .setName('partida')
        .setDescription('Link ou código da partida no Lichess')
        .setRequired(true))
      .addUserOption(white)
      .addUserOption(black)
      .addStringOption(intensity))
    .addSubcommand((sub) => sub
      .setName('placar')
      .setDescription('Mostra os goles das partidas deste canal e o placar da noite'))
    .addSubcommand((sub) => sub
      .setName('parar')
      .setDescription('Para de acompanhar as partidas deste canal')
      .addStringOption((option) => option
        .setName('partida')
        .setDescription('Link ou código (opcional; sem isso, para todas do canal)')))
    .addSubcommand((sub) => sub
      .setName('regras')
      .setDescription('Mostra quem bebe e quanto')
      .addStringOption(intensity))
    .addSubcommand((sub) => sub
      .setName('demo')
      .setDescription('Reprisa a Partida da Ópera (Morphy, 1858) para ver o bot em ação')
      .addStringOption(intensity));
  return [command.toJSON()];
}
