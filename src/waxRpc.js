'use strict';

const { config } = require('./config');
const log = require('./logger');

const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

const state = {
    preferredIndex: 0,
    failedUntil: new Map(),
};

/**
 * Endpoints ordered so the last known-good one comes first, with endpoints
 * that recently failed pushed out of rotation for a cooldown period.
 */
function getEndpointCandidates() {
    const endpoints = config.wax.endpoints;
    if (endpoints.length === 0) throw new Error('No WAX RPC endpoint configured.');

    const start = state.preferredIndex % endpoints.length;
    const ordered = endpoints.slice(start).concat(endpoints.slice(0, start));

    const now = Date.now();
    const available = ordered.filter(e => (state.failedUntil.get(e) || 0) <= now);

    return available.length > 0 ? available : ordered;
}

function markSuccess(endpoint) {
    const index = config.wax.endpoints.indexOf(endpoint);
    if (index !== -1) {
        state.preferredIndex = index;
        state.failedUntil.delete(endpoint);
    }
}

function markFailure(endpoint, cooldownMs = FAILURE_COOLDOWN_MS) {
    state.failedUntil.set(endpoint, Date.now() + cooldownMs);
}

async function postJson(url, payload, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
            signal:  controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * POST to a WAX chain API path, failing over across the configured endpoints.
 */
async function postWaxRpc(pathname, payload) {
    let lastError;

    for (const endpoint of getEndpointCandidates()) {
        try {
            const data = await postJson(`${endpoint}${pathname}`, payload, config.wax.timeoutMs);
            markSuccess(endpoint);
            return data;
        } catch (err) {
            lastError = err;
            markFailure(endpoint);
            log.warn(`WAX RPC endpoint failed (${endpoint}): ${err.message}`);
        }
    }

    throw lastError || new Error('No WAX RPC endpoint available.');
}

module.exports = { postWaxRpc, getEndpointCandidates };
