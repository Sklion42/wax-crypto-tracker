'use strict';

const fs   = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const { config } = require('./config');
const log = require('./logger');

const COMMANDS_DIR = path.join(__dirname, 'commands');

/** Load every command module from src/commands. */
function loadCommands() {
    const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.js'));
    const commands = new Map();

    for (const file of files) {
        const command = require(path.join(COMMANDS_DIR, file));
        if (!command?.data || typeof command.execute !== 'function') {
            log.warn(`Skipping ${file}: it exports no { data, execute }.`);
            continue;
        }
        commands.set(command.data.name, command);
    }

    return commands;
}

/**
 * Publish the slash commands to Discord. With DISCORD_GUILD_ID set they land on
 * that one server instantly; without it they are registered globally, which is
 * what you want when other people add the bot to their own server (Discord can
 * take up to an hour to propagate those).
 */
async function registerCommands(commands = loadCommands()) {
    const body = [...commands.values()].map(c => c.data.toJSON());
    const rest = new REST().setToken(config.discord.token);

    const route = config.discord.guildId
        ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId)
        : Routes.applicationCommands(config.discord.clientId);

    await rest.put(route, { body });

    log.info(
        `Registered ${body.length} slash command(s) ` +
        (config.discord.guildId ? `on guild ${config.discord.guildId}.` : 'globally.')
    );
}

module.exports = { loadCommands, registerCommands };
