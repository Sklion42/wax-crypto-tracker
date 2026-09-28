'use strict';

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    MessageFlags,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ComponentType,
} = require('discord.js');

const { config } = require('../config');
const { t } = require('../i18n');
const {
    TOKEN_TYPE,
    CONTRACT_TYPES,
    buildChannelName,
    formatTokenAmount,
} = require('../cryptoTracker');
const log = require('../logger');

const typeLabel   = (type) => t(`label_${type}`) === `label_${type}` ? `❓ ${type}` : t(`label_${type}`);
const sourceLabel = (type) => [TOKEN_TYPE.STANDARD, TOKEN_TYPE.POOL].includes(type)
    ? t(`source_${type}`)
    : t('source_default');

// Discord limits for a select menu.
const SELECT_MAX_OPTIONS = 25;
const SELECT_MAX_TEXT    = 100;
const SELECT_TIMEOUT_MS  = 60_000;
// Discord caps message content at 2000 characters.
const MESSAGE_MAX        = 2000;

const truncate = (text, max) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Alcor pool fee, expressed in hundredths of a basis point. */
const formatFee = (fee) =>
    fee === null || fee === undefined ? t('fee_unknown') : `${(fee / 10000).toFixed(2)}%`;

/** One line per candidate pool, so the admin picks with full knowledge. */
function describeCandidates(token, candidates) {
    return candidates.map(c =>
        t('candidate_line',
            c.poolId, token, formatTokenAmount(c.price), c.quote, c.quoteContract,
            formatFee(c.fee), formatTokenAmount(c.reserveToken), formatTokenAmount(c.reserveQuote)) +
        (c.fromReserves ? t('candidate_estimated') : '')
    ).join('\n');
}

/**
 * What tells an entry apart from the others of the same token: pair and pool
 * for an AMM entry, the bare symbol otherwise.
 */
function describePair(entry) {
    if (entry.poolId === null || entry.poolId === undefined) {
        return entry.type === TOKEN_TYPE.POOL ? t('pool_not_pinned', entry.token) : entry.token;
    }
    return `${entry.token}/${entry.quote ?? 'WAX'} #${entry.poolId}`;
}

/** Contract and channel of an entry, to tell two entries of a token apart. */
function describeChannel(interaction, entry) {
    const channel = interaction.guild.channels.cache.get(entry.channelId);
    return `${entry.contract ?? t('no_contract')} — ${channel ? channel.name : t('channel_missing')}`;
}

// ─── Command definition ───────────────────────────────────────────────────────

const data = new SlashCommandBuilder()
    .setName('crypto-tracker')
    .setDescription(t('cmd_description'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false)
    .addSubcommand(sub =>
        sub.setName('add')
            .setDescription(t('cmd_add'))
            .addStringOption(opt =>
                opt.setName('token')
                    .setDescription(t('opt_token'))
                    .setRequired(true))
            .addStringOption(opt =>
                opt.setName('type')
                    .setDescription(t('opt_type'))
                    .setRequired(false)
                    .addChoices(
                        { name: t('type_standard'),   value: TOKEN_TYPE.STANDARD },
                        { name: t('type_stablecoin'), value: TOKEN_TYPE.STABLECOIN },
                        { name: t('type_native'),     value: TOKEN_TYPE.NATIVE },
                        { name: t('type_pool'),       value: TOKEN_TYPE.POOL },
                    ))
            .addStringOption(opt =>
                opt.setName('contract')
                    .setDescription(t('opt_contract'))
                    .setRequired(false))
            .addStringOption(opt =>
                opt.setName('quote')
                    .setDescription(t('opt_quote'))
                    .setRequired(false))
            .addStringOption(opt =>
                opt.setName('quote_contract')
                    .setDescription(t('opt_quote_contract'))
                    .setRequired(false))
            .addIntegerOption(opt =>
                opt.setName('pool_id')
                    .setDescription(t('opt_pool_id'))
                    .setRequired(false))
            .addChannelOption(opt =>
                opt.setName('category')
                    .setDescription(t('opt_category'))
                    .addChannelTypes(ChannelType.GuildCategory)
                    .setRequired(false)))
    .addSubcommand(sub =>
        sub.setName('remove')
            .setDescription(t('cmd_remove'))
            .addStringOption(opt =>
                opt.setName('token')
                    .setDescription(t('opt_token_remove'))
                    .setRequired(false))
            .addStringOption(opt =>
                opt.setName('contract')
                    .setDescription(t('opt_contract_remove'))
                    .setRequired(false))
            .addIntegerOption(opt =>
                opt.setName('pool_id')
                    .setDescription(t('opt_pool_id_remove'))
                    .setRequired(false)))
    .addSubcommand(sub =>
        sub.setName('list')
            .setDescription(t('cmd_list')))
    .addSubcommand(sub =>
        sub.setName('refresh')
            .setDescription(t('cmd_refresh')));

// ─── add ──────────────────────────────────────────────────────────────────────

/**
 * Pick the AMM pool to track. Returns `{ pool }` on success, `{ error }` with
 * the message to show otherwise.
 */
async function resolvePool(tracker, { token, contract, quote, quoteContract, poolId }) {
    let candidates;
    try {
        // No quote filter: the full list doubles as a diagnostic when the
        // requested pair does not exist.
        candidates = await tracker.fetchPoolCandidates(token, contract);
    } catch (err) {
        log.error(`Could not read the Alcor pools: ${err.message}`);
        return { error: t('err_pools_unreadable') };
    }

    if (candidates.length === 0) {
        return { error: t('err_no_pool', token, contract, typeLabel(TOKEN_TYPE.STANDARD)) };
    }

    if (poolId !== null) {
        const pool = candidates.find(c => String(c.poolId) === String(poolId));
        return pool
            ? { pool }
            : { error: t('err_pool_id_mismatch', poolId, token, contract, describeCandidates(token, candidates)) };
    }

    const wanted = quote ?? 'WAX';
    const matching = candidates.filter(c =>
        c.quote === wanted && (!quoteContract || c.quoteContract === quoteContract)
    );

    if (matching.length === 0) {
        return { error: t('err_no_pair', token, wanted, describeCandidates(token, candidates)) };
    }

    // Several pools quote the same pair (different fee tiers): the choice
    // belongs to the admin, not to an implicit ranking that would display a
    // surprise price.
    if (matching.length > 1) {
        return { error: t('err_many_pools', matching.length, token, wanted, describeCandidates(token, matching)) };
    }

    return { pool: matching[0] };
}

async function handleAdd(interaction, tracker) {
    const token         = interaction.options.getString('token').toUpperCase().trim();
    const type          = interaction.options.getString('type') ?? TOKEN_TYPE.STANDARD;
    const contract      = interaction.options.getString('contract')?.toLowerCase().trim() || null;
    const quote         = interaction.options.getString('quote')?.toUpperCase().trim() || null;
    const quoteContract = interaction.options.getString('quote_contract')?.toLowerCase().trim() || null;
    const poolId        = interaction.options.getInteger('pool_id');
    const category      = interaction.options.getChannel('category');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const reply = (content) => interaction.editReply(truncate(content, MESSAGE_MAX));

    if (CONTRACT_TYPES.includes(type) && !contract) {
        return reply(t('err_contract_needed', typeLabel(type)));
    }

    // Picking a pool only makes sense on the AMM: the order book has a single
    // market per pair, and the other types read no pool.
    if (type !== TOKEN_TYPE.POOL && (quote || quoteContract || poolId !== null)) {
        return reply(t('err_pool_options', typeLabel(TOKEN_TYPE.POOL)));
    }

    let pool = null;
    if (type === TOKEN_TYPE.POOL) {
        const resolved = await resolvePool(tracker, { token, contract, quote, quoteContract, poolId });
        if (resolved.error) return reply(resolved.error);
        pool = resolved.pool;
    }

    const key = tracker.makeKey(interaction.guildId, token, contract, pool?.poolId ?? null);
    if (tracker.entries.has(key)) {
        return reply(t('err_duplicate', tracker.displayKey(key)));
    }

    // Resolving the price also validates that the token exists on chain.
    const price = await tracker.fetchInitialData(token, type, contract, pool);

    if (!price && pool) {
        return reply(t('err_pool_no_wax_usd', pool.poolId, token, formatTokenAmount(pool.price), pool.quote));
    }
    if (!price) {
        return reply(t('err_not_found', token, sourceLabel(type)));
    }

    const channelName = buildChannelName(token, type, price.price, price.waxUsd, '➡️', price.quote);

    let channel;
    try {
        channel = await interaction.guild.channels.create({
            name:   channelName,
            type:   ChannelType.GuildVoice,
            parent: category?.id ?? null,
            // Display-only channel: everyone can see it, nobody can join it.
            permissionOverwrites: [{
                id:   interaction.guild.roles.everyone,
                deny: [PermissionFlagsBits.Connect],
            }],
        });
    } catch (err) {
        log.error(`Channel creation failed in guild ${interaction.guildId}: ${err.message}`);
        return reply(t('err_channel_create'));
    }

    tracker.register({
        guildId:      interaction.guildId,
        token,
        type,
        contract,
        pool,
        channelId:    channel.id,
        lastPriceRef: type === TOKEN_TYPE.NATIVE ? price.waxUsd : price.price,
    });

    const poolLine = pool ? t('ok_pool_pinned', pool.poolId, token, pool.quote, formatFee(pool.fee)) : '';

    return reply(
        t('ok_added', channelName, typeLabel(type), config.tracker.updateIntervalMinutes) + poolLine
    );
}

// ─── remove ───────────────────────────────────────────────────────────────────

/**
 * Remove an entry and its voice channel. The channel may already be gone — an
 * orphan entry must stay removable, that is even the case that leads here.
 */
async function deleteTracking(interaction, tracker, key, entry) {
    try {
        const channel = await interaction.guild.channels.fetch(entry.channelId).catch(() => null);
        if (channel) await channel.delete(t('remove_reason', interaction.user.tag));
    } catch (err) {
        log.warn(`Could not delete channel ${entry.channelId}: ${err.message}`);
    }
    tracker.unregister(key);
}

async function handleRemove(interaction, tracker) {
    const token    = interaction.options.getString('token')?.toUpperCase().trim() || null;
    const contract = interaction.options.getString('contract')?.toLowerCase().trim() || null;
    const poolId   = interaction.options.getInteger('pool_id');

    // Deleting a channel goes through the Discord API: acknowledge first, or a
    // slow round-trip makes the interaction expire.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildEntries = tracker.listForGuild(interaction.guildId);
    if (guildEntries.length === 0) {
        return interaction.editReply(t('list_empty'));
    }

    const matching = tracker.match(interaction.guildId, { token, contract, poolId });

    if (matching.length === 0) {
        const list = guildEntries.map(([k]) => `• \`${tracker.displayKey(k)}\``).join('\n');
        return interaction.editReply(truncate(t('err_no_match', list), MESSAGE_MAX));
    }

    // One candidate, explicitly targeted: remove it straight away. With no
    // filter at all the command assumes nothing — even a single entry goes
    // through the menu, which then acts as a confirmation.
    const targeted = Boolean(token || contract || poolId !== null);

    if (matching.length === 1 && targeted) {
        const [key, entry] = matching[0];
        await deleteTracking(interaction, tracker, key, entry);
        return interaction.editReply(t('ok_removed', tracker.displayKey(key)));
    }

    // Several candidates: let the admin pick from a list.
    const shown = matching.slice(0, SELECT_MAX_OPTIONS);

    const menu = new StringSelectMenuBuilder()
        .setCustomId('crypto-tracker-remove')
        .setPlaceholder(t('remove_placeholder'))
        .addOptions(shown.map(([key, entry]) => ({
            label:       truncate(`${describePair(entry)} · ${typeLabel(entry.type)}`, SELECT_MAX_TEXT),
            description: truncate(describeChannel(interaction, entry), SELECT_MAX_TEXT),
            value:       key,
        })));

    const overflow = matching.length > shown.length
        ? t('remove_overflow', matching.length, shown.length)
        : '';

    const message = await interaction.editReply({
        content:    t('remove_prompt', matching.length) + overflow,
        components: [new ActionRowBuilder().addComponents(menu)],
    });

    let choice;
    try {
        choice = await message.awaitMessageComponent({
            componentType: ComponentType.StringSelect,
            time:          SELECT_TIMEOUT_MS,
            filter:        i => i.user.id === interaction.user.id,
        });
    } catch {
        // Timed out: the menu goes away, nothing is removed.
        return interaction.editReply({ content: t('remove_expired'), components: [] }).catch(() => null);
    }

    const key   = choice.values[0];
    const entry = tracker.entries.get(key);

    if (!entry || entry.guildId !== interaction.guildId) {
        return choice.update({ content: t('err_already_removed', tracker.displayKey(key)), components: [] });
    }

    // The menu disappears before the deletion: the admin sees right away that
    // the choice was taken, even if Discord is slow.
    await choice.update({ content: t('remove_pending', tracker.displayKey(key)), components: [] });

    await deleteTracking(interaction, tracker, key, entry);

    return interaction.editReply({ content: t('ok_removed', tracker.displayKey(key)), components: [] });
}

// ─── list / refresh ───────────────────────────────────────────────────────────

async function handleList(interaction, tracker) {
    const entries = tracker.listForGuild(interaction.guildId);

    if (entries.length === 0) {
        return interaction.reply({ content: t('list_empty'), flags: MessageFlags.Ephemeral });
    }

    // The key is shown as is: it is what tells two entries of the same token
    // apart.
    const lines = entries.map(([key, entry]) => {
        const mention  = interaction.guild.channels.cache.has(entry.channelId)
            ? `<#${entry.channelId}>`
            : t('channel_missing');
        const contract = entry.contract ? ` \`${entry.contract}\`` : '';
        return `• **${describePair(entry)}**${contract} ${typeLabel(entry.type)} — ${mention}\n` +
               `  \`${tracker.displayKey(key)}\``;
    });

    return interaction.reply({
        content: truncate(`${t('list_header', entries.length)}\n${lines.join('\n')}`, MESSAGE_MAX),
        flags:   MessageFlags.Ephemeral,
    });
}

async function handleRefresh(interaction, tracker) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const result = await tracker.updateAll();
        return interaction.editReply(
            result.skipped ? t('ok_refresh_skipped') : t('ok_refreshed', result.updated)
        );
    } catch (err) {
        log.error(`Manual refresh failed: ${err.message}`);
        return interaction.editReply(t('err_refresh_failed'));
    }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

module.exports = {
    data,
    async execute(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: t('err_guild_only'), flags: MessageFlags.Ephemeral });
        }

        const tracker = interaction.client.cryptoTracker;
        const sub     = interaction.options.getSubcommand();

        if (sub === 'add')     return handleAdd(interaction, tracker);
        if (sub === 'remove')  return handleRemove(interaction, tracker);
        if (sub === 'list')    return handleList(interaction, tracker);
        if (sub === 'refresh') return handleRefresh(interaction, tracker);
    },
};
