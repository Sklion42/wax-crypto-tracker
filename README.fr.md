# WAX Crypto Tracker — bot Discord

Un petit bot Discord autonome qui affiche **le prix en direct des tokens WAX dans le nom de salons vocaux**.

```
🔊 ↗️ WAX: $0.0412
🔊 ↘️ TLM: $0.0089 | 0.2160 WAX
🔊 ➡️ WAXUSDC: 24.2718 WAX
```

Les salons sont en lecture seule (personne ne peut s'y connecter), se mettent à jour tout seuls et affichent une flèche de tendance (↗️ / ↘️ / ➡️) par rapport à la mise à jour précédente.

Les prix viennent de **CoinGecko** pour WAX/USD et des **pools AMM d'Alcor** lus directement sur la chaîne WAX pour les autres tokens — aucune clé API ni compte nécessaire.

---

## Prérequis

- **Node.js 18 ou plus récent** ([nodejs.org](https://nodejs.org)) — vérifiez avec `node -v`
- Une application bot Discord (voir plus bas)
- N'importe quoi pour l'héberger : un PC allumé, un VPS, un Raspberry Pi, Railway/Fly.io…

## 1. Créer le bot Discord

1. Allez sur le [portail développeur Discord](https://discord.com/developers/applications) → **New Application**.
2. Onglet **Bot** → **Reset Token** → copiez le token (c'est votre `DISCORD_TOKEN`, à garder secret).
3. Onglet **General Information** → copiez l'**Application ID** (c'est votre `DISCORD_CLIENT_ID`).
4. Onglet **Installation** (ou **OAuth2 → URL Generator**), générez un lien d'invitation avec :
   - Scopes : `bot`, `applications.commands`
   - Permissions : **Gérer les salons**, **Voir les salons**
5. Ouvrez le lien et ajoutez le bot à votre serveur.

> Aucun intent privilégié (contenu des messages, membres, présence) n'est nécessaire — laissez-les désactivés.

## 2. Installation

```bash
git clone https://github.com/Sklion42/wax-crypto-tracker.git
cd wax-crypto-tracker
npm install
cp .env.example .env
```

(Pas de git ? Bouton vert **Code** → *Download ZIP*, décompressez, puis lancez les deux dernières commandes.)

Ouvrez `.env` et renseignez au minimum `DISCORD_TOKEN` et `DISCORD_CLIENT_ID`.

## 3. Lancement

```bash
npm start
```

Les commandes slash sont publiées automatiquement au démarrage. Si
`DISCORD_GUILD_ID` est renseigné elles apparaissent instantanément sur ce
serveur ; sinon elles sont enregistrées globalement et Discord peut mettre
jusqu'à une heure à les propager.

Pour le faire tourner en continu :

```bash
npm install -g pm2
pm2 start index.js --name wax-crypto-tracker
pm2 save
```

---

## Commandes

Tout se trouve sous `/crypto-tracker`, réservé par défaut aux membres ayant la
permission **Gérer les salons** (modifiable dans *Paramètres du serveur →
Intégrations → votre bot*).

| Commande | Effet |
|---|---|
| `/crypto-tracker add token:<SYMBOLE> [type] [contract] [category]` | Crée un salon vocal qui suit ce token |
| `/crypto-tracker remove token:<SYMBOLE> [contract]` | Arrête le suivi et supprime le salon |
| `/crypto-tracker list` | Liste les tokens suivis sur ce serveur |
| `/crypto-tracker refresh` | Force une mise à jour immédiate de tous les salons |

### Types de tokens

| Type | Affichage | Contrat requis ? | Pour quoi |
|---|---|---|---|
| `standard` *(défaut)* | `$0.0089 \| 0.2160 WAX` | oui | tout token ayant un pool TOKEN/WAX sur Alcor |
| `pool` | `$0.0089 \| 0.2160 WAX` | oui | même calcul, libellé séparé pour les tokens AMM/LP |
| `stablecoin` | `24.2718 WAX` | non | tokens indexés sur 1 $ (WAXUSDC…) — calculé en `1 / WAX` |
| `native` | `$0.0412` | non | le WAX lui-même, en dollars via CoinGecko |

### Exemples

```
/crypto-tracker add token:WAX type:native
/crypto-tracker add token:TLM type:standard contract:alien.worlds
/crypto-tracker add token:DEF type:standard contract:defensetoken
/crypto-tracker add token:WAXUSDC type:stablecoin
```

Le contrat est le compte WAX qui émet le token. On le trouve sur
[wax.alcor.exchange](https://wax.alcor.exchange), à côté du symbole sur la page
de la paire. Si `add` répond « token introuvable », c'est que le symbole ou le
contrat est faux, ou qu'aucun pool TOKEN/WAX n'existe pour ce token.

---

## Configuration

Tout se règle dans `.env` :

| Variable | Défaut | Description |
|---|---|---|
| `DISCORD_TOKEN` | — | **Requis.** Token du bot |
| `DISCORD_CLIENT_ID` | — | **Requis.** Application ID |
| `DISCORD_GUILD_ID` | *(vide)* | Enregistre les commandes sur un seul serveur (instantané). Laisser vide pour un bot partagé |
| `BOT_LANG` | `en` | `en` ou `fr` |
| `UPDATE_INTERVAL_MINUTES` | `10` | Fréquence de mise à jour. En dessous de 5, ramené à 5 |
| `COINGECKO_API_KEY` | *(vide)* | Clé demo optionnelle, évite les limites de l'API publique |
| `WAX_RPC_ENDPOINTS` | 5 nœuds publics | Liste d'endpoints séparés par des virgules, essayés dans l'ordre |
| `DATA_FILE` | `./data/tracked-channels.json` | Où sont enregistrés les salons suivis |

### Pourquoi 10 minutes et pas 1 ?

Discord n'autorise que **2 renommages de salon par tranche de 10 minutes, par
salon**. Aller plus vite n'échoue pas franchement : les requêtes s'empilent
silencieusement et les noms se figent. 10 minutes est le rythme sûr, 5 est le
plancher accepté par le bot.

---

## Partager le bot

Deux approches :

- **Un seul bot, plusieurs serveurs** — laissez `DISCORD_GUILD_ID` vide, gardez
  le bot allumé et distribuez votre lien d'invitation. Les salons suivis sont
  stockés par serveur, chacun gère sa propre liste.
- **Un bot par personne** — donnez le lien de ce dépôt (ou laissez les gens le
  forker). Chacun crée son application Discord et fait tourner sa copie. Rien
  n'est codé en dur pour un serveur précis.

Ne partagez jamais votre `.env`, il contient votre token. Seul `.env.example`
est destiné à être distribué.

---

## Dépannage

| Symptôme | Cause / solution |
|---|---|
| Les commandes n'apparaissent pas | L'enregistrement global prend jusqu'à 1 h. Renseignez `DISCORD_GUILD_ID`, ou réinvitez le bot avec le scope `applications.commands` |
| « Impossible de créer le salon vocal » | Le bot n'a pas **Gérer les salons**, ou le serveur atteint la limite de 500 salons |
| Les noms ne bougent plus | Limite de renommage Discord — augmentez `UPDATE_INTERVAL_MINUTES` |
| « Token introuvable sur Alcor » | Symbole/contrat erroné, ou aucun pool TOKEN/WAX pour ce token |
| `fetch is not defined` | Node.js antérieur à 18 — mettez à jour |
| Un salon supprimé à la main | L'entrée se retire automatiquement à la mise à jour suivante |

---

## Fonctionnement

```
index.js                  client Discord, routage des commandes, cycle de vie
src/config.js             lecture du .env, valeurs par défaut, garde-fous
src/registerCommands.js   chargement et publication des commandes
src/commands/             /crypto-tracker (add, remove, list, refresh)
src/cryptoTracker.js      boucle de mise à jour, nommage, persistance JSON
src/priceSources.js       CoinGecko (WAX/USD) + réserves des pools Alcor
src/waxRpc.js             appels RPC WAX avec bascule d'endpoint
src/i18n.js               textes EN / FR
```

Chaque cycle récupère WAX/USD une fois et parcourt la table `pools` d'Alcor une
fois, puis renomme les salons dont le prix a changé, espacés pour rester dans
les limites de Discord. Le prix en WAX est pris sur le pool TOKEN/WAX **le plus
profond**, pour qu'un pool quasi vide en double ne fausse pas l'affichage.

L'état tient dans un seul fichier JSON : un redémarrage reprend exactement où il
s'était arrêté. Sauvegardez `data/tracked-channels.json` si vous tenez aux
flèches de tendance.

## Licence

MIT — voir [LICENSE](LICENSE).
