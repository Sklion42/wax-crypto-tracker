'use strict';

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    MessageFlags,
} = require('discord.js');

const { config } = require('../config');
const { t } = require('../i18n');
const { TOKEN_TYPE, POOL_BASED_TYPES, buildChannelName } = require('../cryptoTracker');
const log = require('../logger');

const TYPE_LABEL = {
    [TOKEN_TYPE.NATIVE]:     '🟡 Native',
    [TOKEN_TYPE.STABLECOIN]: '🟢 Stablecoin',
    [TOKEN_TYPE.STANDARD]:   '🔵 Standard',
    [TOKEN_TYPE.POOL]:       '🟣 AMM pool',
};

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
                    .setDescription(t('opt_token'))
                    .setRequired(true))
            .addStringOption(opt =>
                opt.setName('contract')
                    .setDescription(t('opt_contract_remove'))
                    .setRequired(false)))
    .addSubcommand(sub =>
        sub.setName('list')
            .setDescription(t('cmd_list')))
    .addSubcommand(sub =>
        sub.setName('refresh')
            .setDescription(t('cmd_refresh')));

// ─── Subcommand handlers ──────────────────────────────────────────────────────

async function handleAdd(interaction, tracker) {
    const token    = interaction.options.getString('token').toUpperCase().trim();
    const type     = interaction.options.getString('type') ?? TOKEN_TYPE.STANDARD;
    const contract = interaction.options.getString('contract')?.toLowerCase().trim() ?? null;
    const category = interaction.options.getChannel('category');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (POOL_BASED_TYPES.includes(type) && !contract) {
        return interaction.editReply(t('err_contract_needed', TYPE_LABEL[type]));
    }

    const key = tracker.makeKey(interaction.guildId, token, contract);
    if (tracker.entries.has(key)) {
        return interaction.editReply(t('err_duplicate', token));
    }

    // Resolving the price also validates that the token exists on chain.
    const price = await tracker.fetchInitialData(token, type, contract);
    if (!price) {
        return interaction.editReply(t('err_not_found', token));
    }

    const channelName = buildChannelName(token, type, price.priceInWax, price.waxUsd, '➡️');

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
        return interaction.editReply(t('err_channel_create'));
    }

    tracker.register({
        guildId:      interaction.guildId,
        token,
        type,
        contract,
        channelId:    channel.id,
        lastPriceRef: type === TOKEN_TYPE.NATIVE ? price.waxUsd : price.priceInWax,
    });

    return interaction.editReply(
        t('ok_added', channelName, TYPE_LABEL[type], config.tracker.updateIntervalMinutes)
    );
}

async function handleRemove(interaction, tracker) {
    const token    = interaction.options.getString('token').toUpperCase().trim();
    const contract = interaction.options.getString('contract')?.toLowerCase().trim() ?? null;

    const related = tracker.findRelatedKeys(interaction.guildId, token);
    if (related.length === 0) {
        return interaction.reply({
            content: t('err_unknown_token', token),
            flags:   MessageFlags.Ephemeral,
        });
    }

    // With no contract given and a single match, remove that one.
    let key = contract ? tracker.makeKey(interaction.guildId, token, contract) : related[0];
    if (!contract && related.length > 1) {
        const list = related.map(k => `• \`${k.split(':').slice(1).join(':')}\``).join('\n');
        return interaction.reply({
            content: t('err_ambiguous', token, list),
            flags:   MessageFlags.Ephemeral,
        });
    }

    const entry = tracker.entries.get(key);
    if (!entry) {
        return interaction.reply({
            content: t('err_unknown_token', token),
            flags:   MessageFlags.Ephemeral,
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const channel = await interaction.guild.channels.fetch(entry.channelId).catch(() => null);
        if (channel) await channel.delete(`Crypto tracking removed by ${interaction.user.tag}`);
    } catch (err) {
        log.warn(`Could not delete channel ${entry.channelId}: ${err.message}`);
    }

    tracker.unregister(key);
    return interaction.editReply(t('ok_removed', token));
}

async function handleList(interaction, tracker) {
    const entries = tracker.listForGuild(interaction.guildId);

    if (entries.length === 0) {
        return interaction.reply({ content: t('list_empty'), flags: MessageFlags.Ephemeral });
    }

    const lines = entries.map(([, entry]) => {
        const mention  = interaction.guild.channels.cache.has(entry.channelId)
            ? `<#${entry.channelId}>`
            : t('channel_missing');
        const contract = entry.contract ? ` \`${entry.contract}\`` : '';
        return `• **${entry.token}**${contract} ${TYPE_LABEL[entry.type] ?? '❓'} — ${mention}`;
    });

    return interaction.reply({
        content: `${t('list_header', entries.length)}\n${lines.join('\n')}`,
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
