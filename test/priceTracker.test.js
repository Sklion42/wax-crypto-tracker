'use strict';

// Price maths is the fragile part of the tracker: it must be checkable without
// network access or a Discord client. Nothing here performs a request.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    findPool,
    findPoolCandidates,
    findMarket,
    orderPriceInWax,
    orderBookPriceInWax,
} = require('../src/priceSources');
const {
    buildChannelName,
    formatTokenAmount,
    matchTrackings,
} = require('../src/cryptoTracker');

const DEF = { token: 'DEF', contract: 'defensetoken' };
const Q64 = 2 ** 64;

const close = (actual, expected, eps = 1e-9) =>
    assert.ok(Math.abs(actual - expected) < eps, `expected ~${expected}, got ${actual}`);

/** sqrtPriceX64 matching `price` tokenB per tokenA, in human units. */
function sqrtPriceX64(price, decimalsA, decimalsB) {
    const raw = price * 10 ** (decimalsB - decimalsA);
    return String(BigInt(Math.round(Math.sqrt(raw) * Q64)));
}

function pool(overrides = {}) {
    return {
        id: 1,
        active: 1,
        tokenA: { quantity: '1000.00000000 DEF', contract: 'defensetoken' },
        tokenB: { quantity: '1000.00000000 WAX', contract: 'eosio.token' },
        liquidity: '1000000',
        sqrtPriceX64: sqrtPriceX64(0.5, 8, 8),
        ...overrides,
    };
}

const poolPrice = (pools, target) => findPool(pools, target)?.price ?? null;

// ─── AMM (type pool) ──────────────────────────────────────────────────────────

test('AMM price comes from sqrtPriceX64, not from the reserve ratio', () => {
    // 1:1 reserves — an unbalanced concentrated-liquidity pool would give 1.0
    // with the reserve ratio, while its current price is 0.5.
    close(poolPrice([pool()], { ...DEF, quote: 'WAX' }), 0.5);
});

test('a pool with nearly one-sided reserves keeps the right price', () => {
    // Price left the band, almost only WAX remains. Reserve ratio = 25,000,
    // real price = 0.5.
    close(poolPrice([pool({
        tokenA: { quantity: '0.20000000 DEF', contract: 'defensetoken' },
        tokenB: { quantity: '5000.00000000 WAX', contract: 'eosio.token' },
    })], { ...DEF, quote: 'WAX' }), 0.5);
});

test('price is right when WAX is tokenA', () => {
    close(poolPrice([pool({
        tokenA: { quantity: '1000.00000000 WAX', contract: 'eosio.token' },
        tokenB: { quantity: '1000.00000000 DEF', contract: 'defensetoken' },
        // 2 DEF per WAX ⇒ 0.5 WAX per DEF.
        sqrtPriceX64: sqrtPriceX64(2, 8, 8),
    })], { ...DEF, quote: 'WAX' }), 0.5);
});

test('different symbol precisions are corrected', () => {
    close(poolPrice([pool({
        tokenA: { quantity: '1000.0000 DEF', contract: 'defensetoken' },
        sqrtPriceX64: sqrtPriceX64(0.5, 4, 8),
    })], { ...DEF, quote: 'WAX' }), 0.5);
});

test('without pool_id, the most liquid pool of the pair is the default', () => {
    close(poolPrice([
        pool({ id: 1, liquidity: '10',      sqrtPriceX64: sqrtPriceX64(9, 8, 8) }),
        pool({ id: 2, liquidity: '9000000', sqrtPriceX64: sqrtPriceX64(0.5, 8, 8) }),
    ], DEF), 0.5);
});

test('without a current price, the reserve ratio is the last resort', () => {
    assert.equal(poolPrice([pool({
        sqrtPriceX64: undefined,
        tokenB: { quantity: '250.00000000 WAX', contract: 'eosio.token' },
    })], DEF), 0.25);
});

test('a pool of the same symbol on another contract is ignored', () => {
    assert.equal(poolPrice([pool({ tokenA: { quantity: '1000.00000000 DEF', contract: 'fakedeftoken' } })], DEF), null);
});

test('an inactive pool is ignored', () => {
    assert.equal(poolPrice([pool({ active: 0 })], DEF), null);
});

// ─── Pool selection ───────────────────────────────────────────────────────────

/** The two DEF pools of the real case: DEF/WAX and DEF/TLM. */
function twoPairs() {
    return [
        pool({ id: 11, liquidity: '5000',
            sqrtPriceX64: sqrtPriceX64(5.77108807, 8, 8) }),
        pool({ id: 22, liquidity: '900000',
            tokenB: { quantity: '1000.00000000 TLM', contract: 'alien.worlds' },
            sqrtPriceX64: sqrtPriceX64(22.5372, 8, 8) }),
    ];
}

test('the quote selects the pair, not liquidity', () => {
    const pools = twoPairs();

    const wax = findPool(pools, { ...DEF, quote: 'WAX' });
    assert.equal(wax.poolId, 11);
    assert.equal(wax.quote, 'WAX');
    close(wax.price, 5.77108807, 1e-6);

    const tlm = findPool(pools, { ...DEF, quote: 'TLM' });
    assert.equal(tlm.poolId, 22);
    assert.equal(tlm.quote, 'TLM');
    close(tlm.price, 22.5372, 1e-6);
});

test('an entry with no quote defaults to the WAX pair, even if another pair is deeper', () => {
    // Entries created before pool pinning carry no quote: they must not slide
    // to the TLM pool and start showing a TLM price as WAX.
    assert.equal(findPool(twoPairs(), DEF).poolId, 11);
});

test('pool_id pins the tracked pool, whatever the requested quote', () => {
    const pinned = findPool(twoPairs(), { ...DEF, poolId: 22, quote: 'WAX' });
    assert.equal(pinned.poolId, 22);
    assert.equal(pinned.quote, 'TLM');
});

test('a pool_id that does not quote the token returns nothing', () => {
    assert.equal(findPool(twoPairs(), { ...DEF, poolId: 99 }), null);
    assert.equal(findPool(twoPairs(), { token: 'TLM', contract: 'alien.worlds', poolId: 11 }), null);
});

test('candidates list every pool of the token, most liquid first', () => {
    const candidates = findPoolCandidates(twoPairs(), DEF);
    assert.deepEqual(candidates.map(c => c.poolId), [22, 11]);
    assert.deepEqual(candidates.map(c => c.quote), ['TLM', 'WAX']);
    assert.deepEqual(candidates.map(c => c.quoteContract), ['alien.worlds', 'eosio.token']);
});

test('the quote contract separates two homonymous quotes', () => {
    const pools = [
        pool({ id: 31, tokenB: { quantity: '1000.00000000 TLM', contract: 'alien.worlds' },
               sqrtPriceX64: sqrtPriceX64(22.5372, 8, 8) }),
        pool({ id: 32, liquidity: '999999999',
               tokenB: { quantity: '1000.00000000 TLM', contract: 'faketlmtoken' },
               sqrtPriceX64: sqrtPriceX64(1, 8, 8) }),
    ];
    assert.equal(findPool(pools, { ...DEF, quote: 'TLM', quoteContract: 'alien.worlds' }).poolId, 31);
});

// ─── Order book (type standard) ───────────────────────────────────────────────

test('the TOKEN/WAX market is found whichever side the token is on', () => {
    const markets = [
        { id: 1, base_token: { sym: '8,TLM', contract: 'alien.worlds' }, quote_token: { sym: '6,USDT', contract: 'tethertether' } },
        { id: 2, base_token: { sym: '8,TLM', contract: 'alien.worlds' }, quote_token: { sym: '8,WAX', contract: 'eosio.token' } },
    ];
    assert.equal(findMarket(markets, 'TLM', 'alien.worlds').id, 2);

    const reversed = [{ id: 7, base_token: { sym: '8,WAX', contract: 'eosio.token' }, quote_token: { sym: '8,TLM', contract: 'alien.worlds' } }];
    assert.equal(findMarket(reversed, 'TLM', 'alien.worlds').id, 7);
});

test('a frozen market or one on another contract is not picked', () => {
    const frozen = [{ id: 2, frozen: 1, base_token: { sym: '8,TLM', contract: 'alien.worlds' }, quote_token: { sym: '8,WAX', contract: 'eosio.token' } }];
    assert.equal(findMarket(frozen, 'TLM', 'alien.worlds'), null);

    const impostor = [{ id: 3, base_token: { sym: '8,TLM', contract: 'faketlmtoken' }, quote_token: { sym: '8,WAX', contract: 'eosio.token' } }];
    assert.equal(findMarket(impostor, 'TLM', 'alien.worlds'), null);
});

test('an order unit price is read from its WAX side', () => {
    assert.equal(orderPriceInWax({ bid: '100.00000000 WAX', ask: '400.00000000 TLM' }), 0.25);
    assert.equal(orderPriceInWax({ bid: '400.00000000 TLM', ask: '100.00000000 WAX' }), 0.25);
    assert.equal(orderPriceInWax({ bid: '1.000000 USDT', ask: '400.00000000 TLM' }), null);
});

test('the book price is the mid-spread', () => {
    const buys  = [{ bid: '10.00000000 WAX', ask: '50.00000000 TLM' },   // 0.2
                   { bid: '10.00000000 WAX', ask: '40.00000000 TLM' }];  // 0.25 ← best bid
    const sells = [{ bid: '10.00000000 TLM', ask: '4.00000000 WAX' },    // 0.4
                   { bid: '10.00000000 TLM', ask: '3.50000000 WAX' }];   // 0.35 ← best ask
    assert.equal(orderBookPriceInWax(buys, sells), 0.3);
});

test('a one-sided book returns that side, an empty book returns null', () => {
    assert.equal(orderBookPriceInWax([{ bid: '10.00000000 WAX', ask: '40.00000000 TLM' }], []), 0.25);
    assert.equal(orderBookPriceInWax([], [{ bid: '10.00000000 TLM', ask: '3.50000000 WAX' }]), 0.35);
    assert.equal(orderBookPriceInWax([], []), null);
});

// ─── Display ──────────────────────────────────────────────────────────────────

test('token amounts keep Alcor precision, without trailing zeros', () => {
    assert.equal(formatTokenAmount(5.77108807), '5.77108807');
    assert.equal(formatTokenAmount(22.5372), '22.5372');
    assert.equal(formatTokenAmount(0.2509009), '0.2509009');
    assert.equal(formatTokenAmount(1.5), '1.5');
    assert.equal(formatTokenAmount(0), '0');
});

test('a WAX-quoted pool shows $ and WAX', () => {
    assert.equal(
        buildChannelName('DEF', 'pool', 5.77108807, 0.006, '↗️', 'WAX'),
        '↗️ DEF: $0.0346 | 5.77108807 WAX'
    );
});

test('a pool quoted outside WAX shows the pool price, with no $ conversion', () => {
    assert.equal(
        buildChannelName('DEF', 'pool', 22.5372, 0.006, '↗️', 'TLM'),
        '↗️ DEF: 22.5372 TLM'
    );
});

test('native and stablecoin formats are unchanged', () => {
    assert.equal(buildChannelName('WAX', 'native', null, 0.0412, '➡️'), '➡️ WAX: $0.0412');
    assert.equal(buildChannelName('WAXUSDC', 'stablecoin', 24.2718, 0.0412, '➡️'), '➡️ WAXUSDC: 24.2718 WAX');
});

// ─── Picking an entry (remove) ────────────────────────────────────────────────

/** The real state that made the old DEF entry impossible to remove. */
function trackings() {
    return new Map([
        ['g1:WAX',                    { guildId: 'g1', token: 'WAX', type: 'native', contract: null }],
        ['g1:TLM|alien.worlds',       { guildId: 'g1', token: 'TLM', type: 'standard', contract: 'alien.worlds' }],
        // Old entry, created before the pool_id option: no poolId.
        ['g1:DEF|defensetoken',       { guildId: 'g1', token: 'DEF', type: 'pool', contract: 'defensetoken' }],
        ['g1:DEF|defensetoken#10448', { guildId: 'g1', token: 'DEF', type: 'pool', contract: 'defensetoken',
                                        quote: 'WAX', poolId: 10448 }],
        ['g2:DEF|defensetoken',       { guildId: 'g2', token: 'DEF', type: 'pool', contract: 'defensetoken' }],
    ]);
}

test('entries are scoped to their guild', () => {
    assert.equal(matchTrackings(trackings(), { guildId: 'g1' }).length, 4);
    assert.deepEqual(
        matchTrackings(trackings(), { guildId: 'g2', token: 'DEF' }).map(([k]) => k),
        ['g2:DEF|defensetoken']
    );
});

test('the contract no longer mixes the old entry up with the pool-pinned one', () => {
    const both = matchTrackings(trackings(), { guildId: 'g1', token: 'DEF', contract: 'defensetoken' });
    assert.deepEqual(both.map(([k]) => k), ['g1:DEF|defensetoken', 'g1:DEF|defensetoken#10448']);

    const pinned = matchTrackings(trackings(), { guildId: 'g1', token: 'DEF', poolId: 10448 });
    assert.deepEqual(pinned.map(([k]) => k), ['g1:DEF|defensetoken#10448']);
});

test('a contract that is only a prefix of another does not match', () => {
    const entries = new Map([
        ['g1:DEF|defense',      { guildId: 'g1', token: 'DEF', type: 'pool', contract: 'defense' }],
        ['g1:DEF|defensetoken', { guildId: 'g1', token: 'DEF', type: 'pool', contract: 'defensetoken' }],
    ]);
    assert.deepEqual(matchTrackings(entries, { contract: 'defense' }).map(([k]) => k), ['g1:DEF|defense']);
});

test('a filter with no match returns nothing', () => {
    assert.deepEqual(matchTrackings(trackings(), { guildId: 'g1', token: 'DEF', poolId: 99 }), []);
    assert.deepEqual(matchTrackings(trackings(), { guildId: 'g1', token: 'NOPE' }), []);
});
