# discord-bot-cleanup

A small [discord.js](https://discord.js.org) script that removes **every registered application command** for a Discord bot — global commands as well as per-guild commands (slash commands, user context menus, message context menus).

## Setup

```bash
npm install
```

Requires Node.js 18 or newer.

## Usage

`npm start` compiles `src/` to `dist/` and then runs the compiled script. npm swallows extra arguments unless they come after a `--`:

```bash
# Interactive: prompts for the token (or reads DISCORD_TOKEN)
npm start

# With a token and/or options, pass them after "--":
npm start -- <bot token> --guild <guild id> --leave

# Equivalent without npm; needs a build once first:
npm run build
node dist/index.js <bot token> --guild <guild id> --yes
```

You can also create a `.env` file (see `.env.example`) containing:

```dotenv
DISCORD_TOKEN=your-bot-token-here
DISCORD_GUILD_ID=123456789012345678
DISCORD_LEAVE_GUILD=false
```

`DISCORD_GUILD_ID` behaves like `--guild <guild id>`, and `DISCORD_LEAVE_GUILD` (set to `1`, `true`, `y` or `yes`) behaves like `--leave`. Command line flags always take priority over environment variables. Note that enabling the leave option never bypasses the double confirmation — you will still be asked twice before the bot actually leaves; only `--yes` skips all confirmations.

The token can be found/reset in the [Discord Developer Portal](https://discord.com/developers/applications) under your application's **Bot** page.

## What it does

1. Creates a `log/` folder at the project root (if missing) and opens this run's log file with a name like `discord-bot-cleanup--log--2026-10-13--3-33-pm.log`. It then prints a header to the terminal — the command line and the effective configuration — and from that moment everything printed to the screen is mirrored into the log.
2. Logs in a minimal client (only the `Guilds` intent, no message/presence intents) to resolve your application id and the list of guilds your bot is in.
3. Fetches every registered application command — the global set plus one batch per guild (or only the given guild's set when `--guild` is used).
4. Shows a summary and asks for **double confirmation** before deleting anything (skipped when `--yes` is passed).
5. Deletes the commands by pushing an empty command list to the global endpoint and to each guild endpoint.
6. If `--leave` was passed together with `--guild`, asks for **double confirmation** again and then makes the bot leave that guild.
7. Logs out.

## Notes

- Deletion is permanent; there is no undo.
- Global command changes can take up to an hour to disappear from clients; guild commands update instantly.
- `--guild` scopes the cleanup to that one guild — global commands and other guilds are untouched.
- `--leave` requires `--guild`; the bot cannot leave a guild it owns (ownership must be transferred or the guild deleted first).
- Guild commands are discovered from the guild cache populated at login, so the bot must still be a member of those guilds. (A bot's guild commands are removed automatically from guilds it leaves, so this is rarely an issue.)
- Every run writes a timestamped log file in the `log/` folder at the project root (the folder is git-ignored) capturing the command line, effective configuration and all output.
- The token is only read from the CLI argument, the `DISCORD_TOKEN` environment variable/`.env` file, or an interactive prompt — and it is never printed unredacted: in the run log only its last four characters appear.

## Development

The bot is written in TypeScript (`src/index.ts`) and compiled to plain CommonJS JavaScript in `dist/`:

```bash
npm run build      # compile src/ to dist/
npm run typecheck  # tsc --noEmit
npm start          # build + run dist/index.js
```
