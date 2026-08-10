'use strict';

require('dotenv').config({ quiet: true });

const { Client, GatewayIntentBits, Events, MessageFlags, ActivityType } = require('discord.js');

const { config, assertValid } = require('./src/config');
const log = require('./src/logger');
const { loadCommands, registerCommands } = require('./src/registerCommands');
const { CryptoTracker } = require('./src/cryptoTracker');

try {
    assertValid();
} catch (err) {
    log.error(err.message);
    process.exit(1);
}

for (const warning of config.warnings) log.warn(warning);

// Guilds is the only intent needed: the bot reads channels and answers slash
// commands, it never reads message content.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = loadCommands();
let tracker;

client.once(Events.ClientReady, async (readyClient) => {
    log.info(`Logged in as ${readyClient.user.tag} — ${readyClient.guilds.cache.size} server(s).`);

    try {
        await registerCommands(commands);
    } catch (err) {
        log.error(`Slash command registration failed: ${err.message}`);
    }

    tracker = new CryptoTracker(readyClient);
    readyClient.cryptoTracker = tracker;
    tracker.start();

    readyClient.user.setPresence({
        activities: [{ name: 'WAX prices', type: ActivityType.Watching }],
        status: 'online',
    });
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (err) {
        log.error(`Command /${interaction.commandName} failed: ${err.stack || err.message}`);

        const payload = {
            content: '❌ Something went wrong while running this command.',
            flags:   MessageFlags.Ephemeral,
        };
        try {
            if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
            else await interaction.reply(payload);
        } catch { /* the interaction token already expired */ }
    }
});

// Drop the stored entries of a server that removed the bot.
client.on(Events.GuildDelete, (guild) => {
    if (!tracker) return;
    const keys = tracker.listForGuild(guild.id).map(([key]) => key);
    for (const key of keys) tracker.unregister(key);
    if (keys.length > 0) log.info(`Left ${guild.name}: dropped ${keys.length} tracked token(s).`);
});

client.on(Events.Error, err => log.error(`Discord client error: ${err.message}`));
process.on('unhandledRejection', err => log.error(`Unhandled rejection: ${err?.stack || err}`));

function shutdown(signal) {
    log.info(`${signal} received, shutting down.`);
    tracker?.stop();
    client.destroy();
    process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.discord.token).catch((err) => {
    log.error(`Login failed: ${err.message}`);
    process.exit(1);
});
