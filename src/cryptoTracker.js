'use strict';

const fs   = require('fs');
const path = require('path');

const { config } = require('./config');
const log = require('./logger');
const {
    WAX_SYMBOL,
    fetchWaxUsd,
    fetchAllPools,
    findPoolCandidates,
    findPool,
    fetchAllMarkets,
    fetchOrderBookPriceInWax,
    fetchTokenPriceInWax,
} = require('./priceSources');

// ─── Token types ──────────────────────────────────────────────────────────────

const TOKEN_TYPE = {
    NATIVE:     'native',     // WAX      → $ from CoinGecko
    STABLECOIN: 'stablecoin', // WAXUSDC  → WAX, via 1 / waxUsd
    STANDARD:   'standard',   // TLM, ... → $ and WAX, from the Alcor order book
    POOL:       'pool',       // DEF, ... → price of one Alcor AMM pool (swap.alcor)
};

/** Types that need a token contract to locate their market. */
const CONTRACT_TYPES = [TOKEN_TYPE.STANDARD, TOKEN_TYPE.POOL];

// ─── Formatting ───────────────────────────────────────────────────────────────

function getTrendEmoji(oldPrice, newPrice) {
    if (oldPrice === null || oldPrice === undefined) return '➡️';
    if (newPrice > oldPrice) return '↗️';
    if (newPrice < oldPrice) return '↘️';
    return '➡️';
}

/** Dollar amount: readable first, precision follows magnitude. */
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

/**
 * Amount denominated in a token: 8 decimals, the WAX asset precision, with no
 * trailing zeros. A pool price must be comparable with the figure Alcor shows,
 * which rounding to two decimals would prevent.
 */
function formatTokenAmount(value) {
    const num = parseFloat(value);
    if (!Number.isFinite(num) || num === 0) return '0';
    if (Math.abs(num) < 1e-8)  return num.toExponential(2);
    if (Math.abs(num) >= 1000) return Math.round(num).toLocaleString('en-US');
    return String(Number(num.toFixed(8)));
}

/** Discord caps channel names at 100 characters. */
function buildChannelName(token, type, price, waxUsd, trend, quote = WAX_SYMBOL) {
    let name;

    if (type === TOKEN_TYPE.NATIVE) {
        name = `${trend} ${token}: $${formatPrice(waxUsd)}`;
    } else if (type === TOKEN_TYPE.STABLECOIN) {
        name = `${trend} ${token}: ${formatTokenAmount(price)} WAX`;
    } else if ((quote ?? WAX_SYMBOL) !== WAX_SYMBOL) {
        // A pool quoted in something else than WAX shows the price as the
        // market quotes it: going through a second market to get a $ figure
        // would display a price that exists on neither.
        name = `${trend} ${token}: ${formatTokenAmount(price)} ${quote}`;
    } else {
        const priceUsd = price * waxUsd;
        name = `${trend} ${token}: $${formatPrice(priceUsd)} | ${formatTokenAmount(price)} WAX`;
    }

    return name.slice(0, 100);
}

/**
 * The WAX/USD price is only needed to show a $ amount: a pool quoted outside
 * WAX does without it entirely.
 */
function needsWaxUsd(entry) {
    return !(entry.type === TOKEN_TYPE.POOL && (entry.quote ?? WAX_SYMBOL) !== WAX_SYMBOL);
}

/**
 * Tracked entries matching a filter, as [key, entry] pairs.
 *
 * Matching is done on the entry fields, not on a key prefix: filtering
 * `defensetoken` by prefix caught both `DEF|defensetoken` and
 * `DEF|defensetoken#10448`, which made the former impossible to single out —
 * and therefore to remove.
 */
function matchTrackings(entries, { guildId = null, token = null, contract = null, poolId = null } = {}) {
    return [...entries].filter(([, entry]) => {
        if (guildId && entry.guildId !== guildId) return false;
        if (token && entry.token !== token) return false;
        if (contract && (entry.contract ?? null) !== contract) return false;
        if (poolId !== null && poolId !== undefined
            && String(entry.poolId ?? '') !== String(poolId)) return false;
        return true;
    });
}

/** Human-readable label of an entry, for logs. */
function describeTarget(entry) {
    const pair = `${entry.token}/${entry.quote ?? WAX_SYMBOL}`;
    const pool = entry.poolId !== undefined && entry.poolId !== null ? ` pool #${entry.poolId}` : '';
    return `${pair} (${entry.contract})${pool}`;
}

// ─── Tracker ──────────────────────────────────────────────────────────────────

class CryptoTracker {
    /**
     * @param {import('discord.js').Client} client
     */
    constructor(client) {
        this.client = client;
        /** @type {Map<string, object>} keyed by `${guildId}:${token}[|contract][#poolId]` */
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

    makeKey(guildId, token, contract = null, poolId = null) {
        const base = contract ? `${guildId}:${token}|${contract}` : `${guildId}:${token}`;
        // A token can be tracked on several pools (DEF/WAX and DEF/TLM): the
        // pool id is part of the entry's identity.
        return poolId === null || poolId === undefined ? base : `${base}#${poolId}`;
    }

    /** Key without its guild prefix, as shown to server admins. */
    displayKey(key) {
        return key.split(':').slice(1).join(':');
    }

    /** Entries belonging to one guild, as [key, entry] pairs. */
    listForGuild(guildId) {
        return matchTrackings(this.entries, { guildId });
    }

    /** Entries of one guild matching a token / contract / pool filter. */
    match(guildId, filter = {}) {
        return matchTrackings(this.entries, { ...filter, guildId });
    }

    // ── Adding a token ────────────────────────────────────────────────────────

    /**
     * Candidate pools for a token, most liquid first, so the command can ask
     * the admin to pick when the pair is ambiguous.
     */
    async fetchPoolCandidates(token, contract, { quote, quoteContract } = {}) {
        return findPoolCandidates(await fetchAllPools(), { token, contract, quote, quoteContract });
    }

    /**
     * Resolve the current price of a token, which doubles as validation that
     * the symbol/contract pair really exists on chain. For a pool, `pool` is
     * the candidate the command already picked: it is not resolved again here,
     * otherwise the price validated when adding would not be the one displayed
     * afterwards.
     *
     * @returns {Promise<{price: number|null, waxUsd: number|null, quote: string}|null>}
     */
    async fetchInitialData(token, type, contract = null, pool = null) {
        const waxUsd = await fetchWaxUsd();

        if (type === TOKEN_TYPE.POOL) {
            if (!pool) return null;
            // A pool quoted outside WAX does not need the WAX price to be
            // displayed: its absence must not block the addition.
            if (!waxUsd && pool.quote === WAX_SYMBOL) return null;
            return { price: pool.price, waxUsd, quote: pool.quote };
        }

        if (!waxUsd) return null;

        if (type === TOKEN_TYPE.NATIVE)     return { price: null, waxUsd, quote: WAX_SYMBOL };
        if (type === TOKEN_TYPE.STABLECOIN) return { price: 1 / waxUsd, waxUsd, quote: WAX_SYMBOL };

        // STANDARD: order book
        if (!contract) return null;
        const price = await fetchTokenPriceInWax(token, contract);
        if (price === null) return null;
        return { price, waxUsd, quote: WAX_SYMBOL };
    }

    register({ guildId, token, type, contract, pool = null, channelId, lastPriceRef }) {
        const key = this.makeKey(guildId, token, contract, pool?.poolId ?? null);
        this.entries.set(key, {
            guildId,
            token,
            type,
            contract:      contract ?? null,
            quote:         pool?.quote ?? null,
            quoteContract: pool?.quoteContract ?? null,
            poolId:        pool?.poolId ?? null,
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
     * Refresh every tracked channel name. Pool and market tables are fetched
     * once for the whole cycle; channel renames are spaced out to stay friendly
     * with the Discord rate limiter.
     */
    async updateAll() {
        // A slow cycle (lagging RPC, many tokens) must not be overtaken by the
        // next one: renames would pile up past the Discord limit.
        if (this.updating) {
            log.warn('Update already in progress, skipping this cycle.');
            return { skipped: true, updated: 0 };
        }
        if (this.entries.size === 0) return { skipped: false, updated: 0 };

        this.updating = true;
        let updated = 0;
        let dirty = false;

        try {
            const all    = [...this.entries.values()];
            const waxUsd = await fetchWaxUsd();

            if (!waxUsd) {
                // A pool quoted outside WAX displays without the WAX price: the
                // cycle goes on for those and only skips the others.
                if (!all.some(e => !needsWaxUsd(e))) {
                    log.warn('WAX/USD price unavailable, update cycle cancelled.');
                    return { skipped: true, updated: 0 };
                }
                log.warn('WAX/USD price unavailable — only pools quoted outside WAX are refreshed.');
            }

            const needsPools   = all.some(e => e.type === TOKEN_TYPE.POOL);
            const needsMarkets = all.some(e => e.type === TOKEN_TYPE.STANDARD);

            // Both reference tables are scanned once per cycle and shared by
            // every token of the same type.
            let pools = [];
            if (needsPools) {
                try {
                    pools = await fetchAllPools();
                } catch (err) {
                    log.error(`Could not read AMM pools: ${err.message}`);
                    return { skipped: true, updated: 0 };
                }
            }

            let markets = [];
            if (needsMarkets) {
                try {
                    markets = await fetchAllMarkets();
                } catch (err) {
                    log.error(`Could not read order book markets: ${err.message}`);
                    return { skipped: true, updated: 0 };
                }
            }

            for (const [key, entry] of [...this.entries]) {
                try {
                    const channel = await this.client.channels.fetch(entry.channelId).catch(() => null);
                    if (!channel) {
                        log.warn(`Channel gone for ${key}, dropping the tracker entry.`);
                        this.entries.delete(key);
                        dirty = true;
                        continue;
                    }

                    if (!waxUsd && needsWaxUsd(entry)) continue;

                    let price = null;
                    let quote = entry.quote ?? WAX_SYMBOL;

                    if (entry.type === TOKEN_TYPE.STABLECOIN) {
                        price = 1 / waxUsd;
                    } else if (entry.type === TOKEN_TYPE.POOL) {
                        const pool = findPool(pools, entry);
                        if (!pool) {
                            log.warn(`AMM pool not found for ${describeTarget(entry)}.`);
                            continue;
                        }
                        price = pool.price;
                        quote = pool.quote;
                    } else if (entry.type === TOKEN_TYPE.STANDARD) {
                        price = await fetchOrderBookPriceInWax(markets, entry.token, entry.contract);
                        if (price === null) {
                            log.warn(`Order book empty or missing for ${entry.token} (${entry.contract}).`);
                            continue;
                        }
                    } else if (entry.type !== TOKEN_TYPE.NATIVE) {
                        log.warn(`Unknown type "${entry.type}" for ${key}, ignored.`);
                        continue;
                    }

                    const priceRef = entry.type === TOKEN_TYPE.NATIVE ? waxUsd : price;
                    const trend    = getTrendEmoji(entry.lastPriceRef, priceRef);
                    const newName  = buildChannelName(entry.token, entry.type, price, waxUsd, trend, quote);

                    if (channel.name !== newName) {
                        await channel.setName(newName, 'WAX price update');
                        updated++;
                        await new Promise(r => setTimeout(r, config.tracker.renameSpacingMs));
                    }

                    if (entry.lastPriceRef !== priceRef) {
                        entry.lastPriceRef = priceRef;
                        dirty = true;
                    }
                } catch (err) {
                    log.error(`Update failed for ${key}: ${err.message}`);
                }
            }
        } finally {
            // One disk write per cycle instead of one per token.
            if (dirty) this.save();
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

module.exports = {
    CryptoTracker,
    TOKEN_TYPE,
    CONTRACT_TYPES,
    buildChannelName,
    formatPrice,
    formatTokenAmount,
    matchTrackings,
};
