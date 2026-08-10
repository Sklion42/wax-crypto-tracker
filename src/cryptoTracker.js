'use strict';

const fs   = require('fs');
const path = require('path');

const { config } = require('./config');
const log = require('./logger');
const {
    fetchWaxUsd,
    fetchAllPools,
    findPoolPriceInWax,
    fetchPoolPriceInWax,
} = require('./priceSources');

// ─── Token types ──────────────────────────────────────────────────────────────

const TOKEN_TYPE = {
    NATIVE:     'native',     // WAX      → $ from CoinGecko
    STABLECOIN: 'stablecoin', // WAXUSDC  → WAX, via 1 / waxUsd
    STANDARD:   'standard',   // TLM, ... → $ and WAX, via an AMM pool
    POOL:       'pool',       // same maths as standard, kept as a separate label
};

const POOL_BASED_TYPES = [TOKEN_TYPE.STANDARD, TOKEN_TYPE.POOL];

// ─── Formatting ───────────────────────────────────────────────────────────────

function getTrendEmoji(oldPrice, newPrice) {
    if (oldPrice === null || oldPrice === undefined) return '➡️';
    if (newPrice > oldPrice) return '↗️';
    if (newPrice < oldPrice) return '↘️';
    return '➡️';
}

function formatPrice(value) {
    const num = parseFloat(value);
    if (!Number.isFinite(num) || num === 0) return '0';
    if (num < 0.000001) return num.toExponential(2);
    if (num < 0.0001)   return num.toFixed(8);
    if (num < 0.01)     return num.toFixed(6);
    if (num < 1)        return num.toFixed(4);
    if (num < 1000)     return num.toFixed(2);
    return Math.round(num).toLocaleString('en-US');
}

/** Discord caps channel names at 100 characters. */
function buildChannelName(token, type, priceInWax, waxUsd, trend) {
    let name;

    if (type === TOKEN_TYPE.NATIVE) {
        name = `${trend} ${token}: $${formatPrice(waxUsd)}`;
    } else if (type === TOKEN_TYPE.STABLECOIN) {
        name = `${trend} ${token}: ${formatPrice(priceInWax)} WAX`;
    } else {
        const priceUsd = priceInWax * waxUsd;
        name = `${trend} ${token}: $${formatPrice(priceUsd)} | ${formatPrice(priceInWax)} WAX`;
    }

    return name.slice(0, 100);
}

// ─── Tracker ──────────────────────────────────────────────────────────────────

class CryptoTracker {
    /**
     * @param {import('discord.js').Client} client
     */
    constructor(client) {
        this.client = client;
        /** @type {Map<string, object>} keyed by `${guildId}:${token}[|contract]` */
        this.entries = new Map();
        this.updating = false;
        this.startupTimer = null;
        this.intervalTimer = null;
        this.load();
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    load() {
        const file = config.tracker.dataFile;
        try {
            if (!fs.existsSync(file)) return;
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const [key, entry] of Object.entries(raw)) {
                if (entry && entry.channelId && entry.token) this.entries.set(key, entry);
            }
            log.info(`Loaded ${this.entries.size} tracked token(s) from ${file}`);
        } catch (err) {
            log.error(`Could not read ${file}: ${err.message}`);
        }
    }

    save() {
        const file = config.tracker.dataFile;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const obj = Object.fromEntries(this.entries);
            // Write to a temp file first so a crash mid-write cannot truncate
            // the existing state.
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
            fs.renameSync(tmp, file);
        } catch (err) {
            log.error(`Could not write ${file}: ${err.message}`);
        }
    }

    // ── Keys and lookups ──────────────────────────────────────────────────────

    makeKey(guildId, token, contract = null) {
        return contract ? `${guildId}:${token}|${contract}` : `${guildId}:${token}`;
    }

    /** Entries belonging to one guild, as [key, entry] pairs. */
    listForGuild(guildId) {
        return [...this.entries].filter(([, entry]) => entry.guildId === guildId);
    }

    /** Keys of the same symbol in a guild, whatever the contract. */
    findRelatedKeys(guildId, token) {
        const prefix = `${guildId}:${token}`;
        return [...this.entries.keys()].filter(k => k === prefix || k.startsWith(`${prefix}|`));
    }

    // ── Adding a token ────────────────────────────────────────────────────────

    /**
     * Resolve the current price of a token, which doubles as validation that
     * the symbol/contract pair really exists on chain.
     * @returns {Promise<{priceInWax: number|null, waxUsd: number}|null>}
     */
    async fetchInitialData(token, type, contract = null) {
        const waxUsd = await fetchWaxUsd();
        if (!waxUsd) return null;

        if (type === TOKEN_TYPE.NATIVE)     return { priceInWax: null, waxUsd };
        if (type === TOKEN_TYPE.STABLECOIN) return { priceInWax: 1 / waxUsd, waxUsd };

        if (!contract) return null;
        const priceInWax = await fetchPoolPriceInWax(token, contract);
        if (priceInWax === null) return null;
        return { priceInWax, waxUsd };
    }

    register({ guildId, token, type, contract, channelId, lastPriceRef }) {
        const key = this.makeKey(guildId, token, contract);
        this.entries.set(key, {
            guildId,
            token,
            type,
            contract: contract ?? null,
            channelId,
            lastPriceRef,
        });
        this.save();
        return key;
    }

    unregister(key) {
        const removed = this.entries.delete(key);
        if (removed) this.save();
        return removed;
    }

    // ── Update cycle ──────────────────────────────────────────────────────────

    /**
     * Refresh every tracked channel name. Pool data is fetched once for the
     * whole cycle; channel renames are spaced out to stay friendly with the
     * Discord rate limiter.
     */
    async updateAll() {
        if (this.updating) {
            log.warn('Update already in progress, skipping this cycle.');
            return { skipped: true, updated: 0 };
        }
        if (this.entries.size === 0) return { skipped: false, updated: 0 };

        this.updating = true;
        let updated = 0;

        try {
            const waxUsd = await fetchWaxUsd();
            if (!waxUsd) {
                log.warn('WAX/USD price unavailable, update cycle cancelled.');
                return { skipped: true, updated: 0 };
            }

            const needsPools = [...this.entries.values()].some(e => POOL_BASED_TYPES.includes(e.type));
            let pools = [];
            if (needsPools) {
                try {
                    pools = await fetchAllPools();
                } catch (err) {
                    log.error(`Could not read AMM pools: ${err.message}`);
                    return { skipped: true, updated: 0 };
                }
            }

            for (const [key, entry] of [...this.entries]) {
                try {
                    const channel = await this.client.channels.fetch(entry.channelId).catch(() => null);
                    if (!channel) {
                        log.warn(`Channel gone for ${key}, dropping the tracker entry.`);
                        this.unregister(key);
                        continue;
                    }

                    let priceInWax = null;
                    if (entry.type === TOKEN_TYPE.STABLECOIN) {
                        priceInWax = 1 / waxUsd;
                    } else if (entry.type !== TOKEN_TYPE.NATIVE) {
                        priceInWax = findPoolPriceInWax(pools, entry.token, entry.contract);
                        if (priceInWax === null) {
                            log.warn(`No ${entry.token}/WAX pool found (contract: ${entry.contract}).`);
                            continue;
                        }
                    }

                    const priceRef = entry.type === TOKEN_TYPE.NATIVE ? waxUsd : priceInWax;
                    const trend    = getTrendEmoji(entry.lastPriceRef, priceRef);
                    const newName  = buildChannelName(entry.token, entry.type, priceInWax, waxUsd, trend);

                    if (channel.name !== newName) {
                        await channel.setName(newName, 'WAX price update');
                        updated++;
                        await new Promise(r => setTimeout(r, config.tracker.renameSpacingMs));
                    }

                    entry.lastPriceRef = priceRef;
                    this.save();
                } catch (err) {
                    log.error(`Update failed for ${key}: ${err.message}`);
                }
            }
        } finally {
            this.updating = false;
        }

        return { skipped: false, updated };
    }

    start() {
        const { startupDelayMs, updateIntervalMs, updateIntervalMinutes } = config.tracker;

        const tick = () => this.updateAll().catch(err => log.error(`Update cycle crashed: ${err.message}`));

        this.startupTimer  = setTimeout(tick, startupDelayMs);
        this.intervalTimer = setInterval(tick, updateIntervalMs);

        log.info(`Price tracker started — refreshing every ${updateIntervalMinutes} minute(s).`);
    }

    stop() {
        if (this.startupTimer)  clearTimeout(this.startupTimer);
        if (this.intervalTimer) clearInterval(this.intervalTimer);
        this.startupTimer  = null;
        this.intervalTimer = null;
    }
}

module.exports = { CryptoTracker, TOKEN_TYPE, POOL_BASED_TYPES, buildChannelName, formatPrice };
