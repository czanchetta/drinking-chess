# 🍺♟️ Beer Chess Bot

Bot de Discord que acompanha partidas **casuais** no [Lichess](https://lichess.org) e avisa no canal quem bebe — e quanto.

```
`15. Bxd7+`
🍺 @Beltrano: perdeu uma torre ♜ (5) + levou xeque (1) → 6 goles

`16... Nxb8`
🍺 @Fulano: perdeu a dama ♛ → 9 goles

🏁 Xeque-mate! @Fulano venceu.
🍺 @Beltrano vira o copo!
Goles na partida: @Fulano 25 goles · @Beltrano 18 goles + 1 copo
```

## Como funciona

1. `/beerchess novo` cria um desafio aberto e casual no Lichess e posta os botões **Jogar de brancas** / **Jogar de pretas**. Ninguém precisa de conta no Lichess.
2. Quando a partida começa, o bot segue os lances pela API pública do Lichess e só fala quando alguém tem que beber.
3. No fim, quem perdeu vira o copo e sai o placar. `/beerchess placar` mostra também o **placar da noite**, somando as partidas das últimas 12 horas.

> O Lichess entrega os lances para quem está assistindo com uns 3 lances de atraso (é a trava anti-trapaça deles), então os avisos chegam um pouquinho depois do lance. No fim da partida o bot busca a partida completa e conta o finalzinho certo.
>
> Usei a API pública de stream de partidas, e não a Board API: a Board API exige o token de cada jogador; a pública não pede login de ninguém.

## Regras padrão

| Acontecimento | Quem bebe | Goles |
|---|---|---|
| Perdeu peça | quem perdeu | ♟ peão 1 · ♞ cavalo 3 · ♝ bispo 3 · ♜ torre 5 · ♛ dama 9 |
| Levou xeque | quem levou | 1 |
| Levou en passant | quem perdeu o peão | +2 (humilhação) |
| Adversário promoveu | quem sofreu | 3 |
| Roque | os dois (brinde) | 1 |
| Perdeu a partida | quem perdeu | vira o copo |
| Empate | os dois | 3 |

Intensidade **leve**: metade dos goles (arredondado para cima) e meio copo para quem perde. Para mudar as regras, edite [`src/rules.js`](src/rules.js) — o texto de `/beerchess regras` se ajusta sozinho.

## Comandos

| Comando | O que faz |
|---|---|
| `/beerchess novo [brancas] [pretas] [tempo] [intensidade]` | Cria a partida casual (padrão 5+3) e já fica de olho |
| `/beerchess assistir partida:<link>` | Acompanha uma partida que vocês criaram por conta própria no Lichess |
| `/beerchess placar` | Goles de cada partida do canal + placar da noite |
| `/beerchess parar [partida]` | Para de acompanhar (uma ou todas do canal) |
| `/beerchess regras [intensidade]` | Mostra as regras |
| `/beerchess demo` | Reprisa a Partida da Ópera (Morphy, 1858) para ver o bot em ação sem jogar |

## Colocar no ar

### 1. Criar o bot no Discord (uns 5 minutos)

1. Entre em <https://discord.com/developers/applications> → **New Application** → nome (ex.: *Beer Chess*).
2. Na aba **Bot**, clique em **Reset Token** e copie o token. Ele é a senha do bot: não publique em lugar nenhum. As *Privileged Gateway Intents* podem ficar todas desligadas.
3. Na aba **OAuth2 → URL Generator**, marque `bot` e `applications.commands`. Em *Bot Permissions*, marque **View Channels**, **Send Messages**, **Embed Links** e **Send Messages in Threads**. Abra o link gerado e escolha o servidor.
   (O bot também imprime esse link no log quando liga.)

### 2. Hospedar

O bot precisa ficar ligado o tempo todo (ou pelo menos durante a noite de jogo). Ele usa uns 100 MB de RAM e só faz conexões de saída: não precisa abrir porta no roteador.

**Opção A — Raspberry Pi em casa (grátis, 24/7)**

Roda tranquilo ao lado do Pi-hole (Pi 2 ou mais novo; o Zero 2 W serve). Pelo SSH no Raspberry:
```bash
git clone https://github.com/czanchetta/drinking-chess.git ~/drinking-chess
bash ~/drinking-chess/scripts/instalar-raspberry.sh
```
O script baixa o Node.js para `~/.local` (sem mexer nos pacotes do sistema nem no Pi-hole), pede o token do bot (cole e aperte Enter; ele não aparece na tela), cria o serviço `beer-chess` e mostra o log. O bot liga sozinho quando o Raspberry reinicia, com prioridade baixa e no máximo 300 MB de memória.

- log ao vivo: `journalctl -u beer-chess -f`
- atualizar para a versão mais nova do GitHub: `bash ~/drinking-chess/scripts/atualizar.sh`

**Opção B — Railway (dá para fazer pelo celular)**
1. Crie a conta em <https://railway.com> entrando com o GitHub.
2. **New Project → Deploy from GitHub repo** → escolha este repositório.
3. No serviço, aba **Variables**, adicione `DISCORD_TOKEN` com o token do passo 1.
4. O Railway acha o `Dockerfile` e sobe. Nos logs deve aparecer `Conectado como Beer Chess#…`.

Custo: contas novas precisam de plano pago para fazer deploy; o Hobby custa US$ 5/mês com US$ 5 de uso incluídos, o que sobra para este bot.

**Opção C — Square Cloud (brasileira, em reais)**
1. Crie a conta em <https://squarecloud.app> e assine o plano Hobby (a partir de R$ 12,49/mês).
2. Faça upload deste repositório (zip sem a pasta `node_modules`) — o arquivo [`squarecloud.app`](squarecloud.app) já está pronto.
3. Em **Variáveis de ambiente**, adicione `DISCORD_TOKEN` e reinicie o app.

**Opção D — no seu computador, só na noite de jogo (grátis)**
```bash
git clone https://github.com/czanchetta/drinking-chess
cd drinking-chess
npm install
cp .env.example .env   # e cole o DISCORD_TOKEN no .env
npm start
```
Precisa do Node.js 22 ou mais novo. Com Docker: `docker build -t beer-chess . && docker run --env-file .env beer-chess`.

O mesmo `Dockerfile` serve para Fly.io (`fly launch`), uma VPS ou qualquer serviço que rode containers.

## Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DISCORD_TOKEN` | sim | Token do bot (passo 1) |
| `DISCORD_GUILD_ID` | não | ID do servidor: o `/beerchess` aparece na hora só nele. Sem isso, o registro é em todos os servidores e pode levar alguns minutos (no PC, Ctrl+R recarrega o Discord). |
| `LICHESS_TOKEN` | não | Token pessoal do Lichess (escopo `challenge:write`), só se quiser os desafios no seu nome |
| `MAX_GAMES` | não | Partidas simultâneas (padrão 6; o Lichess aceita até 8 streams por IP) |
| `CHALLENGE_WAIT_MINUTES` | não | Quanto tempo esperar alguém entrar no desafio (padrão 120) |
| `PORT` | não | Liga um health check HTTP nessa porta |

## Limitações

- Só xadrez normal (nada de 960, crazyhouse etc.).
- As partidas ficam na memória. Se o bot reiniciar no meio de uma, use `/beerchess assistir` com o link para retomar — a contagem recomeça dali.
- Se a conexão com o Lichess cair e voltar alguns lances depois, o bot conta as peças perdidas no intervalo, mas pode deixar passar um xeque ou roque daquele trecho.

## Desenvolvimento

```bash
npm install
npm test
```

Os testes rodam a Partida da Ópera inteira pelo motor de regras e simulam o Lichess com um servidor falso (desafio pendente, atraso de lances, queda de conexão, limite de requisições).

---

Joguem com responsabilidade: funciona igual com refri ou água, e a intensidade leve corta tudo pela metade. 🍻

Licença MIT.
