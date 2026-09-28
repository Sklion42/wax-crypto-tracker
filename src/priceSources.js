'use strict';

const { config } = require('./config');
const { postWaxRpc } = require('./waxRpc');
const log = require('./logger');

const COINGECKO_URL   = 'https://api.coingecko.com/api/v3/simple/price';
const TABLE_PAGE_SIZE = 100;
// Safety net: a pathological order book must not turn one cycle into hundreds
// of RPC calls. Best orders are searched within this window, far beyond the
// real depth of WAX order books.
const ORDER_MAX_ROWS  = 2000;
const WAX_SYMBOL      = 'WAX';

// 2^64, the scale of the price stored by the AMM (sqrtPriceX64).
const Q64 = 2 ** 64;

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

// ─── Chain helpers ────────────────────────────────────────────────────────────

/** Page through a table until the end (or until `maxRows`). */
async function fetchTableRows({ code, scope, table, limit = TABLE_PAGE_SIZE, maxRows = Infinity }) {
    const rows = [];
    let nextKey = '';

    while (rows.length < maxRows) {
        const data = await postWaxRpc('/v1/chain/get_table_rows', {
            json:        true,
            code,
            scope,
            table,
            lower_bound: nextKey,
            limit,
            reverse:     false,
            show_payer:  false,
        });

        if (Array.isArray(data.rows)) rows.push(...data.rows);

        if (!data.next_key || data.next_key === nextKey) break;
        nextKey = data.next_key;
    }

    return rows;
}

function parseQuantity(quantity) {
    if (typeof quantity !== 'string') return null;
    const [amount, symbol] = quantity.split(' ');
    const value = parseFloat(amount);
    if (!symbol || !Number.isFinite(value)) return null;
    // The asset's decimals give the symbol precision, needed to de-normalise
    // the AMM's raw price.
    const dot = amount.indexOf('.');
    const decimals = dot === -1 ? 0 : amount.length - dot - 1;
    return { value, symbol, decimals };
}

// ─── Source 1: swap.alcor AMM (type POOL) ─────────────────────────────────────
//
// Alcor runs two separate markets on two separate contracts:
//   • swap.alcor    → the concentrated-liquidity AMM (Uniswap V3 style)
//   • alcordexmain  → the order book
// A token can be liquid on one and residual on the other: reading the wrong
// source gives a believable but wrong price.

/**
 * Every row of the swap contract's `pools` table. One full scan per cycle
 * serves every tracked token: the table holds thousands of rows, re-paging it
 * for each token would cost a dozen RPC calls per token.
 */
async function fetchAllPools() {
    return fetchTableRows({
        code:  config.wax.swapContract,
        scope: config.wax.swapContract,
        table: 'pools',
    });
}

/**
 * Current pool price, read from `sqrtPriceX64`.
 *
 * swap.alcor is a concentrated-liquidity AMM: the reserves are only the total
 * deposited, spread over tick ranges. The `reserveQuote / reserveToken` ratio is
 * therefore NOT the price — it only gets close when liquidity is full-range. On
 * a pool whose liquidity is concentrated, or whose price left the band (nearly
 * one-sided reserves), that ratio is arbitrarily wrong.
 *
 * `sqrtPriceX64` is the square root of the tokenA price in tokenB, in raw units,
 * scaled by 2^64: raw_price = (sqrtPriceX64 / 2^64)². Converting to human units
 * corrects the precision gap between both symbols.
 */
function poolSqrtPrice(pool, a, b, tokenSide) {
    const raw = pool.sqrtPriceX64 ?? pool.sqrt_price_x64;
    if (raw === undefined || raw === null || raw === '') return null;

    const sqrtPrice = Number(raw) / Q64;
    if (!Number.isFinite(sqrtPrice) || sqrtPrice <= 0) return null;

    // tokenB per tokenA, in human units.
    const priceBperA = sqrtPrice * sqrtPrice * 10 ** (a.decimals - b.decimals);
    if (!Number.isFinite(priceBperA) || priceBperA <= 0) return null;

    // tokenSide === 'A' ⇒ quoted in B, the price already reads quote per token.
    const price = tokenSide === 'A' ? priceBperA : 1 / priceBperA;
    return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * A pool seen from the tracked token's side, or null when it does not hold the
 * requested pair.
 *
 * `quote` filters the quote token: it is what tells DEF/WAX apart from DEF/TLM.
 * Without a quote contract the symbol is enough — at the risk of a homonym,
 * which the caller resolves by listing the candidates.
 */
function describePool(pool, { token, contract, quote, quoteContract }) {
    if (pool.active === 0 || pool.active === false) return null;

    const a = parseQuantity(pool.tokenA?.quantity);
    const b = parseQuantity(pool.tokenB?.quantity);
    if (!a || !b) return null;

    const aContract = pool.tokenA?.contract;
    const bContract = pool.tokenB?.contract;

    const tokenSide =
        (a.symbol === token && aContract === contract) ? 'A' :
        (b.symbol === token && bContract === contract) ? 'B' : null;
    if (!tokenSide) return null;

    const quoted         = tokenSide === 'A' ? b : a;
    const quotedContract = tokenSide === 'A' ? bContract : aContract;

    if (quote && quoted.symbol !== quote) return null;
    if (quoteContract && quotedContract !== quoteContract) return null;

    const reserveToken = tokenSide === 'A' ? a.value : b.value;
    const reserveQuote = quoted.value;

    // The reserve ratio is only a last resort, for a pool exposing no current
    // price.
    const sqrt  = poolSqrtPrice(pool, a, b, tokenSide);
    const price = sqrt !== null
        ? sqrt
        : (reserveToken > 0 && reserveQuote > 0 ? reserveQuote / reserveToken : null);
    if (price === null) return null;

    const liquidity = Number(pool.liquidity ?? 0);

    return {
        poolId:        pool.id,
        quote:         quoted.symbol,
        quoteContract: quotedContract,
        fee:           pool.fee ?? null,
        liquidity:     Number.isFinite(liquidity) ? liquidity : 0,
        reserveToken,
        reserveQuote,
        price,
        fromReserves:  sqrt === null,
    };
}

/**
 * Every pool quoting `token` against the requested quote, most liquid first.
 * Alcor hosts several pools for one pair (different fee tiers) on top of
 * different pairs: choosing is the caller's job, never an implicit ranking.
 */
function findPoolCandidates(pools, target) {
    return pools
        .map(pool => describePool(pool, target))
        .filter(Boolean)
        .sort((x, y) => y.liquidity - x.liquidity);
}

/**
 * The pool of a tracked entry. `poolId` pins one precise pool — the command
 * records it when adding, so an update cycle can never slide from one pool to
 * another. Without `poolId` (entries created before that option), fall back to
 * the most liquid pool of the pair.
 */
function findPool(pools, target) {
    if (target.poolId !== undefined && target.poolId !== null) {
        const pool = pools.find(p => String(p.id) === String(target.poolId));
        if (!pool) return null;
        // The pair is re-checked: a pool can be removed and its id reused.
        return describePool(pool, { token: target.token, contract: target.contract });
    }
    return findPoolCandidates(pools, {
        token:    target.token,
        contract: target.contract,
        quote:    target.quote ?? WAX_SYMBOL,
        quoteContract: target.quoteContract ?? null,
    })[0] ?? null;
}

// ─── Source 2: alcordexmain order book (type STANDARD) ────────────────────────

/**
 * Normalise an `extended_symbol` from the `markets` table. The field comes as
 * "8,TLM" through get_table_rows, but the object form exists depending on the
 * ABI version: both are accepted rather than relying on one serialisation.
 */
function parseMarketToken(field) {
    if (!field) return null;
    const contract = field.contract ?? field.account ?? null;
    const sym = field.sym ?? field.symbol ?? null;

    if (typeof sym === 'string') {
        const [left, right] = sym.split(',');
        if (right === undefined) return { symbol: left, contract };
        return { symbol: right, decimals: parseInt(left, 10), contract };
    }
    if (sym && typeof sym === 'object') {
        const symbol = sym.name ?? sym.code ?? null;
        return symbol ? { symbol, decimals: sym.precision ?? null, contract } : null;
    }
    return null;
}

async function fetchAllMarkets() {
    return fetchTableRows({
        code:  config.wax.orderbookContract,
        scope: config.wax.orderbookContract,
        table: 'markets',
    });
}

/** The TOKEN/WAX market of the order book, or null when there is none. */
function findMarket(markets, token, contract) {
    const waxContract = config.wax.tokenContract;

    for (const market of markets) {
        if (market.frozen) continue;

        const base  = parseMarketToken(market.base_token  ?? market.base);
        const quote = parseMarketToken(market.quote_token ?? market.quote);
        if (!base || !quote) continue;

        const baseIsWax  = base.symbol  === WAX_SYMBOL && base.contract  === waxContract;
        const quoteIsWax = quote.symbol === WAX_SYMBOL && quote.contract === waxContract;
        if (!baseIsWax && !quoteIsWax) continue;

        const other = baseIsWax ? quote : base;
        if (other.symbol !== token || other.contract !== contract) continue;

        if (market.id === undefined || market.id === null) continue;
        return market;
    }
    return null;
}

/**
 * Unit price of an order, in WAX per token.
 *
 * An order holds what is given (`bid`) and what is asked (`ask`); the WAX side
 * tells which is which, so the same reading works for buy and sell orders.
 * `unit_price` is deliberately ignored: its scale depends on the market's
 * symbol precisions.
 */
function orderPriceInWax(order) {
    const bid = parseQuantity(order?.bid);
    const ask = parseQuantity(order?.ask);
    if (!bid || !ask) return null;

    let wax, tokens;
    if (bid.symbol === WAX_SYMBOL)      { wax = bid.value; tokens = ask.value; }
    else if (ask.symbol === WAX_SYMBOL) { wax = ask.value; tokens = bid.value; }
    else return null;

    if (!(wax > 0) || !(tokens > 0)) return null;
    return wax / tokens;
}

/** Best bid / best ask of a book, in WAX per token. */
function bestPricesFromOrders(buyOrders, sellOrders) {
    let bestBid = null;
    let bestAsk = null;

    for (const order of buyOrders) {
        const price = orderPriceInWax(order);
        if (price !== null && (bestBid === null || price > bestBid)) bestBid = price;
    }
    for (const order of sellOrders) {
        const price = orderPriceInWax(order);
        if (price !== null && (bestAsk === null || price < bestAsk)) bestAsk = price;
    }

    return { bestBid, bestAsk };
}

/**
 * Order book price: the mid-spread when both sides exist, otherwise the only
 * quoted side. The RPC does not give the last traded price (that is off-chain
 * history); the mid is the closest estimate of what Alcor displays.
 */
function orderBookPriceInWax(buyOrders, sellOrders) {
    const { bestBid, bestAsk } = bestPricesFromOrders(buyOrders, sellOrders);
    if (bestBid !== null && bestAsk !== null) return (bestBid + bestAsk) / 2;
    return bestBid ?? bestAsk;
}

async function fetchOrders(table, marketId) {
    return fetchTableRows({
        code:    config.wax.orderbookContract,
        // Orders are scoped by market id, not by name.
        scope:   String(marketId),
        table,
        maxRows: ORDER_MAX_ROWS,
    });
}

async function fetchOrderBookPriceInWax(markets, token, contract) {
    const market = findMarket(markets, token, contract);
    if (!market) return null;

    const [buyOrders, sellOrders] = await Promise.all([
        fetchOrders('buyorder',  market.id),
        fetchOrders('sellorder', market.id),
    ]);

    return orderBookPriceInWax(buyOrders, sellOrders);
}

/** One-off lookup, used when adding an order-book token. */
async function fetchTokenPriceInWax(token, contract) {
    return fetchOrderBookPriceInWax(await fetchAllMarkets(), token, contract);
}

module.exports = {
    WAX_SYMBOL,
    fetchWaxUsd,
    // AMM
    fetchAllPools,
    findPoolCandidates,
    findPool,
    // Order book
    fetchAllMarkets,
    findMarket,
    orderPriceInWax,
    orderBookPriceInWax,
    fetchOrderBookPriceInWax,
    fetchTokenPriceInWax,
};
