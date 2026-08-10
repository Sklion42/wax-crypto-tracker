# WAX Crypto Tracker — Discord bot

A small, self-contained Discord bot that shows **live WAX blockchain token prices in voice channel names**.

```
🔊 ↗️ WAX: $0.0412
🔊 ↘️ TLM: $0.0089 | 0.2160 WAX
🔊 ➡️ WAXUSDC: 24.2718 WAX
```

Channels are display-only (nobody can join them), refresh themselves on a timer, and show a trend arrow (↗️ / ↘️ / ➡️) comparing the price to the previous refresh.

Prices come from **CoinGecko** for WAX/USD and from the **Alcor AMM pools** read directly on the WAX chain for every other token — no API key and no account required.

---

## Requirements

- **Node.js 18 or newer** ([nodejs.org](https://nodejs.org)) — `node -v` to check
- A Discord bot application (created below)
- Anywhere to run it: a PC left on, a VPS, a Raspberry Pi, a host like Railway/Fly.io…

## 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy the token (this is your `DISCORD_TOKEN`, keep it secret).
3. **General Information** tab → copy the **Application ID** (this is your `DISCORD_CLIENT_ID`).
4. **Installation** (or **OAuth2 → URL Generator**) tab, generate an invite link with:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: **Manage Channels**, **View Channels**
5. Open the link and add the bot to your server.

> No privileged intent (message content, members, presence) is needed — leave them all off.

## 2. Install

```bash
git clone https://github.com/Sklion42/wax-crypto-tracker.git
cd wax-crypto-tracker
npm install
cp .env.example .env
```

(No git? Use the green **Code** button → *Download ZIP*, unzip, then run the last two commands.)

Open `.env` and fill in at least `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`.

## 3. Run

```bash
npm start
```

The slash commands are published automatically on startup. If `DISCORD_GUILD_ID`
is set they appear instantly on that server; otherwise they are registered
globally and Discord can take up to an hour to show them everywhere.

To keep it running 24/7, use a process manager:

```bash
npm install -g pm2
pm2 start index.js --name wax-crypto-tracker
pm2 save
```

---

## Commands

All subcommands live under `/crypto-tracker` and are restricted to members with
the **Manage Channels** permission by default (changeable in
*Server Settings → Integrations → your bot*).

| Command | What it does |
|---|---|
| `/crypto-tracker add token:<SYMBOL> [type] [contract] [category]` | Creates a voice channel tracking that token |
| `/crypto-tracker remove token:<SYMBOL> [contract]` | Stops tracking and deletes the channel |
| `/crypto-tracker list` | Lists the tokens tracked on this server |
| `/crypto-tracker refresh` | Forces an immediate refresh of every channel |

### Token types

| Type | Display | Needs a contract? | Use it for |
|---|---|---|---|
| `standard` *(default)* | `$0.0089 \| 0.2160 WAX` | yes | any token with an Alcor TOKEN/WAX pool |
| `pool` | `$0.0089 \| 0.2160 WAX` | yes | same maths, separate label for AMM/LP tokens |
| `stablecoin` | `24.2718 WAX` | no | tokens pegged to $1 (WAXUSDC…) — priced as `1 / WAX` |
| `native` | `$0.0412` | no | WAX itself, priced in USD from CoinGecko |

### Examples

```
/crypto-tracker add token:WAX type:native
/crypto-tracker add token:TLM type:standard contract:alien.worlds
/crypto-tracker add token:DEF type:standard contract:defensetoken
/crypto-tracker add token:WAXUSDC type:stablecoin
```

The contract is the WAX account that issues the token. Find it on
[wax.alcor.exchange](https://wax.alcor.exchange) — it is shown next to the
symbol on the pair's page. If `add` answers "token not found", the symbol or
the contract is wrong, or that token has no TOKEN/WAX pool on Alcor.

---

## Configuration

Everything is set through `.env`:

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | — | **Required.** Bot token |
| `DISCORD_CLIENT_ID` | — | **Required.** Application ID |
| `DISCORD_GUILD_ID` | *(empty)* | Register commands on one server only (instant). Leave empty for a shared bot |
| `BOT_LANG` | `en` | `en` or `fr` |
| `UPDATE_INTERVAL_MINUTES` | `10` | Refresh period. Values under 5 are clamped |
| `COINGECKO_API_KEY` | *(empty)* | Optional demo key, avoids public rate limits |
| `WAX_RPC_ENDPOINTS` | 5 public nodes | Comma-separated RPC list, tried in order with failover |
| `DATA_FILE` | `./data/tracked-channels.json` | Where tracked channels are persisted |

### Why 10 minutes and not 1?

Discord only allows **2 channel renames per 10 minutes, per channel**. Going
faster does not fail loudly — the requests silently queue up and the names stop
moving. 10 minutes is the safe rhythm; 5 is the floor the bot will accept.

---

## Sharing the bot with other servers

Two ways:

- **One bot, several servers** — leave `DISCORD_GUILD_ID` empty, keep the bot
  running, and hand out your invite link. Tracked channels are stored per
  server, so each one manages its own list.
- **One bot per person** — point people at this repository (or let them fork
  it). Everyone creates their own Discord application and runs their own copy.
  Nothing is hardcoded to a specific server.

Never share your `.env` — it holds your bot token. Only `.env.example` is meant
to be distributed.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Commands do not appear | Global registration takes up to 1h. Set `DISCORD_GUILD_ID` for instant registration, or re-invite the bot with the `applications.commands` scope |
| "Could not create the voice channel" | The bot lacks **Manage Channels**, or the server hit its 500-channel cap |
| Names stop updating | Discord rename rate limit — raise `UPDATE_INTERVAL_MINUTES` |
| "Token not found on Alcor" | Wrong symbol/contract, or no TOKEN/WAX pool exists for it |
| `fetch is not defined` | Node.js older than 18 — upgrade |
| A channel was deleted by hand | The entry drops itself automatically at the next refresh |

---

## How it works

```
index.js                  Discord client, command routing, lifecycle
src/config.js             .env parsing, defaults, safety clamps
src/registerCommands.js   command loading + slash registration
src/commands/             /crypto-tracker (add, remove, list, refresh)
src/cryptoTracker.js      update loop, channel naming, JSON persistence
src/priceSources.js       CoinGecko (WAX/USD) + Alcor pool reserves
src/waxRpc.js             WAX RPC calls with endpoint failover
src/i18n.js               EN / FR strings
```

Each refresh cycle fetches WAX/USD once and pages the Alcor `pools` table once,
then renames the channels whose price changed, spaced out to stay within
Discord's rate limits. A token's price in WAX is taken from the **deepest**
TOKEN/WAX pool, so a near-empty duplicate pool cannot skew the display.

State lives in a single JSON file, so a restart picks up exactly where it left
off; back up `data/tracked-channels.json` if you care about the trend arrows.

## License

MIT — see [LICENSE](LICENSE).
