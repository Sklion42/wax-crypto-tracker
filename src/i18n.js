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
        opt_token_remove:     'Token to remove — leave empty to pick from the list of tracked tokens',
        opt_type:             'Token type — decides where the price is read (default: standard)',
        opt_contract:         'Token contract on WAX — required except for Native (e.g. alien.worlds)',
        opt_contract_remove:  'Contract, if several channels exist for this symbol',
        opt_quote:            'AMM pool: quote token of the pool to track (default: WAX — e.g. TLM)',
        opt_quote_contract:   'AMM pool: contract of the quote token, if its symbol is ambiguous',
        opt_pool_id:          'AMM pool: Alcor pool id, when several pools quote the same pair',
        opt_pool_id_remove:   'Pool id, if several pools of the same token are tracked',
        opt_category:         'Category the voice channel should be created in',
        type_standard:        'Standard  →  Alcor order book  ($ + WAX)',
        type_stablecoin:      'Stablecoin  →  WAX only',
        type_native:          'Native  →  $ only',
        type_pool:            'AMM pool  →  Alcor swap  (price of the chosen pool)',

        label_native:         '🟡 Native',
        label_stablecoin:     '🟢 Stablecoin',
        label_standard:       '🔵 Order book',
        label_pool:           '🟣 AMM pool',
        source_standard:      'Alcor order book (`alcordexmain`)',
        source_pool:          'Alcor AMM pool (`swap.alcor`)',
        source_default:       'Alcor market',

        fee_unknown:          'fee ?',
        candidate_line:       (poolId, token, price, quote, quoteContract, fee, reserveToken, reserveQuote) =>
            `• \`pool_id: ${poolId}\` — **1 ${token} = ${price} ${quote}** ` +
            `(${quote} \`${quoteContract}\`, ${fee}, reserves ${reserveToken} ${token} / ${reserveQuote} ${quote})`,
        candidate_estimated:  ' ⚠️ price estimated from reserves, this pool exposes no current price',
        pool_not_pinned:      (token) => `${token} (pool not pinned)`,
        no_contract:          'no contract',

        err_guild_only:       '❌ This command can only be used on a server.',
        err_contract_needed:  (type) => `❌ The \`contract\` option is required for the **${type}** type.\nExample: \`contract: alien.worlds\` for TLM, \`contract: defensetoken\` for DEF.`,
        err_pool_options:     (type) => `❌ The \`quote\`, \`quote_contract\` and \`pool_id\` options only apply to the **${type}** type.`,
        err_pools_unreadable: '❌ Could not read the Alcor pools (WAX RPC unavailable). Try again.',
        err_no_pool:          (token, contract, standardLabel) => `❌ No AMM pool for \`${token}\` (\`${contract}\`) on \`swap.alcor\`.\nCheck the symbol and contract on https://wax.alcor.exchange — a token listed on the order book is added as **${standardLabel}**.`,
        err_pool_id_mismatch: (poolId, token, contract, list) => `❌ Pool \`${poolId}\` does not quote \`${token}\` (\`${contract}\`).\nAvailable pools:\n${list}`,
        err_no_pair:          (token, quote, list) => `❌ No \`${token}/${quote}\` pool on \`swap.alcor\`.\nAvailable pools for \`${token}\`:\n${list}\nRun the command again with \`quote:\` or \`pool_id:\`.`,
        err_many_pools:       (count, token, quote, list) => `⚠️ ${count} pools quote \`${token}/${quote}\` — say which one to track:\n${list}\nRun the command again with the \`pool_id:\` option.`,
        err_duplicate:        (key) => `❌ This tracking already exists: \`${key}\`.`,
        err_pool_no_wax_usd:  (poolId, token, price, quote) => `❌ Pool \`#${poolId}\` found (1 ${token} = ${price} ${quote}), but the WAX dollar price is unavailable (CoinGecko). Try again in a few minutes.`,
        err_not_found:        (token, source) => `❌ No price for \`${token}\` on the ${source}.\nCheck the symbol and contract on https://wax.alcor.exchange — and the type: a token listed on the order book is added as **Standard**, a token listed on the swap as **AMM pool**.`,
        err_channel_create:   '❌ Could not create the voice channel. Check that the bot has the **Manage Channels** permission.',
        err_no_match:         (list) => `❌ No tracking matches.\nTracked on this server:\n${list}`,
        err_already_removed:  (key) => `❌ Tracking \`${key}\` was already removed in the meantime.`,
        err_refresh_failed:   '❌ Refresh failed, check the bot logs.',

        ok_added:             (name, type, minutes) => `✅ Channel **${name}** created!\n📊 Type: ${type} — refreshed every **${minutes} min**.`,
        ok_pool_pinned:       (poolId, token, quote, fee) => `\n🔗 Pool \`#${poolId}\` — ${token}/${quote} (${fee}), pinned to this pool.`,
        ok_removed:           (key) => `✅ Tracking \`${key}\` removed, voice channel deleted.`,
        ok_refreshed:         (count) => `✅ Refresh done — ${count} channel(s) renamed.`,
        ok_refresh_skipped:   '⏳ A refresh is already running or prices are unavailable, try again in a moment.',

        remove_placeholder:   'Select the tracking to remove',
        remove_prompt:        (count) => `🗑️ ${count} tracking(s) match — which one should be removed?`,
        remove_overflow:      (count, shown) => `\n*(${count} trackings match, the first ${shown} are offered — narrow down with \`token:\`.)*`,
        remove_expired:       '⏱️ Selection expired, nothing was removed.',
        remove_pending:       (key) => `⏳ Removing \`${key}\`…`,
        remove_reason:        (user) => `Crypto tracking removed by ${user}`,

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
        opt_token_remove:     'Token à retirer — sans lui, la liste des suivis est proposée',
        opt_type:             'Type du token — détermine où le prix est lu (défaut: standard)',
        opt_contract:         'Contrat WAX du token — requis sauf pour Natif (ex: alien.worlds)',
        opt_contract_remove:  'Contrat du token si plusieurs salons existent pour ce symbole',
        opt_quote:            'Pool AMM : token de cotation du pool à suivre (défaut: WAX — ex: TLM)',
        opt_quote_contract:   'Pool AMM : contrat du token de cotation, si son symbole est ambigu',
        opt_pool_id:          'Pool AMM : identifiant du pool Alcor, quand plusieurs pools cotent la même paire',
        opt_pool_id_remove:   'Identifiant du pool si plusieurs pools du même token sont suivis',
        opt_category:         'Catégorie dans laquelle créer le salon vocal',
        type_standard:        'Standard  →  carnet d\'ordres Alcor  ($ + WAX)',
        type_stablecoin:      'Stablecoin  →  WAX uniquement',
        type_native:          'Natif  →  $ uniquement',
        type_pool:            'Pool AMM  →  swap Alcor  (prix du pool choisi)',

        label_native:         '🟡 Natif',
        label_stablecoin:     '🟢 Stablecoin',
        label_standard:       '🔵 Carnet d\'ordres',
        label_pool:           '🟣 Pool AMM',
        source_standard:      'carnet d\'ordres Alcor (`alcordexmain`)',
        source_pool:          'pool AMM Alcor (`swap.alcor`)',
        source_default:       'marché Alcor',

        fee_unknown:          'frais ?',
        candidate_line:       (poolId, token, price, quote, quoteContract, fee, reserveToken, reserveQuote) =>
            `• \`pool_id: ${poolId}\` — **1 ${token} = ${price} ${quote}** ` +
            `(${quote} \`${quoteContract}\`, ${fee}, réserves ${reserveToken} ${token} / ${reserveQuote} ${quote})`,
        candidate_estimated:  ' ⚠️ prix estimé depuis les réserves, ce pool n\'expose pas de prix courant',
        pool_not_pinned:      (token) => `${token} (pool non figé)`,
        no_contract:          'sans contrat',

        err_guild_only:       '❌ Cette commande ne fonctionne que sur un serveur.',
        err_contract_needed:  (type) => `❌ L'option \`contract\` est obligatoire pour le type **${type}**.\nExemple : \`contract: alien.worlds\` pour TLM, \`contract: defensetoken\` pour DEF.`,
        err_pool_options:     (type) => `❌ Les options \`quote\`, \`quote_contract\` et \`pool_id\` ne s'appliquent qu'au type **${type}**.`,
        err_pools_unreadable: '❌ Impossible de lire les pools Alcor (RPC WAX indisponible). Réessayez.',
        err_no_pool:          (token, contract, standardLabel) => `❌ Aucun pool AMM pour \`${token}\` (\`${contract}\`) sur \`swap.alcor\`.\nVérifiez le symbole et le contrat sur https://wax.alcor.exchange — un token coté au carnet d'ordres s'ajoute en **${standardLabel}**.`,
        err_pool_id_mismatch: (poolId, token, contract, list) => `❌ Le pool \`${poolId}\` ne cote pas \`${token}\` (\`${contract}\`).\nPools disponibles :\n${list}`,
        err_no_pair:          (token, quote, list) => `❌ Aucun pool \`${token}/${quote}\` sur \`swap.alcor\`.\nPools disponibles pour \`${token}\` :\n${list}\nRelancez avec \`quote:\` ou \`pool_id:\`.`,
        err_many_pools:       (count, token, quote, list) => `⚠️ ${count} pools cotent \`${token}/${quote}\` — précisez lequel suivre :\n${list}\nRelancez la commande avec l'option \`pool_id:\`.`,
        err_duplicate:        (key) => `❌ Ce suivi existe déjà : \`${key}\`.`,
        err_pool_no_wax_usd:  (poolId, token, price, quote) => `❌ Pool \`#${poolId}\` trouvé (1 ${token} = ${price} ${quote}), mais le prix du WAX en dollars est indisponible (CoinGecko). Réessayez dans quelques minutes.`,
        err_not_found:        (token, source) => `❌ Aucun prix pour \`${token}\` sur le ${source}.\nVérifiez le symbole et le contrat sur https://wax.alcor.exchange — et le type : un token coté au carnet d'ordres s'ajoute en **Standard**, un token coté sur le swap en **Pool AMM**.`,
        err_channel_create:   '❌ Impossible de créer le salon vocal. Vérifiez que le bot a la permission **Gérer les salons**.',
        err_no_match:         (list) => `❌ Aucun suivi ne correspond.\nSuivis sur ce serveur :\n${list}`,
        err_already_removed:  (key) => `❌ Le suivi \`${key}\` a déjà été supprimé entre-temps.`,
        err_refresh_failed:   '❌ La mise à jour a échoué, consultez les logs du bot.',

        ok_added:             (name, type, minutes) => `✅ Salon **${name}** créé !\n📊 Type : ${type} — mise à jour toutes les **${minutes} min**.`,
        ok_pool_pinned:       (poolId, token, quote, fee) => `\n🔗 Pool \`#${poolId}\` — ${token}/${quote} (${fee}), figé sur ce pool.`,
        ok_removed:           (key) => `✅ Suivi \`${key}\` supprimé et salon vocal retiré.`,
        ok_refreshed:         (count) => `✅ Mise à jour terminée — ${count} salon(s) renommé(s).`,
        ok_refresh_skipped:   '⏳ Une mise à jour est déjà en cours ou les prix sont indisponibles, réessayez dans un instant.',

        remove_placeholder:   'Sélectionnez le suivi à supprimer',
        remove_prompt:        (count) => `🗑️ ${count} suivi(s) correspondent — lequel supprimer ?`,
        remove_overflow:      (count, shown) => `\n*(${count} suivis correspondent, les ${shown} premiers sont proposés — affinez avec \`token:\`.)*`,
        remove_expired:       '⏱️ Sélection expirée, aucun suivi supprimé.',
        remove_pending:       (key) => `⏳ Suppression de \`${key}\`…`,
        remove_reason:        (user) => `Suivi crypto supprimé par ${user}`,

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

module.exports = { t, STRINGS };
