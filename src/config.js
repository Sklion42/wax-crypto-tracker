'use strict';

const path = require('path');

const DEFAULT_ENDPOINTS = [
    'https://wax.cryptolions.io',
    'https://wax.greymass.com',
    'https://api.waxsweden.org',
    'https://wax.eu.eosamsterdam.net',
    'https://api.wax.alohaeos.com',
];

// Discord rate-limits channel renames to 2 per 10 minutes per channel. Going
// below this makes discord.js queue (and stall) the rename requests.
const MIN_UPDATE_INTERVAL_MINUTES = 5;
const DEFAULT_UPDATE_INTERVAL_MINUTES = 10;

function parseList(value, fallback) {
    if (!value) return fallback;
    const items = value.split(',').map(v => v.trim().replace(/\/+$/, '')).filter(Boolean);
    return items.length > 0 ? items : fallback;
}

function parseNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

const warnings = [];

let updateIntervalMinutes = parseNumber(
    process.env.UPDATE_INTERVAL_MINUTES,
    DEFAULT_UPDATE_INTERVAL_MINUTES
);

if (updateIntervalMinutes < MIN_UPDATE_INTERVAL_MINUTES) {
    warnings.push(
        `UPDATE_INTERVAL_MINUTES=${updateIntervalMinutes} is below the Discord rename rate limit ` +
        `(2 renames / 10 min / channel). Falling back to ${MIN_UPDATE_INTERVAL_MINUTES} minutes.`
    );
    updateIntervalMinutes = MIN_UPDATE_INTERVAL_MINUTES;
}

const lang = (process.env.BOT_LANG || 'en').toLowerCase();

const config = {
    discord: {
        token:    process.env.DISCORD_TOKEN,
        clientId: process.env.DISCORD_CLIENT_ID,
        // Optional: register commands on a single guild (instant) instead of
        // globally (up to 1h propagation).
        guildId:  process.env.DISCORD_GUILD_ID || null,
    },
    lang: ['en', 'fr'].includes(lang) ? lang : 'en',
    wax: {
        endpoints:  parseList(process.env.WAX_RPC_ENDPOINTS, DEFAULT_ENDPOINTS),
        timeoutMs:  parseNumber(process.env.WAX_RPC_TIMEOUT_MS, 15000),
        tokenContract: 'eosio.token',
        swapContract:  process.env.WAX_SWAP_CONTRACT || 'swap.alcor',
    },
    coingecko: {
        apiKey: process.env.COINGECKO_API_KEY || null,
        waxId:  process.env.COINGECKO_WAX_ID || 'wax',
    },
    tracker: {
        updateIntervalMs: updateIntervalMinutes * 60 * 1000,
        updateIntervalMinutes,
        // Spacing between two channel renames inside one update cycle.
        renameSpacingMs:  parseNumber(process.env.RENAME_SPACING_MS, 1500),
        // Delay before the first update after startup.
        startupDelayMs:   parseNumber(process.env.STARTUP_DELAY_MS, 15000),
        dataFile: process.env.DATA_FILE
            ? path.resolve(process.env.DATA_FILE)
            : path.join(__dirname, '..', 'data', 'tracked-channels.json'),
    },
    warnings,
};

function assertValid() {
    const missing = [];
    if (!config.discord.token)    missing.push('DISCORD_TOKEN');
    if (!config.discord.clientId) missing.push('DISCORD_CLIENT_ID');

    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variable(s): ${missing.join(', ')}. ` +
            'Copy .env.example to .env and fill it in.'
        );
    }
}

module.exports = { config, assertValid, MIN_UPDATE_INTERVAL_MINUTES };
