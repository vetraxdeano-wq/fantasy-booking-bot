// ═══════════════════════════════════════════════════════════════════════════════
//  🎾  TENNIS MANAGER 2026 — Bot Discord
//      discord.js v14 — mono-fichier — Supabase Storage + Render
// ═══════════════════════════════════════════════════════════════════════════════
//
//  VARIABLES D'ENVIRONNEMENT REQUISES (.env / Render Dashboard) :
//    DISCORD_TOKEN        → token du bot Discord
//    CLIENT_ID            → application ID Discord
//    GUILD_ID             → ID de ton serveur Discord
//    SUPABASE_URL         → ex: https://xxxx.supabase.co
//    SUPABASE_KEY         → clé service_role (pas anon) de Supabase
//    SUPABASE_BUCKET      → nom du bucket Supabase Storage (ex: "saves")
//    SUPABASE_FILE        → nom du fichier dans le bucket (ex: "save.db")
//    ADMIN_PASSWORD       → mot de passe pour la page web d'upload (optionnel)
//
//  SETUP :
//    1. npm install
//    2. Configurer les env vars
//    3. node index.js --deploy   (une seule fois pour enregistrer les slash commands)
//    4. node index.js
//
//  WORKFLOW FIN DE SAISON :
//    → Push save.db sur ton repo GitHub privé
//    → GitHub Actions l'upload sur Supabase Storage
//    → Le bot recharge automatiquement au prochain démarrage Render
//    → Ou utilise /admin reload_db pour forcer le rechargement sans redémarrer
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
} = require('discord.js');
const Database = require('better-sqlite3');

// ─── Chemins ──────────────────────────────────────────────────────────────────
const TMP_DIR        = path.join('/tmp', 'tennis-bot');
const BOT_DB_PATH    = path.join(TMP_DIR, 'bot.db');    // ⚠️ éphémère sur Render → voir note ci-dessous
const SEASON_DB_PATH = path.join(TMP_DIR, 'season.db');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// NOTE Render : /tmp est éphémère mais survit aux redémarrages chauds.
// Pour bot.db (économie), utilise Render Disk ($1/mo) ou Supabase DB si tu
// veux une persistance totale. Pour l'instant bot.db est en /tmp — les coins
// survivront aux redémarrages normaux mais pas aux re-deploys.
// → Remplace BOT_DB_PATH par un chemin sur Render Disk si tu en as un.

// ══════════════════════════════════════════════════════════════════════════════
//  SUPABASE STORAGE — téléchargement du save.db
// ══════════════════════════════════════════════════════════════════════════════

function supabaseDownload() {
  return new Promise((resolve, reject) => {
    const { SUPABASE_URL, SUPABASE_KEY, SUPABASE_BUCKET, SUPABASE_FILE } = process.env;
    if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_BUCKET || !SUPABASE_FILE) {
      return reject(new Error('Variables Supabase manquantes (SUPABASE_URL, SUPABASE_KEY, SUPABASE_BUCKET, SUPABASE_FILE)'));
    }

    const url = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${SUPABASE_FILE}`;
    const lib = url.startsWith('https') ? https : http;

    const file = fs.createWriteStream(SEASON_DB_PATH);
    const req  = lib.get(url, {
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return supabaseDownload().then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(SEASON_DB_PATH, () => {});
        return reject(new Error(`Supabase HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });
    req.on('error', (e) => { fs.unlink(SEASON_DB_PATH, () => {}); reject(e); });
  });
}

// Télécharge le save.db au démarrage (non-bloquant)
let seasonDbReady = false;
supabaseDownload()
  .then(() => {
    seasonDbReady = true;
    console.log(`✅ save.db téléchargé depuis Supabase (${(fs.statSync(SEASON_DB_PATH).size / 1024 / 1024).toFixed(1)} Mo)`);
  })
  .catch((e) => {
    console.warn(`⚠️  Impossible de télécharger save.db : ${e.message}`);
    // Si un ancien fichier existe en /tmp (redémarrage chaud), on l'utilise
    if (fs.existsSync(SEASON_DB_PATH)) {
      seasonDbReady = true;
      console.log('ℹ️  Utilisation du save.db en cache /tmp');
    }
  });

// ══════════════════════════════════════════════════════════════════════════════
//  BASE DE DONNÉES LOCALE (économie)
// ══════════════════════════════════════════════════════════════════════════════
const botDb = new Database(BOT_DB_PATH);
botDb.exec(`
  CREATE TABLE IF NOT EXISTS players (
    discord_id   TEXT PRIMARY KEY,
    username     TEXT NOT NULL,
    ingame_name  TEXT NOT NULL,
    nationality  TEXT NOT NULL,
    playstyle    TEXT NOT NULL,
    tm_player_id INTEGER DEFAULT NULL,
    coins        INTEGER DEFAULT 500,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id  TEXT    NOT NULL,
    amount      INTEGER NOT NULL,
    reason      TEXT    NOT NULL,
    created_at  TEXT    DEFAULT (datetime('now'))
  );
`);

const db = {
  get:         (id)       => botDb.prepare('SELECT * FROM players WHERE discord_id=?').get(id),
  exists:      (id)       => !!db.get(id),
  nameTaken:   (name)     => !!botDb.prepare('SELECT 1 FROM players WHERE LOWER(ingame_name)=LOWER(?)').get(name),
  create:      (p)        => botDb.prepare(
    'INSERT INTO players (discord_id,username,ingame_name,nationality,playstyle) VALUES (?,?,?,?,?)'
  ).run(p.discordId, p.username, p.ingameName, p.nationality, p.playstyle),
  linkTm:      (id, tmId) => botDb.prepare('UPDATE players SET tm_player_id=? WHERE discord_id=?').run(tmId, id),
  addCoins:    (id, n, r) => {
    botDb.prepare('UPDATE players SET coins=coins+? WHERE discord_id=?').run(n, id);
    botDb.prepare('INSERT INTO transactions (discord_id,amount,reason) VALUES (?,?,?)').run(id, n, r ?? 'Gain');
  },
  removeCoins: (id, n, r) => {
    const p = db.get(id);
    if (!p || p.coins < n) return false;
    botDb.prepare('UPDATE players SET coins=coins-? WHERE discord_id=?').run(n, id);
    botDb.prepare('INSERT INTO transactions (discord_id,amount,reason) VALUES (?,?,?)').run(id, -n, r ?? 'Dépense');
    return true;
  },
  txHistory:   (id, lim=5) => botDb.prepare(
    'SELECT * FROM transactions WHERE discord_id=? ORDER BY created_at DESC LIMIT ?'
  ).all(id, lim),
};

// ══════════════════════════════════════════════════════════════════════════════
//  LECTURE DU SAVE.DB (Tennis Manager 2026)
// ══════════════════════════════════════════════════════════════════════════════

// ── Mappings TM2026 ──────────────────────────────────────────────────────────
const HAND_LABEL    = { 1: 'Droitier', 2: 'Gaucher' };
const BH_LABEL      = { 1: 'Revers 1 main', 2: 'Revers 2 mains' };
const SURFACE_LABEL = { 1: '🔶 Terre battue', 2: '🟩 Gazon', 3: '🔷 Dur', 4: '🏟️ Dur indoor' };
const ROUND_LABEL   = { '-1': '🏆 Vainqueur', '0': '🥈 Finaliste', '1': 'Demi-finale', '2': 'Quart de finale', '3': '8ème de finale', '4': '16ème de finale', '5': '32ème de finale', '6': '64ème de finale' };

// Attributs TM2026 → label affiché (groupés par catégorie)
const ATTR_GROUPS = {
  '🎾 Service': [
    ['ServePower',       'Puissance service'],
    ['ServeSpin',        'Spin service'],
    ['ServeConsistency', 'Consistance service'],
  ],
  '🎯 Fond de court': [
    ['Forehand',             'Coup droit'],
    ['ForehandConsistency',  'CD consistance'],
    ['Backhand',             'Revers'],
    ['BackhandConsistency',  'RV consistance'],
    ['Return',               'Retour'],
    ['Counter',              'Counter'],
    ['Topspin',              'Topspin'],
    ['Underspin',            'Slice'],
    ['Dropshot',             'Amorti'],
    ['Control',              'Contrôle'],
    ['Timing',               'Timing'],
  ],
  '🏃 Physique': [
    ['Speed',     'Vitesse'],
    ['Footwork',  'Déplacement'],
    ['Balance',   'Équilibre'],
    ['Agility',   'Agilité'],
    ['Fitness',   'Condition'],
    ['Stamina',   'Endurance'],
  ],
  '🧠 Mental': [
    ['Anticipation',   'Anticipation'],
    ['Focus',          'Concentration'],
    ['Composure',      'Sang-froid'],
    ['KillerInstinct', 'Instinct'],
    ['FightingSpirit', 'Combativité'],
    ['Tactical',       'Tactique'],
  ],
  '🏅 Autre': [
    ['Volley',  'Volée'],
    ['Double',  'Double'],
  ],
};

function openSaveDb() {
  if (!seasonDbReady || !fs.existsSync(SEASON_DB_PATH)) return null;
  try { return new Database(SEASON_DB_PATH, { readonly: true }); }
  catch (e) { console.error('Erreur ouverture save.db:', e.message); return null; }
}

function getTmPlayerData(tmPlayerId) {
  const s = openSaveDb();
  if (!s) return null;
  try {
    const p = s.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(tmPlayerId);
    if (!p) return null;

    const rank = s.prepare(
      'SELECT Rank, Points, NbTournamentPlayed FROM Ranking WHERE PlayerId=? AND Circuit=0 ORDER BY Date DESC LIMIT 1'
    ).get(tmPlayerId) ?? {};

    const race = s.prepare(
      'SELECT Rank AS RaceRank, Points AS RacePoints, Year FROM RaceRanking WHERE PlayerId=? AND Circuit=0 ORDER BY Year DESC LIMIT 1'
    ).get(tmPlayerId) ?? {};

    const stats = s.prepare(`
      SELECT
        SUM(MatchPlayed)              AS played,
        SUM(MatchWon)                 AS won,
        SUM(AcesCount)                AS aces,
        SUM(DoubleFaultsCount)        AS df,
        SUM(FirstServePointsWon)      AS fs1w,
        SUM(FirstServePointsPlayed)   AS fs1p,
        SUM(SecondServePointsWon)     AS fs2w,
        SUM(SecondServePointsPlayed)  AS fs2p,
        SUM(BreakPointsSaved)         AS bpSaved,
        SUM(SavingBreakPointsPlayed)  AS bpFaced,
        SUM(BreakPointsConverted)     AS bpConv,
        SUM(ConversionBreakPointsPlayed) AS bpOpp
      FROM TennisPlayerStatistics WHERE PlayerId=? AND Circuit=0
    `).get(tmPlayerId) ?? {};

    const surfStats = s.prepare(`
      SELECT Surface, SUM(MatchPlayed) AS p, SUM(MatchWon) AS w
      FROM TennisPlayerStatistics WHERE PlayerId=? AND Circuit=0 AND Surface > 0
      GROUP BY Surface ORDER BY Surface
    `).all(tmPlayerId);

    const titles = s.prepare(
      'SELECT COUNT(*) AS cnt FROM TournamentResult WHERE PlayerId=? AND RoundReached=-1'
    ).get(tmPlayerId)?.cnt ?? 0;

    const finals = s.prepare(
      'SELECT COUNT(*) AS cnt FROM TournamentResult WHERE PlayerId=? AND RoundReached=0'
    ).get(tmPlayerId)?.cnt ?? 0;

    const lastResults = s.prepare(`
      SELECT t.Name, tr.Year, tr.RoundReached, tr.MoneyWon
      FROM TournamentResult tr JOIN Tournament t ON t.Id=tr.TournamentId
      WHERE tr.PlayerId=?
      ORDER BY tr.Date DESC LIMIT 5
    `).all(tmPlayerId);

    const totalMoney = s.prepare(
      'SELECT SUM(MoneyWon) AS total FROM TournamentResult WHERE PlayerId=?'
    ).get(tmPlayerId)?.total ?? 0;

    // Injuries actives
    const injuries = s.prepare(
      'SELECT Zone, Type FROM Injury WHERE PlayerId=? AND IsActive=1'
    ).all(tmPlayerId);

    return { p, rank, race, stats, surfStats, titles, finals, lastResults, totalMoney, injuries };
  } catch (e) {
    console.error('Erreur lecture save.db:', e.message);
    return null;
  } finally {
    s.close();
  }
}

function searchTmPlayers(query) {
  const s = openSaveDb();
  if (!s) return [];
  try {
    return s.prepare(`
      SELECT Id, Firstname, Lastname, Country FROM TennisPlayer
      WHERE (Firstname LIKE ? OR Lastname LIKE ? OR (Firstname||' '||Lastname) LIKE ?)
      AND Retired=0 LIMIT 10
    `).all(`%${query}%`, `%${query}%`, `%${query}%`);
  } catch { return []; }
  finally { s.close(); }
}

function getSaveDbInfo() {
  const s = openSaveDb();
  if (!s) return null;
  try {
    const world    = s.prepare('SELECT CurrentTime FROM TennisWorld LIMIT 1').get();
    const mainP    = s.prepare('SELECT tp.Firstname, tp.Lastname FROM TeamPro tm JOIN TennisPlayer tp ON tp.Id=tm.PlayerId LIMIT 1').get();
    const nbActive = s.prepare('SELECT COUNT(*) AS c FROM TennisPlayer WHERE Retired=0').get()?.c ?? 0;
    const mods     = s.prepare('SELECT Name, ModVersion FROM Mods WHERE IsEnabled=1').all();
    return {
      date: world?.CurrentTime ? new Date(world.CurrentTime * 1000).toLocaleDateString('fr-FR') : '?',
      mainPlayer: mainP ? `${mainP.Firstname} ${mainP.Lastname}` : '?',
      nbActive,
      mods,
      size: fs.existsSync(SEASON_DB_PATH) ? (fs.statSync(SEASON_DB_PATH).size / 1024 / 1024).toFixed(1) : '?',
    };
  } catch { return null; }
  finally { s.close(); }
}

// ══════════════════════════════════════════════════════════════════════════════
//  UTILITAIRES
// ══════════════════════════════════════════════════════════════════════════════
const COLOR = { green: 0x2ECC71, red: 0xE74C3C, blue: 0x3498DB, gold: 0xF1C40F, tennis: 0x1A6B3C, purple: 0x9B59B6 };

const PLAYSTYLE_EMOJI = {
  'Attaquant de fond': '⚡', 'Défenseur de fond': '🛡️',
  'Serveur-Volleyeur': '🏹', 'Monteur au filet': '🔥', 'Tout-terrain': '🎯',
};

// Barre de progression /20 pour les attributs TM2026
function attrBar(v) {
  const val   = Math.round(v ?? 0);
  const stars = Math.round(val / 20 * 5);
  const bar   = '●'.repeat(stars) + '○'.repeat(5 - stars);
  return `${bar} **${val}**/20`;
}

// Barre maîtrise surface (valeur brute TM, multipliée x5 pour avoir /100)
function surfBar(v) {
  const pct    = Math.min(100, Math.round((v ?? 0) * 5));
  const filled = Math.round(pct / 10);
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${pct}%`;
}

function pct(a, b)  { return b > 0 ? `${Math.round((a ?? 0) / b * 100)}%` : '—'; }
function moneyFmt(n){ return n > 0 ? `$${Number(n).toLocaleString('fr-FR')}` : '$0'; }
function age(ts)    { return Math.floor((Date.now() / 1000 - ts) / (365.25 * 86400)); }

function ok(t, d)   { return new EmbedBuilder().setColor(COLOR.green).setTitle(`✅ ${t}`).setDescription(d).setTimestamp(); }
function err(d)     { return new EmbedBuilder().setColor(COLOR.red).setTitle('❌ Erreur').setDescription(d); }

// ══════════════════════════════════════════════════════════════════════════════
//  BUILDERS D'EMBEDS
// ══════════════════════════════════════════════════════════════════════════════

function buildProfileEmbed(player, tmData, avatarUrl) {
  const embed = new EmbedBuilder()
    .setColor(COLOR.tennis)
    .setTitle(`🎾 ${player.ingame_name}`)
    .setDescription(`${PLAYSTYLE_EMOJI[player.playstyle] ?? '🎾'} *${player.playstyle}*  •  🌍 ${player.nationality}`)
    .setThumbnail(avatarUrl)
    .addFields(
      { name: '💰 Coins',       value: `**${player.coins.toLocaleString()} 🪙**`, inline: true },
      { name: '📅 Inscrit le',  value: player.created_at.split(' ')[0],           inline: true },
      { name: '\u200B',         value: '\u200B',                                  inline: true },
    )
    .setFooter({ text: 'Tennis Manager 2026 — Simulation' })
    .setTimestamp();

  if (!tmData) {
    embed.addFields({ name: '📊 Stats TM2026', value: player.tm_player_id
      ? seasonDbReady
        ? '⚠️ Joueur TM introuvable dans le save.db actuel.'
        : '⏳ Save.db en cours de téléchargement...'
      : '🔗 Utilise `/link <nom>` pour associer ton joueur TM2026.'
    });
    return embed;
  }

  const { p, rank, race, stats, surfStats, titles, finals, lastResults, totalMoney, injuries } = tmData;

  // ── Identité TM ─────────────────────────────────────────────────────────────
  embed.addFields(
    { name: '─────── 👤 Joueur TM2026 ───────', value: '\u200B' },
    { name: '🆔 Nom',         value: `${p.Firstname} ${p.Lastname}`,         inline: true },
    { name: '🌍 Pays',        value: p.Country ?? '—',                        inline: true },
    { name: '🎂 Âge',         value: `${age(p.DateOfBirth)} ans`,             inline: true },
    { name: '🖐️ Main',        value: HAND_LABEL[p.Handedness] ?? '—',        inline: true },
    { name: '🎯 Revers',      value: BH_LABEL[p.BackhandStyle] ?? '—',        inline: true },
    { name: '⭐ Potentiel',   value: `${(p.Potential ?? 0).toFixed(1)}/20`,   inline: true },
    { name: '💪 Condition',   value: `${p.PhysicalCondition ?? '—'}/100`,     inline: true },
    { name: '❤️ Moral',      value: `${p.Morale ?? '—'}/100`,                inline: true },
    { name: '🌟 Notoriété',   value: `${(p.Fame ?? 0).toFixed(1)}/20`,        inline: true },
  );

  if (injuries?.length) {
    embed.addFields({ name: '🩹 Blessures actives', value: `${injuries.length} blessure(s) en cours`, inline: false });
  }

  // ── Classement ──────────────────────────────────────────────────────────────
  embed.addFields(
    { name: '─────── 📈 Classement ───────', value: '\u200B' },
    { name: '🏅 Rang ATP',     value: rank.Rank != null ? `**#${rank.Rank}**` : '—',        inline: true },
    { name: '🔢 Points ATP',   value: rank.Points != null ? `${rank.Points}` : '—',         inline: true },
    { name: '🏟️ Tournois',   value: rank.NbTournamentPlayed != null ? `${rank.NbTournamentPlayed}` : '—', inline: true },
    { name: '🏎️ Race rang',   value: race.RaceRank != null ? `**#${race.RaceRank}**` : '—', inline: true },
    { name: '🏎️ Race pts',    value: race.RacePoints != null ? `${race.RacePoints}` : '—',  inline: true },
    { name: '💵 Prize money', value: moneyFmt(totalMoney),                                   inline: true },
  );

  // ── Palmarès ────────────────────────────────────────────────────────────────
  embed.addFields(
    { name: '─────── 🏆 Palmarès ───────', value: '\u200B' },
    { name: '🏆 Titres',  value: `**${titles}**`,                                              inline: true },
    { name: '🥈 Finales', value: `**${finals}**`,                                              inline: true },
    { name: '📊 Bilan',   value: stats.played ? `**${stats.won}V** / ${(stats.played - stats.won)}D (${pct(stats.won, stats.played)})` : '—', inline: true },
  );

  // ── Stats match ─────────────────────────────────────────────────────────────
  if (stats.played) {
    embed.addFields(
      { name: '─────── 📊 Stats match ───────', value: '\u200B' },
      { name: '🎾 Aces',          value: `${stats.aces ?? 0}`,               inline: true },
      { name: '❌ Doubles f.',    value: `${stats.df ?? 0}`,                  inline: true },
      { name: '\u200B',           value: '\u200B',                            inline: true },
      { name: '💥 1er service',   value: pct(stats.fs1w, stats.fs1p),        inline: true },
      { name: '🔄 2ème service',  value: pct(stats.fs2w, stats.fs2p),        inline: true },
      { name: '\u200B',           value: '\u200B',                            inline: true },
      { name: '🛡️ BP sauvés',    value: pct(stats.bpSaved, stats.bpFaced),  inline: true },
      { name: '⚡ BP convertis',  value: pct(stats.bpConv, stats.bpOpp),     inline: true },
      { name: '\u200B',           value: '\u200B',                            inline: true },
    );
  }

  // ── Bilan par surface ────────────────────────────────────────────────────────
  if (surfStats.length) {
    const lines = surfStats.map(s =>
      `${SURFACE_LABEL[s.Surface] ?? `Surface ${s.Surface}`} : **${s.w}V/${s.p - s.w}D** (${pct(s.w, s.p)})`
    ).join('\n');
    embed.addFields({ name: '─────── 🌍 Bilan par surface ───────', value: lines });
  }

  // ── Maîtrise surface ────────────────────────────────────────────────────────
  embed.addFields(
    { name: '─────── 🏟️ Maîtrise surface ───────', value: '\u200B' },
    { name: '🔶 Terre battue', value: surfBar(p.ClaySurfaceMastering),      inline: true },
    { name: '🟩 Gazon',        value: surfBar(p.GrassSurfaceMastering),     inline: true },
    { name: '🔷 Dur',          value: surfBar(p.HardSurfaceMastering),      inline: true },
    { name: '🏟️ Dur indoor',  value: surfBar(p.HardIndoorSurfaceMastering), inline: true },
  );

  // ── Derniers résultats ───────────────────────────────────────────────────────
  if (lastResults.length) {
    const lines = lastResults.map(r =>
      `${ROUND_LABEL[String(r.RoundReached)] ?? `R${r.RoundReached}`} — **${r.Name}** (${r.Year})`
    ).join('\n');
    embed.addFields({ name: '─────── 📋 Derniers résultats ───────', value: lines });
  }

  return embed;
}

function buildAttributesEmbed(player, p, avatarUrl) {
  const embed = new EmbedBuilder()
    .setColor(COLOR.purple)
    .setTitle(`📋 Attributs — ${p.Firstname} ${p.Lastname}`)
    .setDescription(`Profil Discord : **${player.ingame_name}** | Potentiel : **${(p.Potential ?? 0).toFixed(1)}/20**`)
    .setThumbnail(avatarUrl)
    .setFooter({ text: 'Tennis Manager 2026 — Attributs' })
    .setTimestamp();

  // Calcul de la moyenne globale
  const allAttrs = Object.values(ATTR_GROUPS).flat().map(([key]) => p[key] ?? 0);
  const avg = (allAttrs.reduce((a, b) => a + b, 0) / allAttrs.length).toFixed(1);
  embed.addFields({ name: '⚖️ Moyenne globale', value: `**${avg}/20**` });

  for (const [groupName, attrs] of Object.entries(ATTR_GROUPS)) {
    const lines = attrs.map(([key, label]) => `\`${label.padEnd(20)}\` ${attrBar(p[key])}`).join('\n');
    embed.addFields({ name: groupName, value: lines, inline: false });
  }

  return embed;
}

function buildWalletEmbed(player, txs) {
  const embed = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle(`💰 Portefeuille — ${player.ingame_name}`)
    .addFields({ name: 'Solde actuel', value: `**${player.coins.toLocaleString()} 🪙**` });
  if (txs.length) {
    const lines = txs.map(t =>
      `${t.amount > 0 ? '📈' : '📉'} \`${t.amount > 0 ? '+' : ''}${t.amount}\` — ${t.reason} *(${t.created_at.split(' ')[0]})*`
    ).join('\n');
    embed.addFields({ name: '📋 Dernières transactions', value: lines });
  }
  return embed;
}

// ══════════════════════════════════════════════════════════════════════════════
//  DÉFINITION DES SLASH COMMANDS
// ══════════════════════════════════════════════════════════════════════════════
const COMMANDS_DATA = [

  new SlashCommandBuilder()
    .setName('inscription')
    .setDescription('Crée ton joueur dans la simulation TM2026')
    .addStringOption(o => o.setName('nom').setDescription('Nom de ton joueur').setRequired(true))
    .addStringOption(o => o.setName('nationalite').setDescription('Nationalité (ex: France)').setRequired(true))
    .addStringOption(o => o.setName('style').setDescription('Style de jeu').setRequired(true)
      .addChoices(
        { name: '⚡ Attaquant de fond',  value: 'Attaquant de fond'  },
        { name: '🛡️ Défenseur de fond', value: 'Défenseur de fond'  },
        { name: '🏹 Serveur-Volleyeur',  value: 'Serveur-Volleyeur'  },
        { name: '🔥 Monteur au filet',   value: 'Monteur au filet'   },
        { name: '🎯 Tout-terrain',       value: 'Tout-terrain'       },
      )),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Associe ton compte Discord à ton joueur dans TM2026')
    .addStringOption(o => o.setName('nom').setDescription('Prénom ou nom dans TM2026').setRequired(true)),

  new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Voir le profil complet et les stats d\'un joueur')
    .addUserOption(o => o.setName('joueur').setDescription('Joueur à consulter (toi par défaut)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('attributs')
    .setDescription('Voir tous les attributs TM2026 d\'un joueur')
    .addUserOption(o => o.setName('joueur').setDescription('Joueur à consulter (toi par défaut)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('coins')
    .setDescription('Voir ton solde de coins et tes dernières transactions'),

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Commandes admin')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s
      .setName('donner_coins')
      .setDescription('Donner des coins à un joueur')
      .addUserOption(o => o.setName('joueur').setDescription('Cible').setRequired(true))
      .addIntegerOption(o => o.setName('montant').setDescription('Montant').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false)))
    .addSubcommand(s => s
      .setName('retirer_coins')
      .setDescription('Retirer des coins à un joueur')
      .addUserOption(o => o.setName('joueur').setDescription('Cible').setRequired(true))
      .addIntegerOption(o => o.setName('montant').setDescription('Montant').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false)))
    .addSubcommand(s => s
      .setName('reload_db')
      .setDescription('Force le rechargement du save.db depuis Supabase'))
    .addSubcommand(s => s
      .setName('info_db')
      .setDescription('Infos sur le save.db actuellement chargé')),
];

// ══════════════════════════════════════════════════════════════════════════════
//  HANDLERS
// ══════════════════════════════════════════════════════════════════════════════
async function handleCommand(interaction) {
  const cmd = interaction.commandName;

  // ── /inscription ─────────────────────────────────────────────────────────────
  if (cmd === 'inscription') {
    if (db.exists(interaction.user.id))
      return interaction.reply({ embeds: [err('Tu as déjà un joueur ! Utilise `/profil`.')], ephemeral: true });

    const ingameName  = interaction.options.getString('nom').trim();
    const nationality = interaction.options.getString('nationalite').trim();
    const playstyle   = interaction.options.getString('style');

    if (db.nameTaken(ingameName))
      return interaction.reply({ embeds: [err(`Le nom **${ingameName}** est déjà pris.`)], ephemeral: true });
    if (ingameName.length < 2 || ingameName.length > 32)
      return interaction.reply({ embeds: [err('Le nom doit faire entre 2 et 32 caractères.')], ephemeral: true });

    db.create({ discordId: interaction.user.id, username: interaction.user.username, ingameName, nationality, playstyle });
    return interaction.reply({ embeds: [ok('Joueur créé !',
      `Bienvenue **${ingameName}** 🎾\n\n` +
      `🌍 **${nationality}** — ${PLAYSTYLE_EMOJI[playstyle] ?? ''} ${playstyle}\n` +
      `💰 Solde de départ : **500 🪙**\n\n` +
      `Utilise \`/link <nom>\` pour associer ton joueur TM2026 et afficher tes vraies stats !`
    )]});
  }

  // ── /link ─────────────────────────────────────────────────────────────────────
  if (cmd === 'link') {
    const player = db.get(interaction.user.id);
    if (!player)
      return interaction.reply({ embeds: [err('Crée d\'abord ton profil avec `/inscription`.')], ephemeral: true });

    if (!seasonDbReady)
      return interaction.reply({ embeds: [err('Save.db non disponible. Vérifie la configuration Supabase.')], ephemeral: true });

    const query   = interaction.options.getString('nom').trim();
    const results = searchTmPlayers(query);

    if (!results.length)
      return interaction.reply({ embeds: [err(`Aucun joueur trouvé pour **"${query}"** dans le save.db.`)], ephemeral: true });

    if (results.length === 1) {
      const tm = results[0];
      db.linkTm(interaction.user.id, tm.Id);
      return interaction.reply({ embeds: [ok('Joueur lié !',
        `**${player.ingame_name}** est maintenant lié à **${tm.Firstname} ${tm.Lastname}** (${tm.Country}).\n\nUtilise \`/profil\` pour voir tes stats complets !`
      )]});
    }

    const lines = results.map((tm, i) =>
      `\`${i + 1}.\` **${tm.Firstname} ${tm.Lastname}** (${tm.Country}) — ID \`${tm.Id}\``
    ).join('\n');
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(COLOR.blue)
        .setTitle('🔍 Plusieurs joueurs trouvés')
        .setDescription(`${lines}\n\nRefais \`/link\` avec le prénom + nom complet pour préciser.`)
    ], ephemeral: true });
  }

  // ── /profil ───────────────────────────────────────────────────────────────────
  if (cmd === 'profil') {
    const target = interaction.options.getUser('joueur') ?? interaction.user;
    const player = db.get(target.id);

    if (!player) {
      return interaction.reply({ embeds: [err(
        target.id === interaction.user.id
          ? 'Pas encore de joueur. Utilise `/inscription` !'
          : `**${target.username}** n'a pas de joueur.`
      )], ephemeral: true });
    }

    const tmData = player.tm_player_id ? getTmPlayerData(player.tm_player_id) : null;
    return interaction.reply({
      embeds: [buildProfileEmbed(player, tmData, target.displayAvatarURL({ dynamic: true }))]
    });
  }

  // ── /attributs ────────────────────────────────────────────────────────────────
  if (cmd === 'attributs') {
    const target = interaction.options.getUser('joueur') ?? interaction.user;
    const player = db.get(target.id);

    if (!player)
      return interaction.reply({ embeds: [err(target.id === interaction.user.id ? 'Pas encore de joueur. Utilise `/inscription` !' : `**${target.username}** n'a pas de joueur.`)], ephemeral: true });

    if (!player.tm_player_id)
      return interaction.reply({ embeds: [err('Aucun joueur TM2026 lié. Utilise `/link` d\'abord.')], ephemeral: true });

    if (!seasonDbReady)
      return interaction.reply({ embeds: [err('Save.db en cours de chargement, réessaie dans quelques secondes.')], ephemeral: true });

    const s = openSaveDb();
    if (!s) return interaction.reply({ embeds: [err('Save.db non disponible.')], ephemeral: true });

    let p;
    try { p = s.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(player.tm_player_id); }
    finally { s.close(); }

    if (!p) return interaction.reply({ embeds: [err('Joueur TM introuvable dans le save.db.')], ephemeral: true });

    return interaction.reply({
      embeds: [buildAttributesEmbed(player, p, target.displayAvatarURL({ dynamic: true }))]
    });
  }

  // ── /coins ────────────────────────────────────────────────────────────────────
  if (cmd === 'coins') {
    const player = db.get(interaction.user.id);
    if (!player)
      return interaction.reply({ embeds: [err('Pas encore de joueur. Utilise `/inscription` !')], ephemeral: true });
    return interaction.reply({
      embeds: [buildWalletEmbed(player, db.txHistory(interaction.user.id))],
      ephemeral: true,
    });
  }

  // ── /admin ────────────────────────────────────────────────────────────────────
  if (cmd === 'admin') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'donner_coins') {
      const target = interaction.options.getUser('joueur');
      const amount = interaction.options.getInteger('montant');
      const reason = interaction.options.getString('raison') ?? 'Don admin';
      if (!db.exists(target.id)) return interaction.reply({ embeds: [err('Joueur non inscrit.')], ephemeral: true });
      db.addCoins(target.id, amount, reason);
      return interaction.reply({ embeds: [ok('Coins ajoutés', `**+${amount} 🪙** → <@${target.id}>\n*${reason}*`)], ephemeral: true });
    }

    if (sub === 'retirer_coins') {
      const target = interaction.options.getUser('joueur');
      const amount = interaction.options.getInteger('montant');
      const reason = interaction.options.getString('raison') ?? 'Retrait admin';
      if (!db.exists(target.id)) return interaction.reply({ embeds: [err('Joueur non inscrit.')], ephemeral: true });
      if (!db.removeCoins(target.id, amount, reason)) return interaction.reply({ embeds: [err('Solde insuffisant.')], ephemeral: true });
      return interaction.reply({ embeds: [ok('Coins retirés', `**-${amount} 🪙** → <@${target.id}>\n*${reason}*`)], ephemeral: true });
    }

    if (sub === 'reload_db') {
      await interaction.deferReply({ ephemeral: true });
      seasonDbReady = false;
      try {
        await supabaseDownload();
        seasonDbReady = true;
        const info = getSaveDbInfo();
        return interaction.editReply({ embeds: [ok('Save.db rechargé !',
          info
            ? `📅 Date : **${info.date}** | 👤 **${info.mainPlayer}** | 📦 **${info.size} Mo**`
            : 'Rechargé avec succès.'
        )]});
      } catch (e) {
        return interaction.editReply({ embeds: [err(`Échec du rechargement : ${e.message}`)] });
      }
    }

    if (sub === 'info_db') {
      if (!seasonDbReady || !fs.existsSync(SEASON_DB_PATH))
        return interaction.reply({ embeds: [err('Save.db non disponible. Configure les variables Supabase.')], ephemeral: true });

      const info = getSaveDbInfo();
      if (!info) return interaction.reply({ embeds: [err('Impossible de lire les infos du save.db.')], ephemeral: true });

      const modLines = info.mods.length
        ? info.mods.map(m => `• ${m.Name} v${m.ModVersion}`).join('\n')
        : '*Aucun mod actif*';

      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(COLOR.blue)
          .setTitle('🗄️ Infos save.db')
          .addFields(
            { name: '📅 Date en jeu',    value: info.date,               inline: true },
            { name: '👤 Joueur principal', value: info.mainPlayer,       inline: true },
            { name: '👥 Joueurs actifs',  value: `${info.nbActive}`,     inline: true },
            { name: '📦 Taille',          value: `${info.size} Mo`,      inline: true },
            { name: '🔧 Mods actifs',     value: modLines },
          )
      ], ephemeral: true });
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  DÉPLOIEMENT & DÉMARRAGE
// ══════════════════════════════════════════════════════════════════════════════
async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  console.log('📡 Déploiement des slash commands...');
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: COMMANDS_DATA.map(c => c.toJSON()) }
  );
  console.log('✅ Commandes déployées !');
}

if (process.argv.includes('--deploy')) {
  deployCommands().catch(console.error);
} else {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', () => {
    console.log(`🎾 Bot connecté : ${client.user.tag}`);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleCommand(interaction);
    } catch (e) {
      console.error(`Erreur /${interaction.commandName}:`, e);
      const msg = { content: '❌ Une erreur est survenue.', ephemeral: true };
      if (interaction.replied || interaction.deferred) interaction.followUp(msg);
      else interaction.reply(msg);
    }
  });

  client.login(process.env.DISCORD_TOKEN);
}
