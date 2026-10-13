#!/usr/bin/env node
'use strict';

require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { format } = require('node:util');
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');

//=-- How long to wait for the WebSocket login before giving up.
const LOGIN_TIMEOUT_MS = 15000;

/**
 * Parses command line arguments.
 * @param {string[]} argv - Raw process.argv.
 * @returns {{token: string|null, force: boolean, help: boolean, guildId: string|null, leave: boolean, guildSource: string, leaveSource: string}} Parsed arguments.
 */
function parseArgs(argv) {
	/** @type {{token: string|null, force: boolean, help: boolean, guildId: string|null, leave: boolean, guildSource: string, leaveSource: string}} */
	const args = { token: null, force: false, help: false, guildId: null, leave: false, guildSource: 'none', leaveSource: 'none' };

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];

		if (arg === '-h' || arg === '--help') {
			args.help = true;
		} else if (arg === '-y' || arg === '--yes' || arg === '--force') {
			args.force = true;
		} else if (arg === '--leave') {
			args.leave = true;
			args.leaveSource = 'command line';
		} else if (arg === '-g' || arg === '--guild') {
			const value = argv[++i];
			if (!value || value.startsWith('-')) throw new Error(`Option ${arg} requires a guild id.`);
			args.guildId = value;
			args.guildSource = 'command line';
		} else if (arg.startsWith('-')) {
			throw new Error(`Unknown option "${arg}".`);
		} else {
			args.token = args.token ?? arg;
		}
	}

	//=-- CLI flags win over environment variables.
	if (!args.guildId && process.env.DISCORD_GUILD_ID) {
		args.guildId = process.env.DISCORD_GUILD_ID.trim();
		args.guildSource = 'environment';
	}
	if (!args.leave && process.env.DISCORD_LEAVE_GUILD) {
		args.leave = /^(1|true|y|yes)$/i.test(process.env.DISCORD_LEAVE_GUILD.trim());
		args.leaveSource = 'environment';
	}

	return args;
}

/**
 * Resolves the bot token from the CLI, the environment or an interactive prompt.
 * @param {{token: string|null}} args - Parsed command line arguments.
 * @returns {Promise<string>} The trimmed bot token.
 */
async function resolveToken(args) {
	if (args.token) return args.token.trim();
	if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN.trim();

	//=-- Nothing was passed in, so ask for the token on stdin. This keeps the
	//=-- token out of shell history and off disk.
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const token = (await rl.question('Bot token: ')).trim();
	rl.close();

	return token;
}

/**
 * Logs a minimal client in and resolves once READY data has arrived, so the
 * application id and the guild list are known.
 * @param {string} token - Bot token to log in with.
 * @returns {Promise<Client<boolean>>} The logged-in client.
 */
function login(token) {
	const client = new Client({ intents: [GatewayIntentBits.Guilds] });

	//=-- Keep late WebSocket errors from crashing the process as an unhandled event.
	client.on('error', (error) => console.error('Client error:', error.message));

	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Timed out after ${LOGIN_TIMEOUT_MS}ms waiting for Discord.`)),
			LOGIN_TIMEOUT_MS,
		);

		//=-- discord.js renamed the ready event in recent releases, so listen for
		//=-- both spellings; only one of the two is ever emitted.
		const onReady = () => {
			clearTimeout(timer);
			resolve(client);
		};
		client.once('clientReady', onReady);
		client.once('ready', onReady);

		client.login(token).catch((error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

/**
 * Fetches every registered command (global and per guild) without deleting.
 * @param {REST} rest - REST client authenticated with the bot token.
 * @param {string} applicationId - The bot's application id.
 * @param {Client<boolean>} client - Logged-in client used to read the guild cache.
 * @returns {Promise<{globalCommands: Object[], guildPlans: {id: string, name: string, commands: Object[]}[]}>}
 */
async function fetchPlan(rest, applicationId, client) {
	const globalCommands = await rest.get(Routes.applicationCommands(applicationId));

	const guildPlans = [];
	for (const guild of client.guilds.cache.values()) {
		try {
			const commands = await rest.get(Routes.applicationGuildCommands(applicationId, guild.id));
			guildPlans.push({ id: guild.id, name: guild.name ?? 'Unknown guild', commands });
		} catch (error) {
			console.error(`Could not fetch commands for guild ${guild.name ?? guild.id} (${guild.id}): ${error?.message ?? error}`);
		}
	}

	return { globalCommands, guildPlans };
}

/**
 * Deletes a batch of commands by putting an empty list in their scope.
 * @param {REST} rest - REST client authenticated with the bot token.
 * @param {string} applicationId - The bot's application id.
 * @param {string|null} [guildId] - Guild id for guild-scoped commands, omit for global.
 * @returns {Promise<void>}
 */
async function clearScope(rest, applicationId, guildId = null) {
	if (guildId === null) {
		await rest.put(Routes.applicationCommands(applicationId), { body: [] });
	} else {
		await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: [] });
	}
}

/**
 * Renders a comma separated list of command names for log output.
 * Very long lists are truncated.
 * @param {{name: string}[]} commands - Command objects as returned by the API.
 * @returns {string}
 */
function formatNames(commands) {
	const names = commands.map((command) => command.name);
	const shown = names.slice(0, 10).join(', ');
	return names.length > 10 ? `${shown} … (+${names.length - 10} more)` : shown;
}

/**
 * Builds the timestamp portion of a log file name in local time,
 * e.g. "2026-10-13--3-33-pm".
 * @param {Date} now - The moment of the run.
 * @returns {string}
 */
function logTimestamp(now) {
	const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
	const half = now.getHours() >= 12 ? 'pm' : 'am';
	const hours = now.getHours() % 12 || 12;
	const minutes = String(now.getMinutes()).padStart(2, '0');

	return `${date}--${hours}-${minutes}-${half}`;
}

/**
 * Masks a bot token so the secret never reaches stdout or the log.
 * @param {string|null|undefined} token
 * @returns {string} e.g. "****abcd".
 */
function maskToken(token) {
	if (!token) return '(none)';
	return `****${token.slice(-4)}`;
}

/**
 * Creates the log folder next to the script and redirects all console output
 * into this run's log file, so the file ends up identical to stdout.
 * Names look like "discord-bot-cleanup--log--2026-10-13--3-33-pm.log";
 * a second run within the same minute gets a "-2", "-3", … suffix.
 * @returns {string} Absolute path of the active log file.
 */
function startRunLog() {
	const dir = path.join(__dirname, 'log');
	fs.mkdirSync(dir, { recursive: true });

	let filePath = null;
	for (let attempt = 1; attempt <= 100; attempt++) {
		const suffix = attempt === 1 ? '' : `-${attempt}`;
		const candidate = path.join(dir, `discord-bot-cleanup--log--${logTimestamp(new Date())}${suffix}.log`);
		if (!fs.existsSync(candidate)) {
			filePath = candidate;
			break;
		}
	}
	if (!filePath) throw new Error('Could not pick a unique log file name.');

	//=-- Mirror every console call into the run file, keeping console
	//=-- formatting (multi-part lines, %s placeholders) intact.
	for (const name of ['log', 'error', 'warn']) {
		const original = console[name].bind(console);
		console[name] = (...parts) => {
			original(...parts);
			fs.appendFileSync(filePath, `${format(...parts)}\n`);
		};
	}

	return filePath;
}

/**
 * Prints the run header: the exact invocation plus the effective
 * configuration. The token is always shown masked.
 * @param {string} filePath - This run's log file.
 * @param {string[]} argv - Raw process.argv.
 * @param {{token: string|null, force: boolean, help: boolean, guildId: string|null, leave: boolean, guildSource: string, leaveSource: string}} args - Parsed arguments.
 * @param {string} tokenSource - Where the token will come from.
 * @returns {void}
 */
function printRunHeader(filePath, argv, args, tokenSource) {
	let token;
	if (args.token) {
		token = `${maskToken(args.token)} (${tokenSource})`;
	} else if (process.env.DISCORD_TOKEN) {
		token = `${maskToken(process.env.DISCORD_TOKEN)} (${tokenSource})`;
	} else {
		token = '(none yet — entered interactively during this run)';
	}

	const maskedArgv = args.token ? argv.map((part) => (part === args.token ? maskToken(args.token) : part)) : argv;

	console.log('==============================');
	console.log('discord-bot-cleanup — run started');
	console.log(`Log file:           ${filePath}`);
	console.log(`Node:               ${process.version}`);
	console.log(`Command line:       ${maskedArgv.join(' ')}`);
	console.log('Configuration:');
	console.log(`  token:            ${token}`);
	console.log(`  guild:            ${args.guildId ? `${args.guildId} (${args.guildSource})` : 'not set — global + every guild'}`);
	console.log(`  leave guild:      ${args.leave ? `true (${args.leaveSource})` : 'false'}`);
	console.log(`  force (--yes):    ${args.force ? 'true' : 'false'}`);
	console.log('==============================');
}

/**
 * Asks the user to confirm an action twice before it is executed.
 * @param {string} question - The main question to ask.
 * @param {boolean} force - When true, confirmation is skipped (--yes was passed).
 * @returns {Promise<boolean>} Whether the user confirmed both times.
 */
async function confirmTwice(question, force) {
	if (force) return true;

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

	//=-- First pass: plain yes/no.
	const first = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
	if (first !== 'y' && first !== 'yes') {
		rl.close();
		return false;
	}

	//=-- Second pass with more explicit wording, so a stray Enter cannot get through.
	const second = (await rl.question('Are you sure? This cannot be undone. [y/N] ')).trim().toLowerCase();
	rl.close();

	return second === 'y' || second === 'yes';
}

/**
 * Entry point: resolves the token, logs in, then removes the matching commands
 * (and optionally leaves a guild, when --leave is used with --guild).
 * @returns {Promise<void>}
 */
async function main() {
	const args = parseArgs(process.argv);

	//=-- Begin the run log first so every run (including --help and later
	//=-- failures) gets a file; the header goes to both stdout and the log.
	const tokenSource = args.token ? 'command line' : process.env.DISCORD_TOKEN ? 'environment' : 'interactive prompt';
	const filePath = startRunLog();
	printRunHeader(filePath, process.argv, args, tokenSource);

	if (args.help) {
		printUsage();
		return;
	}

	if (args.leave && !args.guildId) {
		throw new Error('--leave requires --guild <id>.');
	}

	if (args.guildId && !/^\d{17,21}$/.test(args.guildId)) {
		throw new Error(`"${args.guildId}" does not look like a guild id (expected a numeric snowflake).`);
	}

	const token = await resolveToken(args);
	if (!token) {
		console.error('No bot token provided.');
		printUsage();
		process.exitCode = 1;
		return;
	}

	//=-- Log which token is in use, but never the token itself.
	console.log(`Token in use: ${maskToken(token)} (${tokenSource}).`);

	console.log('Logging in to Discord…');
	const client = await login(token);
	console.log(`Logged in as ${client.user.tag} (application ${client.application?.id ?? client.user.id}).`);

	try {
		const rest = new REST({ version: '10' }).setToken(token);
		const applicationId = client.application?.id ?? client.user.id;

		//=-- Validate the guild scope up front so unknown guilds fail before anything happens.
		let targetGuild = null;
		if (args.guildId) {
			targetGuild = client.guilds.cache.get(args.guildId) ?? null;
			if (!targetGuild) {
				throw new Error(`The bot is not a member of guild ${args.guildId}, so it cannot clean or leave it.`);
			}
		}

		//=-- Snapshot what is registered before touching anything.
		let globalCommands = [];
		let guildPlans = [];
		if (targetGuild) {
			const commands = await rest.get(Routes.applicationGuildCommands(applicationId, targetGuild.id));
			guildPlans.push({ id: targetGuild.id, name: targetGuild.name, commands });
		} else {
			const plan = await fetchPlan(rest, applicationId, client);
			globalCommands = plan.globalCommands;
			guildPlans = plan.guildPlans;
		}

		const total = globalCommands.length + guildPlans.reduce((sum, plan) => sum + plan.commands.length, 0);

		if (total > 0) {
			//=-- Show exactly what will disappear before deleting anything.
			console.log(`\nGlobal: ${globalCommands.length} command(s)`);
			for (const plan of guildPlans) {
				console.log(`Guild ${plan.name} (${plan.id}): ${plan.commands.length} command(s)`);
			}
			console.log(`Total: ${total} command(s)${targetGuild ? '' : ` across ${guildPlans.length} guild(s)`}.\n`);

			//=-- Double confirmation before any deletion.
			if (!(await confirmTwice('Delete all of these commands?', args.force))) {
				console.log('Aborted — nothing was changed.');
				return;
			}

			let removed = 0;

			if (globalCommands.length > 0) {
				await clearScope(rest, applicationId);
				removed += globalCommands.length;
				console.log(`Removed ${globalCommands.length} global command(s): ${formatNames(globalCommands)}`);
			}

			for (const plan of guildPlans) {
				if (plan.commands.length === 0) continue;

				try {
					await clearScope(rest, applicationId, plan.id);
					removed += plan.commands.length;
					console.log(`Removed ${plan.commands.length} command(s) from ${plan.name} (${plan.id}): ${formatNames(plan.commands)}`);
				} catch (error) {
					console.error(`Failed to remove commands from ${plan.name} (${plan.id}): ${error?.message ?? error}`);
				}
			}

			console.log(`\nDone — ${removed} command(s) removed.`);
		} else if (targetGuild) {
			console.log(`No commands are registered in ${targetGuild.name} (${targetGuild.id}).`);
		} else {
			console.log('Nothing to remove — no global or guild commands are registered.');
		}

		//=-- Optional follow-up: leave the targeted guild.
		if (targetGuild && args.leave) {
			if (targetGuild.ownerId === client.user.id) {
				throw new Error(`The bot owns ${targetGuild.name} (${targetGuild.id}) and cannot leave it — transfer ownership or delete the guild instead.`);
			}

			console.log(`\nYou asked to also leave ${targetGuild.name} (${targetGuild.id}).`);
			console.log('The bot can only come back if it is invited again.');

			if (!(await confirmTwice('Leave the guild?', args.force))) {
				console.log('Staying in the guild.');
				return;
			}

			await targetGuild.leave();
			console.log(`Left ${targetGuild.name} (${targetGuild.id}).`);
		}
	} finally {
		await client.destroy();
	}
}

/**
 * Prints how to invoke the script.
 * @returns {void}
 */
function printUsage() {
	console.log(`Usage:
  node index.js <bot token> [options]
  node index.js                (prompts for the token, or reads DISCORD_TOKEN)

Options:
  -g, --guild <id>   Only clean the given guild (global commands are left alone)
  --leave            Also make the bot leave that guild (requires --guild)
  -y, --yes          Skip all confirmation prompts (dangerous)
  -h, --help         Show this help

Every destructive action (deleting commands, leaving a guild) asks for
confirmation twice unless --yes is passed.

DISCORD_TOKEN, DISCORD_GUILD_ID and DISCORD_LEAVE_GUILD (1/true/yes) can
also be set in the environment or a .env file; CLI flags take priority.

Every run writes a log file like log/discord-bot-cleanup--log--2026-10-13--3-33-pm.log
next to index.js, containing the arguments, configuration and all output.
Tokens are redacted there (only the last 4 characters are kept).

Examples:
  node index.js <token>                          remove global + all guild commands
  node index.js <token> --guild 123456789012345678   remove that guild's commands only
  node index.js <token> --guild 123456789012345678 --leave  remove them, then leave`);
}

main().catch((error) => {
	console.error(error?.message ?? error);
	process.exitCode = 1;
});
