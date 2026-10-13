# discord-bot-cleanup

A small [discord.js](https://discord.js.org) script that removes **every registered application command** for a Discord bot — global commands as well as per-guild commands (slash commands, user context menus, message context menus).

## Setup

```bash
npm install
```

Requires Node.js 18 or newer.

## Usage

```bash
# Interactive: prompts for the token
npm start

# Or pass the token directly
node index.js <bot token>

# Clean a single guild only (global commands are left alone)
node index.js <bot token> --guild <guild id>

# Clean a single guild's commands, then leave that guild
node index.js <bot token> --guild <guild id> --leave

# Skip all confirmation prompts (dangerous — for automation only)
node index.js <bot token> --yes
```

You can also create a `.env` file (see `.env.example`) containing:

```dotenv
DISCORD_TOKEN=your-bot-token-here
DISCORD_GUILD_ID=123456789012345678
DISCORD_LEAVE_GUILD=false
```

`DISCORD_GUILD_ID` behaves like `--guild <id>`, and `DISCORD_LEAVE_GUILD` (set to `1`, `true`, `y` or `yes`) behaves like `--leave`. Command line flags always take priority over environment variables. Note that enabling the leave option never bypasses the double confirmation — you will still be asked twice before the bot actually leaves; only `--yes` skips all confirmations.

The token can be found/reset in the [Discord Developer Portal](https://discord.com/developers/applications) under your application's **Bot** page.

## What it does

1. Logs in a minimal client (only the `Guilds` intent, no message/presence intents) to resolve your application id and the list of guilds your bot is in.
2. Fetches every registered application command — the global set plus one batch per guild (or only the given guild's set when `--guild` is used).
3. Shows a summary and asks for **double confirmation** before deleting anything (skipped when `--yes` is passed).
4. Deletes the commands by pushing an empty command list to the global endpoint and to each guild endpoint.
5. If `--leave` was passed together with `--guild`, asks for **double confirmation** again and then makes the bot leave that guild.
6. Logs out.

## Notes

- Deletion is permanent; there is no undo.
- Global command changes can take up to an hour to disappear from clients; guild commands update instantly.
- `--guild` scopes the cleanup to that one guild — global commands and other guilds are untouched.
- `--leave` requires `--guild`; the bot cannot leave a guild it owns (ownership must be transferred or the guild deleted first).
- Guild commands are discovered from the guild cache populated at login, so the bot must still be a member of those guilds. (A bot's guild commands are removed automatically from guilds it leaves, so this is rarely an issue.)
- The token is only read from the CLI argument, the `DISCORD_TOKEN` environment variable/`.env` file, or an interactive prompt — it is never logged or written anywhere.
