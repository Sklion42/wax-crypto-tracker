'use strict';

const { config } = require('./config');
const { postWaxRpc } = require('./waxRpc');
const log = require('./logger');

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const POOL_PAGE_SIZE = 100;

// ─── WAX / USD (CoinGecko) ────────────────────────────────────────────────────

/**
 * Spot WAX price in USD. Returns null when every attempt fails, so callers can
 * skip an update cycle instead of writing a wrong price into a channel name.
 */
async function fetchWaxUsd(retries = 3, timeoutMs = 8000) {
    const url = `${COINGECKO_URL}?ids=${encodeURIComponent(config.coingecko.waxId)}&vs_currencies=usd`;
    const headers = config.coingecko.apiKey
        ? { 'x-cg-demo-api-key': config.coingecko.apiKey }
        : {};

    for (let attempt = 1; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { headers, signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const price = data?.[config.coingecko.waxId]?.usd;
            return typeof price === 'number' ? price : null;
        } catch (err) {
            if (attempt === retries) {
                log.error(`CoinGecko lookup failed after ${retries} attempts: ${err.message}`);
                return null;
            }
            await new Promise(r => setTimeout(r, 2000 * attempt));
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

// ─── Alcor AMM pools ──────────────────────────────────────────────────────────

/**
 * Every row of the swap contract's `pools` table. One full scan serves all the
 * tokens of an update cycle, so a server tracking ten tokens still pages the
 * table once.
 */
async function fetchAllPools() {
    const pools = [];
    let nextKey = '';

    while (true) {
        const data = await postWaxRpc('/v1/chain/get_table_rows', {
            json:        true,
            code:        config.wax.swapContract,
            scope:       config.wax.swapContract,
            table:       'pools',
            lower_bound: nextKey,
            limit:       POOL_PAGE_SIZE,
            reverse:     false,
            show_payer:  false,
        });

        if (Array.isArray(data.rows)) pools.push(...data.rows);

        if (!data.next_key || data.next_key === nextKey) break;
        nextKey = data.next_key;
    }

    return pools;
}

function parseQuantity(quantity) {
    if (typeof quantity !== 'string') return null;
    const [amount, symbol] = quantity.split(' ');
    const value = parseFloat(amount);
    if (!symbol || !Number.isFinite(value)) return null;
    return { value, symbol };
}

/**
 * Price of `token` expressed in WAX, read from the deepest TOKEN/WAX pool.
 * Picking the deepest pool matters because Alcor can hold several pools for the
 * same pair, and a near-empty one gives a wildly off ratio.
 */
function findPoolPriceInWax(pools, token, contract) {
    let best = null;

    for (const pool of pools) {
        const a = parseQuantity(pool.tokenA?.quantity);
        const b = parseQuantity(pool.tokenB?.quantity);
        if (!a || !b) continue;

        const aContract = pool.tokenA?.contract;
        const bContract = pool.tokenB?.contract;

        const waxSide =
            (a.symbol === 'WAX' && aContract === config.wax.tokenContract) ? 'A' :
            (b.symbol === 'WAX' && bContract === config.wax.tokenContract) ? 'B' : null;
        if (!waxSide) continue;

        const tokenSide =
            (a.symbol === token && aContract === contract) ? 'A' :
            (b.symbol === token && bContract === contract) ? 'B' : null;
        if (!tokenSide || tokenSide === waxSide) continue;

        const waxReserve   = waxSide   === 'A' ? a.value : b.value;
        const tokenReserve = tokenSide === 'A' ? a.value : b.value;
        if (tokenReserve <= 0 || waxReserve <= 0) continue;

        if (!best || waxReserve > best.waxReserve) {
            best = { waxReserve, price: waxReserve / tokenReserve };
        }
    }

    return best ? best.price : null;
}

/** Convenience wrapper for one-off lookups (used when adding a token). */
async function fetchPoolPriceInWax(token, contract) {
    const pools = await fetchAllPools();
    return findPoolPriceInWax(pools, token, contract);
}

module.exports = { fetchWaxUsd, fetchAllPools, findPoolPriceInWax, fetchPoolPriceInWax };
