'use strict';

const { config } = require('./config');

const STRINGS = {
    en: {
        cmd_description:      'Manage WAX crypto price voice channels',
        cmd_add:              'Create a voice channel tracking a WAX token price',
        cmd_remove:           'Stop tracking a token and delete its voice channel',
        cmd_list:             'List the tokens tracked on this server',
        cmd_refresh:          'Refresh every tracked channel right now',
        opt_token:            'Token symbol (e.g. WAX, TLM, DEF)',
        opt_type:             'Token type — decides the display format (default: standard)',
        opt_contract:         'Token contract on WAX — required except for Native (e.g. alien.worlds)',
        opt_contract_remove:  'Contract, if several channels exist for this symbol',
        opt_category:         'Category the voice channel should be created in',
        type_standard:        'Standard  →  $ + WAX',
        type_stablecoin:      'Stablecoin  →  WAX only',
        type_native:          'Native  →  $ only',
        type_pool:            'AMM pool  →  $ + WAX',

        err_guild_only:       '❌ This command can only be used on a server.',
        err_contract_needed:  (type) => `❌ The \`contract\` option is required for the **${type}** type.\nExample: \`contract: alien.worlds\` for TLM, \`contract: defensetoken\` for DEF.`,
        err_duplicate:        (token) => `❌ \`${token}\` is already tracked on this server.`,
        err_not_found:        (token) => `❌ Token \`${token}\` was not found on Alcor (WAX).\nDouble-check the symbol and the contract on https://wax.alcor.exchange`,
        err_channel_create:   '❌ Could not create the voice channel. Check that the bot has the **Manage Channels** permission.',
        err_unknown_token:    (token) => `❌ \`${token}\` is not tracked on this server.`,
        err_ambiguous:        (token, keys) => `❌ Several entries exist for \`${token}\`:\n${keys}\nUse the \`contract\` option to pick one.`,
        err_refresh_failed:   '❌ Refresh failed, check the bot logs.',

        ok_added:             (name, type, minutes) => `✅ Channel **${name}** created!\n📊 Type: ${type} — refreshed every **${minutes} min**.`,
        ok_removed:           (token) => `✅ Tracking of \`${token}\` removed, voice channel deleted.`,
        ok_refreshed:         (count) => `✅ Refresh done — ${count} channel(s) renamed.`,
        ok_refresh_skipped:   '⏳ A refresh is already running or prices are unavailable, try again in a moment.',
        list_empty:           '📭 No token is tracked on this server yet.',
        list_header:          (count) => `📊 **Tracked tokens (${count}):**`,
        channel_missing:      '*(channel deleted)*',
    },

    fr: {
        cmd_description:      'Gère les salons vocaux de suivi de prix crypto WAX',
        cmd_add:              'Crée un salon vocal qui suit le prix d\'un token WAX',
        cmd_remove:           'Supprime le suivi d\'un token et son salon vocal',
        cmd_list:             'Liste les tokens suivis sur ce serveur',
        cmd_refresh:          'Met à jour tous les salons suivis immédiatement',
        opt_token:            'Symbole du token (ex: WAX, TLM, DEF)',
        opt_type:             'Type du token — détermine le format d\'affichage (défaut: standard)',
        opt_contract:         'Contrat WAX du token — requis sauf pour Natif (ex: alien.worlds)',
        opt_contract_remove:  'Contrat du token si plusieurs salons existent pour ce symbole',
        opt_category:         'Catégorie dans laquelle créer le salon vocal',
        type_standard:        'Standard  →  $ + WAX',
        type_stablecoin:      'Stablecoin  →  WAX uniquement',
        type_native:          'Natif  →  $ uniquement',
        type_pool:            'Pool AMM  →  $ + WAX',

        err_guild_only:       '❌ Cette commande ne fonctionne que sur un serveur.',
        err_contract_needed:  (type) => `❌ L'option \`contract\` est obligatoire pour le type **${type}**.\nExemple : \`contract: alien.worlds\` pour TLM, \`contract: defensetoken\` pour DEF.`,
        err_duplicate:        (token) => `❌ \`${token}\` est déjà suivi sur ce serveur.`,
        err_not_found:        (token) => `❌ Token \`${token}\` introuvable sur Alcor (WAX).\nVérifiez le symbole et le contrat sur https://wax.alcor.exchange`,
        err_channel_create:   '❌ Impossible de créer le salon vocal. Vérifiez que le bot a la permission **Gérer les salons**.',
        err_unknown_token:    (token) => `❌ \`${token}\` n'est pas suivi sur ce serveur.`,
        err_ambiguous:        (token, keys) => `❌ Plusieurs entrées existent pour \`${token}\` :\n${keys}\nPrécisez l'option \`contract\`.`,
        err_refresh_failed:   '❌ La mise à jour a échoué, consultez les logs du bot.',

        ok_added:             (name, type, minutes) => `✅ Salon **${name}** créé !\n📊 Type : ${type} — mise à jour toutes les **${minutes} min**.`,
        ok_removed:           (token) => `✅ Suivi de \`${token}\` supprimé et salon vocal retiré.`,
        ok_refreshed:         (count) => `✅ Mise à jour terminée — ${count} salon(s) renommé(s).`,
        ok_refresh_skipped:   '⏳ Une mise à jour est déjà en cours ou les prix sont indisponibles, réessayez dans un instant.',
        list_empty:           '📭 Aucun token n\'est suivi sur ce serveur.',
        list_header:          (count) => `📊 **Tokens suivis (${count}) :**`,
        channel_missing:      '*(salon supprimé)*',
    },
};

/**
 * Translate a key in the configured language, falling back to English.
 * Values may be plain strings or functions taking interpolation arguments.
 */
function t(key, ...args) {
    const value = STRINGS[config.lang]?.[key] ?? STRINGS.en[key];
    if (value === undefined) return key;
    return typeof value === 'function' ? value(...args) : value;
}

module.exports = { t };
