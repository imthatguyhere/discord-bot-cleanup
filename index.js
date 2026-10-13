#!/usr/bin/env node
'use strict';

require('dotenv').config({ quiet: true });

const readline = require('node:readline/promises');
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');

//=-- How long to wait for the WebSocket login before giving up.
const LOGIN_TIMEOUT_MS = 15000;

/**
 * Parses command line arguments.
 * @param {string[]} argv - Raw process.argv.
 * @returns {{token: string|null, force: boolean, help: boolean, guildId: string|null, leave: boolean}} Parsed arguments.
 */
function parseArgs(argv) {
	/** @type {{token: string|null, force: boolean, help: boolean, guildId: string|null, leave: boolean}} */
	const args = { token: null, force: false, help: false, guildId: null, leave: false };

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];

		if (arg === '-h' || arg === '--help') {
			args.help = true;
		} else if (arg === '-y' || arg === '--yes' || arg === '--force') {
			args.force = true;
		} else if (arg === '--leave') {
			args.leave = true;
		} else if (arg === '-g' || arg === '--guild') {
			const value = argv[++i];
			if (!value || value.startsWith('-')) throw new Error(`Option ${arg} requires a guild id.`);
			args.guildId = value;
		} else if (arg.startsWith('-')) {
			throw new Error(`Unknown option "${arg}".`);
		} else {
			args.token = args.token ?? arg;
		}
	}

	//=-- CLI flags win over environment variables.
	if (!args.guildId && process.env.DISCORD_GUILD_ID) {
		args.guildId = process.env.DISCORD_GUILD_ID.trim();
	}
	if (!args.leave && process.env.DISCORD_LEAVE_GUILD) {
		args.leave = /^(1|true|y|yes)$/i.test(process.env.DISCORD_LEAVE_GUILD.trim());
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

Examples:
  node index.js <token>                          remove global + all guild commands
  node index.js <token> --guild 123456789012345678   remove that guild's commands only
  node index.js <token> --guild 123456789012345678 --leave  remove them, then leave`);
}

main().catch((error) => {
	console.error(error?.message ?? error);
	process.exitCode = 1;
});
