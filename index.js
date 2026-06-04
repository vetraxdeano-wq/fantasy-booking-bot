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
	//    R2_PUBLIC_URL        → Public Development URL du bucket R2 (ex: https://pub-xxxx.r2.dev)
	//    R2_FILE              → nom du fichier dans le bucket (ex: "save.db")
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
	  ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle,
	} = require('discord.js');
	const Database = require('better-sqlite3');
	const { createClient } = require('@supabase/supabase-js');

	// ─── Supabase client (pour bot.db persistant) ────────────────────────────────
	const supabase = createClient(
	  process.env.SUPABASE_URL,
	  process.env.SUPABASE_KEY
	);

	// ─── Serveur HTTP (Render Web Service) ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🎾 Tennis Bot — OK');
});
httpServer.listen(PORT, () => {
  console.log(`[HTTP] Serveur keep-alive lancé sur le port ${PORT}`);
});

// ─── Keep-alive (évite le sleep Render sur Web Service) ──────────────────────
// Render endort les Web Services gratuits après 15 min d'inactivité.
// Ce ping toutes les 10 min maintient le service éveillé.
const RENDER_URL = process.env.RENDER_EXTERNAL_URL; // injecté automatiquement par Render
function keepAlive() {
  if (!RENDER_URL) {
    console.log('[Keep-alive] RENDER_EXTERNAL_URL non défini — ping désactivé');
    return;
  }
  const url = RENDER_URL.startsWith('https') ? RENDER_URL : `https://${RENDER_URL}`;
  const lib = url.startsWith('https') ? https : http;
  lib.get(url, (res) => {
    console.log(`[Keep-alive] Ping → ${url} — HTTP ${res.statusCode}`);
  }).on('error', (e) => {
    console.warn(`[Keep-alive] Erreur ping : ${e.message}`);
  });
}
setInterval(keepAlive, 10 * 60 * 1000); // toutes les 10 min

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
	//  CLOUDFLARE R2 — téléchargement du save.db via URL publique
	//  Variables d'env requises :
	//    R2_PUBLIC_URL → https://pub-xxxx.r2.dev  (Public Development URL du bucket)
	//    R2_FILE       → nom du fichier (ex: save.db)
	// ══════════════════════════════════════════════════════════════════════════════

	async function r2Download() {
	  const { R2_PUBLIC_URL, R2_FILE } = process.env;
	  if (!R2_PUBLIC_URL || !R2_FILE) {
	    throw new Error('Variables R2 manquantes (R2_PUBLIC_URL, R2_FILE)');
	  }

	  const url = `${R2_PUBLIC_URL.replace(/\/+$/, '')}/${R2_FILE}`;
	  console.log(`[R2] Téléchargement public : ${url}`);

	  await new Promise((resolve, reject) => {
	    const file = fs.createWriteStream(SEASON_DB_PATH);
	    https.get(url, (res) => {
	      if (res.statusCode !== 200) {
	        fs.unlink(SEASON_DB_PATH, () => {});
	        return reject(new Error(`R2 : HTTP ${res.statusCode}`));
	      }
	      res.pipe(file);
	      file.on('finish', () => { file.close(); resolve(); });
	      file.on('error', (e) => { fs.unlink(SEASON_DB_PATH, () => {}); reject(e); });
	    }).on('error', (e) => { fs.unlink(SEASON_DB_PATH, () => {}); reject(e); });
	  });
	}

	// Télécharge le save.db au démarrage (non-bloquant)
	let seasonDbReady = false;
	console.log('[Boot] ═══════════════════════════════════════════════');
	console.log('[Boot] 🎾 Tennis Manager 2026 — démarrage...');
	console.log(`[Boot] DISCORD_TOKEN      : ${process.env.DISCORD_TOKEN       ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] CLIENT_ID          : ${process.env.CLIENT_ID           ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] GUILD_ID           : ${process.env.GUILD_ID            ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] SUPABASE_URL       : ${process.env.SUPABASE_URL        ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] SUPABASE_KEY       : ${process.env.SUPABASE_KEY        ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] R2_PUBLIC_URL      : ${process.env.R2_PUBLIC_URL        ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] R2_FILE            : ${process.env.R2_FILE             ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] RENDER_EXTERNAL_URL: ${process.env.RENDER_EXTERNAL_URL ?? '⚠️  non défini (keep-alive désactivé)'}`);
	console.log('[Boot] ═══════════════════════════════════════════════');
	console.log('[Boot] Téléchargement du save.db depuis Cloudflare R2...');
	r2Download()
	  .then(() => {
		seasonDbReady = true;
		console.log(`✅ save.db téléchargé depuis R2 (${(fs.statSync(SEASON_DB_PATH).size / 1024 / 1024).toFixed(1)} Mo)`);
	  })
	  .catch((e) => {
		console.warn(`⚠️  Impossible de télécharger save.db : ${e.message}`);
		if (fs.existsSync(SEASON_DB_PATH)) {
		  seasonDbReady = true;
		  console.log('ℹ️  Utilisation du save.db en cache /tmp');
		}
	  });

	// ══════════════════════════════════════════════════════════════════════════════
	//  BASE DE DONNÉES JOUEURS — Supabase (persistante, survive aux re-deploys)
	//  Tables requises dans Supabase :
	//    players(discord_id text PK, username text, ingame_name text,
	//            nationality text, playstyle text, tm_player_id int8,
	//            trait1 text, trait2 text, trait3 text,
	//            coins int8 default 500, created_at timestamptz default now())
	//    transactions(id bigserial PK, discord_id text, amount int8,
	//                 reason text, created_at timestamptz default now())
	// ══════════════════════════════════════════════════════════════════════════════

	const db = {
	  get: async (id) => {
		const { data } = await supabase.from('players').select('*').eq('discord_id', id).single();
		return data ?? null;
	  },
	  exists: async (id) => {
		const { data } = await supabase.from('players').select('discord_id').eq('discord_id', id).single();
		return !!data;
	  },
	  nameTaken: async (name) => {
		const { data } = await supabase.from('players').select('discord_id').ilike('ingame_name', name).single();
		return !!data;
	  },
	  create: async (p) => {
		await supabase.from('players').insert({
		  discord_id: p.discordId, username: p.username, ingame_name: p.ingameName,
		  nationality: p.nationality, playstyle: p.playstyle, coins: 500,
		  trait1: p.trait1 ?? null, trait2: p.trait2 ?? null, trait3: p.trait3 ?? null,
		  tac1: p.tac1 ?? null, tac2: p.tac2 ?? null, tac3: p.tac3 ?? null,
		});
	  },
	  delete: async (id) => {
		await supabase.from('transactions').delete().eq('discord_id', id);
		await supabase.from('players').delete().eq('discord_id', id);
	  },
	  linkTm: async (id, tmId) => {
		await supabase.from('players').update({ tm_player_id: tmId }).eq('discord_id', id);
	  },
	  setPhoto: async (id, url) => {
		await supabase.from('players').update({ character_photo: url }).eq('discord_id', id);
	  },
	  addCoins: async (id, n, r) => {
		const { data: p } = await supabase.from('players').select('coins').eq('discord_id', id).single();
		if (!p) return;
		await supabase.from('players').update({ coins: p.coins + n }).eq('discord_id', id);
		await supabase.from('transactions').insert({ discord_id: id, amount: n, reason: r ?? 'Gain' });
		// Déclencher l'auto-upgrade immédiatement si le joueur en a activé un
		// (fire-and-forget : pas d'await pour ne pas bloquer l'appelant)
		runAutoUpgrade(autoUpgradeLogChannel, id).catch(e =>
		  console.error('[AutoUpgrade] Erreur déclenchement réactif:', e.message)
		);
	  },
	  removeCoins: async (id, n, r) => {
		const { data: p } = await supabase.from('players').select('coins').eq('discord_id', id).single();
		if (!p || p.coins < n) return false;
		await supabase.from('players').update({ coins: p.coins - n }).eq('discord_id', id);
		await supabase.from('transactions').insert({ discord_id: id, amount: -n, reason: r ?? 'Dépense' });
		return true;
	  },
	  txHistory: async (id, lim = 5) => {
		const { data } = await supabase.from('transactions')
		  .select('*').eq('discord_id', id)
		  .order('created_at', { ascending: false }).limit(lim);
		return data ?? [];
	  },
	};

	// ── Barème de récompenses par résultat tournoi ──────────────────────────────
	// Clé = TournamentCategoryId (= tc.Type dans la DB)
	// RoundReached : -1=titre, 0=finale, 1=demi-finale
	const REWARD_TABLE = {
	  // catId : { [-1]: titre, [0]: finale, [1]: demi }
	  1:  { '-1': 1000, '0': 400,  '1': 150 }, // Grand Chelem
	  2:  { '-1': 600,  '0': 250,  '1': 80  }, // Masters 1000
	  3:  { '-1': 300,  '0': 100,  '1': 30  }, // ATP 500
	  5:  { '-1': 150,  '0': 50               }, // ATP 250
	  16: { '-1': 500,  '0': 200,  '1': 60  }, // Masters Cup / Next Gen
	};
	// Noms lisibles pour les notifications
	const REWARD_CAT_LABEL = { 1: 'Grand Chelem', 2: 'Masters 1000', 3: 'ATP 500', 5: 'ATP 250', 16: 'Masters Cup' };
	const REWARD_ROUND_LABEL = { '-1': '🏆 Titre', '0': '🥈 Finale', '1': '🥉 Demi-finale' };

	// Vérifie les nouveaux résultats depuis le dernier reload et distribue les coins
	// Stocke les résultats déjà récompensés dans Supabase (colonne rewarded_results jsonb)
	async function checkAndRewardResults(logChannel) {
	  if (!seasonDbReady) return;
	  const s = openSaveDb();
	  if (!s) return;

	  // Récupérer tous les joueurs linkés
	  const { data: players } = await supabase.from('players')
		.select('discord_id, tm_player_id, ingame_name, rewarded_results')
		.not('tm_player_id', 'is', null);
	  if (!players?.length) return;

	  const notifications = [];

	  for (const player of players) {
		const tmId = player.tm_player_id;
		// Résultats éligibles (titre/finale/demi dans catégories récompensées)
		const results = s.prepare(`
		  SELECT tr.TournamentId, tr.TournamentCategoryId, tr.Year, tr.RoundReached, t.Name
		  FROM TournamentResult tr
		  JOIN Tournament t ON t.Id = tr.TournamentId
		  WHERE tr.PlayerId = ?
		    AND tr.TournamentCategoryId IN (1,2,3,5,16)
		    AND tr.RoundReached IN (-1, 0, 1)
		  ORDER BY tr.Year ASC, tr.TournamentId ASC
		`).all(tmId);

		const already = new Set(player.rewarded_results ?? []);
		const newRewarded = [];
		let totalGain = 0;
		const lines = [];

		for (const r of results) {
		  const key = `\${r.TournamentId}-\${r.Year}-\${r.RoundReached}`;
		  if (already.has(key)) continue;
		  const effectiveCat = normalizeTournCat(r.TournamentCategoryId, r.Name);
		  const catRewards = REWARD_TABLE[effectiveCat];
		  if (!catRewards) continue;
		  const coins = catRewards[String(r.RoundReached)];
		  if (!coins) continue;

		  totalGain += coins;
		  newRewarded.push(key);
		  const catLabel   = REWARD_CAT_LABEL[effectiveCat] ?? '?';
		  const roundLabel = REWARD_ROUND_LABEL[String(r.RoundReached)] ?? '?';
		  lines.push(`\${roundLabel} \${r.Name} (\${r.Year}) [**\${catLabel}**] → **+\${coins} 🪙**`);
		}

		if (!newRewarded.length) continue;

		// Créditer + sauvegarder les clés récompensées
		await db.addCoins(player.discord_id, totalGain, `Récompenses tournois (reload)`);
		const allRewarded = [...already, ...newRewarded];
		await supabase.from('players').update({ rewarded_results: allRewarded }).eq('discord_id', player.discord_id);

		notifications.push({ discordId: player.discord_id, name: player.ingame_name, total: totalGain, lines });
	  }

	  // ── Récompenses classement final de saison ────────────────────────────────
	  // Barème : top 1→500 🪙, top 3→300, top 10→150, top 20→75, top 50→40, top 100→20
	  const RANK_REWARDS = [
		{ max: 0,   coins: 500, label: '🥇 #1 mondial' },
		{ max: 2,   coins: 300, label: '🥈 Top 3' },
		{ max: 9,   coins: 150, label: '🏅 Top 10' },
		{ max: 19,  coins: 75,  label: '🎯 Top 20' },
		{ max: 49,  coins: 40,  label: '📈 Top 50' },
		{ max: 99,  coins: 20,  label: '📊 Top 100' },
	  ];

	  // Pour chaque année disponible dans le classement final
	  const seasonDates = s.prepare(`
		SELECT strftime('%Y', Date, 'unixepoch') AS year, MAX(Date) AS maxDate
		FROM Ranking WHERE Circuit=0
		GROUP BY year ORDER BY year ASC
	  `).all();

	  for (const player of players) {
		const tmId   = player.tm_player_id;
		const already = new Set(player.rewarded_results ?? []);

		for (const { year, maxDate } of seasonDates) {
		  const rKey = `ranking-\${year}-\${player.discord_id}`;
		  if (already.has(rKey)) continue;

		  const row = s.prepare(`
			SELECT Rank FROM Ranking
			WHERE PlayerId=? AND Circuit=0 AND Date=?
		  `).get(tmId, maxDate);
		  if (!row) continue;

		  const tier = RANK_REWARDS.find(t => row.Rank <= t.max);
		  if (!tier) continue;

		  await db.addCoins(player.discord_id, tier.coins, `Classement final \${year} (\${tier.label})`);
		  await supabase.from('players')
			.update({ rewarded_results: [...already, rKey] })
			.eq('discord_id', player.discord_id);
		  already.add(rKey);

		  // Ajouter à la notification existante ou créer une nouvelle
		  let notif = notifications.find(n => n.discordId === player.discord_id);
		  if (!notif) {
			notif = { discordId: player.discord_id, name: player.ingame_name, total: 0, lines: [] };
			notifications.push(notif);
		  }
		  notif.total += tier.coins;
		  notif.lines.push(`\${tier.label} ATP \${year} → **+\${tier.coins} 🪙**`);
		}
	  }

	  // Poster les notifications dans le channel si fourni
	  if (logChannel && notifications.length) {
		for (const notif of notifications) {
		  const embed = new EmbedBuilder()
			.setColor(COLOR.gold)
			.setTitle(`🎾 Nouvelles récompenses — \${notif.name}`)
			.setDescription(notif.lines.join('\n'))
			.addFields({ name: '💰 Total crédité', value: `**+\${notif.total.toLocaleString()} 🪙**` })
			.setFooter({ text: 'Récompenses automatiques — reload save.db' })
			.setTimestamp();
		  try { await logChannel.send({ content: `<@\${notif.discordId}>`, embeds: [embed] }); }
		  catch (e) { console.error('[Rewards] Erreur envoi notif:', e.message); }
		}
	  }

	  return notifications;
	}

	// ══════════════════════════════════════════════════════════════════════════════
	//  LECTURE DU SAVE.DB (Tennis Manager 2026)
	// ══════════════════════════════════════════════════════════════════════════════

	// ── Mappings TM2026 ──────────────────────────────────────────────────────────
	const HAND_LABEL    = { 1: 'Droitier', 2: 'Gaucher' };
	const BH_LABEL      = { 1: 'Revers 1 main', 2: 'Revers 2 mains' };
	const SURFACE_LABEL = { 1: '🔶 Terre battue', 2: '🟩 Gazon', 3: '🔷 Dur', 4: '🏟️ Dur indoor' };
	const ROUND_LABEL   = { '-1': '🏆 Vainqueur', '0': '🥈 Finaliste', '1': '🥉 Demi-finale', '2': 'Quart de finale', '3': '8ème de finale', '4': '16ème de finale', '5': '32ème de finale', '6': '64ème de finale', '7': 'Qualif.', '8': 'Qualif.', '9': 'Qualif.' };

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

		const bestRankRow = s.prepare(
		  'SELECT MIN(Rank) AS BestRank FROM Ranking WHERE PlayerId=? AND Circuit=0'
		).get(tmPlayerId) ?? {};
		const bestRank = bestRankRow.BestRank != null ? bestRankRow.BestRank + 1 : null;

		// Rang Junior (Circuit=1)
		const rankJunior = s.prepare(
		  'SELECT Rank, Points FROM Ranking WHERE PlayerId=? AND Circuit=1 ORDER BY Date DESC LIMIT 1'
		).get(tmPlayerId) ?? null;
		const bestRankJuniorRow = rankJunior ? s.prepare(
		  'SELECT MIN(Rank) AS BestRank FROM Ranking WHERE PlayerId=? AND Circuit=1'
		).get(tmPlayerId) : null;
		const bestRankJunior = bestRankJuniorRow?.BestRank != null ? bestRankJuniorRow.BestRank + 1 : null;

		// Détection des catégories junior (JA, J1, J2, J3... + "junior" dans le nom)
		const juniorCatIds = getJuniorCategoryIds(s);
		const { clause: jExcl, ids: jIds } = buildJuniorExcludeClause(juniorCatIds);
		const { clause: jIncl, ids: jIdsIncl } = (() => {
		  const nameFilter = `(lower(t.Name) LIKE '%junior%'
			OR t.Name LIKE 'J %' OR t.Name LIKE 'J-%'
			OR t.Name GLOB 'J[0-9]*' OR t.Name GLOB 'J[A-Z]*')`;
		  if (juniorCatIds.size === 0) return { clause: nameFilter, ids: [] };
		  const ids = [...juniorCatIds];
		  const ph  = ids.map(() => '?').join(',');
		  return { clause: `(t.CategoryId IN (${ph}) OR ${nameFilter})`, ids };
		})();

		// Stats Junior — titres/finales depuis TournamentResult, bilan V/D depuis Match
		// (TennisPlayerStatistics Circuit=1 est souvent vide dans TM2026)
		const statsJuniorTitles = s.prepare(`
		  SELECT COUNT(*) AS cnt FROM TournamentResult tr2
		  JOIN Tournament t2 ON t2.Id = tr2.TournamentId
		  WHERE tr2.PlayerId=? AND tr2.RoundReached=-1
		    AND ${jIncl.replace(/\bt\b/g, 't2')}
		    AND t2.Name IS NOT NULL AND trim(t2.Name) != ''
		    AND lower(t2.Name) NOT LIKE '%estimated%'
		    AND lower(t2.Name) NOT LIKE '%unknown%'
		`).get(...[tmPlayerId, ...jIdsIncl])?.cnt ?? 0;

		const statsJuniorFinals = s.prepare(`
		  SELECT COUNT(*) AS cnt FROM TournamentResult tr3
		  JOIN Tournament t3 ON t3.Id = tr3.TournamentId
		  WHERE tr3.PlayerId=? AND tr3.RoundReached=0
		    AND ${jIncl.replace(/\bt\b/g, 't3')}
		    AND t3.Name IS NOT NULL AND trim(t3.Name) != ''
		    AND lower(t3.Name) NOT LIKE '%estimated%'
		    AND lower(t3.Name) NOT LIKE '%unknown%'
		`).get(...[tmPlayerId, ...jIdsIncl])?.cnt ?? 0;

		// Bilan V/D junior via TennisPlayerStatistics Circuit=1 (direct et fiable dans TM2026)
		const statsJuniorBilanRow = s.prepare(`
		  SELECT SUM(MatchPlayed) AS played, SUM(MatchWon) AS won
		  FROM TennisPlayerStatistics WHERE PlayerId=? AND Circuit=1
		`).get(tmPlayerId) ?? {};
		const statsJuniorBilan = {
		  played: statsJuniorBilanRow.played ?? 0,
		  won:    statsJuniorBilanRow.won ?? 0,
		};

		const statsJunior = {
		  titles: statsJuniorTitles,
		  finals: statsJuniorFinals,
		  played: statsJuniorBilan.played,
		  won:    statsJuniorBilan.won,
		};

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

		const titles = s.prepare(`
		  SELECT COUNT(*) AS cnt FROM TournamentResult tr
		  JOIN Tournament t ON t.Id = tr.TournamentId
		  WHERE tr.PlayerId=? AND tr.RoundReached=-1 AND ${jExcl}
		    AND t.Name IS NOT NULL AND trim(t.Name) != ''
		    AND lower(t.Name) NOT LIKE '%estimated%'
		    AND lower(t.Name) NOT LIKE '%unknown%'
		`).get(tmPlayerId, ...jIds)?.cnt ?? 0;

		const finals = s.prepare(`
		  SELECT COUNT(*) AS cnt FROM TournamentResult tr
		  JOIN Tournament t ON t.Id = tr.TournamentId
		  WHERE tr.PlayerId=? AND tr.RoundReached=0 AND ${jExcl}
		    AND t.Name IS NOT NULL AND trim(t.Name) != ''
		    AND lower(t.Name) NOT LIKE '%estimated%'
		    AND lower(t.Name) NOT LIKE '%unknown%'
		`).get(tmPlayerId, ...jIds)?.cnt ?? 0;

		// Sous-requête adversaire via table Match (Player1Id/Player2Id + Outcome)
		// ⚠️ On exclut les tournois juniors (même filtre que pour titles/finals)
		// Meilleurs résultats de la dernière saison, par catégorie de tournoi (GC > M1000 > ATP500 > ATP250...)
		// On prend la saison la plus récente avec des résultats, puis le meilleur résultat par catégorie.
		const lastSeasonRow = s.prepare(`
		  SELECT MAX(tr.Year) AS lastYear FROM TournamentResult tr
		  JOIN Tournament t ON t.Id = tr.TournamentId
		  WHERE tr.PlayerId = ? AND ${jExcl}
		`).get(tmPlayerId, ...jIds);
		const lastYear = lastSeasonRow?.lastYear ?? null;

		// Pour chaque catégorie, prend le meilleur résultat (RoundReached le plus bas = le plus loin)
		// RoundReached: -1=titre, 0=finale, 1=demi, 2=quart...
		const lastResultsRaw = lastYear ? s.prepare(`
		  SELECT t.Name, tc.Type AS Category, tr.Year, tr.RoundReached, tr.MoneyWon, tr.PointsMain,
		    (
		      SELECT tp2.Firstname || ' ' || tp2.Lastname
		      FROM Match m
		      JOIN TennisPlayer tp2 ON tp2.Id = CASE
		        WHEN m.Player1Id = tr.PlayerId THEN m.Player2Id
		        ELSE m.Player1Id
		      END
		      WHERE m.TournamentId = tr.TournamentId
		        AND m.Year = tr.Year
		        AND (m.Player1Id = tr.PlayerId OR m.Player2Id = tr.PlayerId)
		        AND m.Outcome IN (2, 3)
		      ORDER BY m.Date DESC LIMIT 1
		    ) AS OpponentName
		  FROM TournamentResult tr
		  JOIN Tournament t ON t.Id = tr.TournamentId
		  LEFT JOIN TournamentCategory tc ON tc.Id = t.CategoryId
		  WHERE tr.PlayerId = ? AND tr.Year = ? AND ${jExcl}
		  ORDER BY tc.Type ASC, tr.RoundReached ASC
		`).all(tmPlayerId, lastYear, ...jIds) : [];

		// Dédoublonner : un seul résultat par catégorie (le meilleur = RoundReached le plus bas)
		const seenCats = new Set();
		const lastResults = [];
		for (const r of lastResultsRaw) {
		  const cat = String(r.Category ?? 'other');
		  if (!seenCats.has(cat)) {
		    seenCats.add(cat);
		    lastResults.push(r);
		    if (lastResults.length >= 5) break;
		  }
		}

		// Détection dynamique du nom de la colonne gains (MoneyWon vs PrizeMoney vs Money selon version TM)
		const trCols = s.prepare('PRAGMA table_info(TournamentResult)').all().map(c => c.name);
		const moneyCol = trCols.find(c => /money/i.test(c)) ?? null;
		const totalMoney = moneyCol
		  ? (s.prepare(`SELECT SUM(${moneyCol}) AS total FROM TournamentResult WHERE PlayerId=?`).get(tmPlayerId)?.total ?? 0)
		  : 0;
		console.log(`[TmData] Colonnes TournamentResult contenant 'money': ${trCols.filter(c => /money/i.test(c)).join(', ')} — col utilisée: ${moneyCol} — total: ${totalMoney}`);

		// Injuries actives
		const injuries = s.prepare(
		  'SELECT Zone, Type FROM Injury WHERE PlayerId=? AND IsActive=1'
		).all(tmPlayerId);

		console.log(`[TmData] Joueur ${tmPlayerId} — titres ATP: ${titles}, finales ATP: ${finals}, juniorCatIds: [${[...juniorCatIds].join(',')}], jIds: [${jIds.join(',')}]`);

		return { p, rank, race, bestRank, rankJunior, bestRankJunior, statsJunior, stats, surfStats, titles, finals, lastResults, totalMoney, injuries };
	  } catch (e) {
		console.error('Erreur lecture save.db:', e.message);
		return null;
	  } finally {
		s.close();
	  }
	}

	// Forme récente : bilan sur les N derniers matchs + tendance
	function getTmForme(tmId, n = 20) {
	  const s = openSaveDb();
	  if (!s) return null;
	  try {
		const matches = s.prepare(`
		  SELECT m.Player1Id, m.Player2Id, m.Outcome, m.Date,
			t.Name AS TournName, tc.Type AS Category, m.Surface
		  FROM Match m
		  JOIN Tournament t ON t.Id = m.TournamentId
		  LEFT JOIN TournamentCategory tc ON tc.Id = m.TournamentCategoryId
		  WHERE (m.Player1Id=? OR m.Player2Id=?) AND m.Outcome IN (2, 3)
		  ORDER BY m.Date DESC LIMIT ?
		`).all(tmId, tmId, n);

		if (!matches.length) return null;

		// Outcome=2 → Player1 gagne ; Outcome=3 → Player2 gagne
		const isWin = (m) => (m.Player1Id === tmId && m.Outcome === 2) || (m.Player2Id === tmId && m.Outcome === 3);

		const wins = matches.filter(isWin).length;
		const losses = matches.length - wins;

		// Séquence des 5 derniers (pour tendance)
		const last5 = matches.slice(0, 5).map(m => isWin(m) ? '🟢' : '🔴').join('');

		// Série en cours
		let streak = 0;
		let streakType = null;
		for (const m of matches) {
		  const won = isWin(m);
		  if (streakType === null) streakType = won;
		  if (won === streakType) streak++;
		  else break;
		}

		return { total: matches.length, wins, losses, last5, streak, streakType };
	  } catch (e) { console.error('Forme error:', e.message); return null; }
	  finally { s.close(); }
	}

	// Rivalité principale : top 3 adversaires les plus fréquents
	function getTmRivalites(tmId) {
	  const s = openSaveDb();
	  if (!s) return [];
	  try {
		const rivals = s.prepare(`
		  SELECT
			opp.Id,
			opp.Firstname || ' ' || opp.Lastname AS Name,
			opp.Country,
			COUNT(*) AS total,
			SUM(CASE WHEN (m.Player1Id=? AND m.Outcome=2) OR (m.Player2Id=? AND m.Outcome=3) THEN 1 ELSE 0 END) AS wins,
			SUM(CASE WHEN (m.Player1Id=? AND m.Outcome=3) OR (m.Player2Id=? AND m.Outcome=2) THEN 1 ELSE 0 END) AS losses
		  FROM Match m
		  JOIN TennisPlayer opp ON opp.Id = CASE WHEN m.Player1Id=? THEN m.Player2Id ELSE m.Player1Id END
		  WHERE (m.Player1Id=? OR m.Player2Id=?) AND m.Outcome IN (2, 3)
		  GROUP BY opp.Id
		  ORDER BY total DESC LIMIT 3
		`).all(tmId, tmId, tmId, tmId, tmId, tmId, tmId);

		return rivals;
	  } catch (e) { console.error('Rivalites error:', e.message); return []; }
	  finally { s.close(); }
	}

	// Timeline carrière par année
	function getTmHistorique(tmId) {
	  const s = openSaveDb();
	  if (!s) return null;
	  try {
		const { sel: catSel, join: catJoin } = getTournCategoryJoin(s);

		// Titres par année
		const titlesPerYear = s.prepare(`
		  SELECT tr.Year, COUNT(*) AS cnt,
			GROUP_CONCAT(t.Name, '|') AS names
		  FROM TournamentResult tr
		  JOIN Tournament t ON t.Id = tr.TournamentId
		  WHERE tr.PlayerId=? AND tr.RoundReached=-1
		  GROUP BY tr.Year ORDER BY tr.Year
		`).all(tmId);

		// GC par année
		const gcPerYear = s.prepare(`
		  SELECT tr.Year, COUNT(*) AS cnt
		  FROM TournamentResult tr
		  JOIN Tournament t ON t.Id = tr.TournamentId
		  LEFT JOIN TournamentCategory tc ON tc.Id = t.CategoryId
		  WHERE tr.PlayerId=? AND tr.RoundReached=-1
			AND (tc.Type=1 OR (tc.Type=3 AND (
			  lower(t.Name) LIKE '%grand chelem%'
			)))
		  GROUP BY tr.Year
		`).all(tmId);

		// Meilleur classement par année
		const rankPerYear = s.prepare(`
		  SELECT strftime('%Y', Date, 'unixepoch') AS year,
			MIN(Rank)+1 AS bestRank,
			(SELECT Rank+1 FROM Ranking r2
			 WHERE r2.PlayerId=? AND r2.Circuit=0
			   AND strftime('%Y', r2.Date, 'unixepoch') = strftime('%Y', r.Date, 'unixepoch')
			 ORDER BY r2.Date DESC LIMIT 1) AS endRank
		  FROM Ranking r
		  WHERE PlayerId=? AND Circuit=0
		  GROUP BY year ORDER BY year
		`).all(tmId, tmId);

		// Bilan V/D par année
		const bilanPerYear = s.prepare(`
		  SELECT Year, SUM(MatchPlayed) AS played, SUM(MatchWon) AS won
		  FROM TennisPlayerStatistics
		  WHERE PlayerId=? AND Circuit=0
		  GROUP BY Year ORDER BY Year
		`).all(tmId);

		// Gains par année
		const gainsPerYear = s.prepare(`
		  SELECT Year, SUM(MoneyWon) AS total
		  FROM TournamentResult
		  WHERE PlayerId=?
		  GROUP BY Year ORDER BY Year
		`).all(tmId);

		// Assembler par année
		const years = new Set([
		  ...titlesPerYear.map(r => String(r.Year)),
		  ...rankPerYear.map(r => String(r.year)),
		  ...bilanPerYear.map(r => String(r.Year)),
		]);

		const timeline = [...years].sort().map(year => {
		  const t   = titlesPerYear.find(r => String(r.Year) === year);
		  const gc  = gcPerYear.find(r => String(r.Year) === year);
		  const rk  = rankPerYear.find(r => String(r.year) === year);
		  const bil = bilanPerYear.find(r => String(r.Year) === year);
		  const g   = gainsPerYear.find(r => String(r.Year) === year);
		  return {
			year,
			titles:    t?.cnt ?? 0,
			titleNames: t?.names ? t.names.split('|') : [],
			gcTitles:  gc?.cnt ?? 0,
			bestRank:  rk?.bestRank ?? null,
			endRank:   rk?.endRank ?? null,
			played:    bil?.played ?? 0,
			won:       bil?.won ?? 0,
			money:     g?.total ?? 0,
		  };
		});

		return timeline;
	  } catch (e) { console.error('Historique error:', e.message); return null; }
	  finally { s.close(); }
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

	// ── Catégories de tournois ───────────────────────────────────────────────────
	const TOURN_CAT = { 1: 'Grand Chelem', 2: 'Masters 1000', 3: 'ATP 500', 5: 'ATP 250', 6: 'ATP 125', 7: 'ATP 100', 8: 'ATP 75', 9: 'Challenger', 16: 'Masters Cup', 17: 'Next Gen Finals' };
	const TOURN_CAT_EMOJI = { 1: '🏆', 2: '🔥', 3: '🎯', 5: '🎾', 6: '🎾', 7: '🎾', 8: '🎾', 9: '🎾', 16: '👑', 17: '⭐' };
	const TOURN_CAT_IMPORTANT_MAX = 2; // GC (1) + Masters 1000 (2)
	const TOURN_CAT_SHORT = { 1: 'GC', 2: 'M1000', 3: 'ATP500', 5: 'ATP250', 6: 'ATP125', 7: 'ATP100', 8: 'ATP75', 9: 'Challenger', 16: 'Masters Cup', 17: 'Next Gen' };

	// Noms des Masters 1000 (stockés en catId=3 dans TM2026 mais à traiter comme catId=2)
	const MASTERS1000_NAMES = [
	  'indian wells', 'miami', 'monte-carlo', 'monte carlo', 'madrid', 'rome', 'roma',
	  'canada', 'montreal', 'toronto', 'cincinnati', 'shanghai', 'paris',
	];
	// Normalise la catégorie d'un tournoi : si catId=3 et nom = Masters 1000 → retourne 2
	function normalizeTournCat(rawCat, tournName) {
	  if (rawCat === 3 && tournName) {
		const lower = tournName.toLowerCase();
		if (MASTERS1000_NAMES.some(m => lower.includes(m))) return 2;
	  }
	  return rawCat;
	}

	// Déduit la catégorie d'un tournoi depuis les points obtenus par le vainqueur (PointsMain).
	// Barème ATP standard (points vainqueur) :
	//   Grand Chelem     → 2000 pts  (catId=1)
	//   Masters Cup      → 1500 pts  (catId=16)
	//   Masters 1000     → 1000 pts  (catId=2)
	//   ATP 500          →  500 pts  (catId=3)
	//   ATP 250          →  250 pts  (catId=5)
	//   ATP 125          →  125 pts  (catId=6)
	//   ATP 100          →  100 pts  (catId=7)
	//   ATP 75           →   75 pts  (catId=8)
	//   Challenger       →   80–125  (catId=9, chevauchement avec ATP 125)
	// On retourne la catégorie connue la plus proche si la catégorie brute est inconnue.
	function categFromPoints(rawCat, points, tournName) {
	  // Si la catégorie est déjà connue dans TOURN_CAT, on normalise juste par le nom
	  if (TOURN_CAT[rawCat]) return normalizeTournCat(rawCat, tournName);
	  // Catégorie inconnue : on déduit depuis les points du vainqueur
	  if (points == null || points <= 0) return rawCat; // pas d'info, on garde tel quel
	  if (points >= 1800) return 1;   // Grand Chelem
	  if (points >= 1400) return 16;  // Masters Cup
	  if (points >= 900)  return 2;   // Masters 1000
	  if (points >= 450)  return 3;   // ATP 500
	  if (points >= 220)  return 5;   // ATP 250
	  if (points >= 110)  return 6;   // ATP 125
	  if (points >= 85)   return 9;   // Challenger (ou ATP 100)
	  if (points >= 65)   return 8;   // ATP 75
	  return 9; // Challenger par défaut
	}

	// ── Économie & Shop ──────────────────────────────────────────────────────────
	// Boosts : +2 max par stat, plafond absolu 18
	const BOOST_MAX_PER_STAT = 2;
	const BOOST_ABS_CAP      = 18;
	// Coût pour passer d'une valeur v à v+1 (exponentiel : coûteux à haut niveau)
	// v=10→11: 200🪙 | v=14→15: 800🪙 | v=16→17: 1800🪙 | v=17→18: 3000🪙
	function boostCost(currentVal) {
	  if (currentVal >= BOOST_ABS_CAP) return Infinity;
	  return Math.round(50 * Math.pow(1.55, currentVal - 8));
	}
	// Liste des stats boostables (clé TM → label court)
	const BOOSTABLE_STATS = [
	  ['ServePower','Puissance service'],['ServeSpin','Spin service'],['ServeConsistency','Consistance service'],
	  ['Forehand','Coup droit'],['ForehandConsistency','CD consistance'],['Backhand','Revers'],['BackhandConsistency','RV consistance'],
	  ['Return','Retour'],['Counter','Counter'],['Topspin','Topspin'],['Underspin','Slice'],['Dropshot','Amorti'],
	  ['Control','Contrôle'],['Timing','Timing'],
	  ['Speed','Vitesse'],['Footwork','Déplacement'],['Balance','Équilibre'],['Agility','Agilité'],['Fitness','Condition'],['Stamina','Endurance'],
	  ['Anticipation','Anticipation'],['Focus','Concentration'],['Composure','Sang-froid'],['Tactical','Tactique'],
	  ['Volley','Volée'],
	];
	// Supabase helpers pour boosts
	const shopDb = {
	  getBoosts: async (discordId) => {
		const { data } = await supabase.from('players').select('boosts').eq('discord_id', discordId).single();
		return data?.boosts ?? {};
	  },
	  applyBoost: async (discordId, statKey, newBoosts) => {
		await supabase.from('players').update({ boosts: newBoosts }).eq('discord_id', discordId);
	  },
	};

	function getTmPlayerByName(query) {
	  const s = openSaveDb();
	  if (!s) return [];
	  try {
		return s.prepare(`
		  SELECT Id, Firstname, Lastname, Country FROM TennisPlayer
		  WHERE (Firstname LIKE ? OR Lastname LIKE ? OR (Firstname||' '||Lastname) LIKE ?)
		  LIMIT 10
		`).all(`%${query}%`, `%${query}%`, `%${query}%`);
	  } catch { return []; }
	  finally { s.close(); }
	}

	// Stats complètes d'un joueur TM par son Id (sans compte Discord)
	function getTmPlayerFullStats(tmId) {
	  return getTmPlayerData(tmId); // réutilise la fonction existante
	}

	// Head 2 Head entre deux joueurs TM
	function getH2H(id1, id2) {
	  const s = openSaveDb();
	  if (!s) return null;
	  try {
		// Outcome=2 → Player1 gagne ; Outcome=3 → Player2 gagne
		const wins1 = s.prepare(`
		  SELECT COUNT(*) AS cnt FROM Match
		  WHERE ((Player1Id=? AND Player2Id=? AND Outcome=2) OR (Player1Id=? AND Player2Id=? AND Outcome=3))
		`).get(id1, id2, id2, id1)?.cnt ?? 0;

		const wins2 = s.prepare(`
		  SELECT COUNT(*) AS cnt FROM Match
		  WHERE ((Player1Id=? AND Player2Id=? AND Outcome=3) OR (Player1Id=? AND Player2Id=? AND Outcome=2))
		`).get(id1, id2, id2, id1)?.cnt ?? 0;

		const meetings = s.prepare(`
		  SELECT m.*, t.Name AS TournName, tc.Type AS Category
		  FROM Match m
		  JOIN Tournament t ON t.Id = m.TournamentId
		  LEFT JOIN TournamentCategory tc ON tc.Id = m.TournamentCategoryId
		  WHERE ((m.Player1Id=? AND m.Player2Id=?) OR (m.Player1Id=? AND m.Player2Id=?))
		    AND m.Outcome IN (2, 3)
		  ORDER BY m.Date DESC LIMIT 10
		`).all(id1, id2, id2, id1);

		const surfH2H = s.prepare(`
		  SELECT m.Surface,
		    SUM(CASE WHEN (m.Player1Id=? AND m.Outcome=2) OR (m.Player2Id=? AND m.Outcome=3) THEN 1 ELSE 0 END) AS w1,
		    SUM(CASE WHEN (m.Player1Id=? AND m.Outcome=3) OR (m.Player2Id=? AND m.Outcome=2) THEN 1 ELSE 0 END) AS w2,
		    COUNT(*) AS total
		  FROM Match m
		  WHERE ((m.Player1Id=? AND m.Player2Id=?) OR (m.Player1Id=? AND m.Player2Id=?))
		    AND m.Outcome IN (2, 3)
		  GROUP BY m.Surface
		`).all(id1, id1, id1, id1, id1, id2, id2, id1);

		return { wins1, wins2, meetings, surfH2H };
	  } catch (e) { console.error('H2H error:', e.message); return null; }
	  finally { s.close(); }
	}

	// Stats TM brutes d'un joueur pour la comparaison dans /h2h
	function getTmRawStats(tmId) {
	  const s = openSaveDb();
	  if (!s) return null;
	  try {
		return s.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(tmId) ?? null;
	  } catch { return null; }
	  finally { s.close(); }
	}

	// ══════════════════════════════════════════════════════════════════════════════
	//  POWER RANKING — Classement des joueurs de la simulation
	// ══════════════════════════════════════════════════════════════════════════════

	/**
	 * Construit le Power Ranking des joueurs de la simulation.
	 * Récupère tous les players Supabase ayant un tm_player_id,
	 * puis lit leurs stats dans le save.db pour calculer un score composite.
	 *
	 * Critères pondérés :
	 *   Titre Junior ×5 · Finale Junior ×2
	 *   Titre ATP ×8   · Finale ATP ×3   · GC ×15
	 *   Best Rank ATP → 200-rank pts     · Rank actuel → 150-rank pts
	 *   Prize money / 50 000 (max 300)   · +Win Rate %
	 */
	async function getPowerRankingData() {
	  if (!seasonDbReady) return null;
	  const s = openSaveDb();
	  if (!s) return null;

	  try {
	    const { data: simuPlayers } = await supabase
	      .from('players')
	      .select('discord_id, ingame_name, tm_player_id, character_photo')
	      .not('tm_player_id', 'is', null);

	    if (!simuPlayers?.length) return [];

	    const juniorCatIds = getJuniorCategoryIds(s);
	    const { clause: jExcl, ids: jIds } = buildJuniorExcludeClause(juniorCatIds);
	    const { clause: jIncl, ids: jIdsIncl } = (() => {
	      const nameFilter = `(lower(t.Name) LIKE '%junior%'
	        OR t.Name LIKE 'J %' OR t.Name LIKE 'J-%'
	        OR t.Name GLOB 'J[0-9]*' OR t.Name GLOB 'J[A-Z]*')`;
	      if (juniorCatIds.size === 0) return { clause: nameFilter, ids: [] };
	      const ids = [...juniorCatIds];
	      const ph  = ids.map(() => '?').join(',');
	      return { clause: `(t.CategoryId IN (${ph}) OR ${nameFilter})`, ids };
	    })();

	    // Colonne prize money (détection dynamique)
	    const trCols   = s.prepare('PRAGMA table_info(TournamentResult)').all().map(c => c.name);
	    const moneyCol = trCols.find(c => /money/i.test(c)) ?? null;

	    const ranking = [];

	    for (const sp of simuPlayers) {
	      const tmId = sp.tm_player_id;

	      const pRow = s.prepare('SELECT Firstname, Lastname, Country, DateOfBirth FROM TennisPlayer WHERE Id=?').get(tmId);
	      if (!pRow) continue;

	      // Classement ATP actuel
	      const rankRow = s.prepare(
	        'SELECT Rank, Points FROM Ranking WHERE PlayerId=? AND Circuit=0 ORDER BY Date DESC LIMIT 1'
	      ).get(tmId) ?? {};
	      const currentRankATP = rankRow.Rank != null ? rankRow.Rank + 1 : null;
	      const currentPoints  = rankRow.Points ?? 0;

	      // Meilleur ranking ATP carrière
	      const bestRankRow = s.prepare(
	        'SELECT MIN(Rank) AS best FROM Ranking WHERE PlayerId=? AND Circuit=0'
	      ).get(tmId) ?? {};
	      const bestRankATP = bestRankRow.best != null ? bestRankRow.best + 1 : null;

	      // Meilleur ranking Junior
	      const bestRankJuniorRow = s.prepare(
	        'SELECT MIN(Rank) AS best FROM Ranking WHERE PlayerId=? AND Circuit=1'
	      ).get(tmId) ?? {};
	      const bestRankJunior = bestRankJuniorRow.best != null ? bestRankJuniorRow.best + 1 : null;

	      // Titres & finales ATP (hors junior)
	      const titlesATP = s.prepare(`
	        SELECT COUNT(*) AS cnt FROM TournamentResult tr
	        JOIN Tournament t ON t.Id = tr.TournamentId
	        WHERE tr.PlayerId=? AND tr.RoundReached=-1 AND ${jExcl}
	          AND t.Name IS NOT NULL AND trim(t.Name) != ''
	          AND lower(t.Name) NOT LIKE '%estimated%'
	          AND lower(t.Name) NOT LIKE '%unknown%'
	      `).get(tmId, ...jIds)?.cnt ?? 0;

	      const finalsATP = s.prepare(`
	        SELECT COUNT(*) AS cnt FROM TournamentResult tr
	        JOIN Tournament t ON t.Id = tr.TournamentId
	        WHERE tr.PlayerId=? AND tr.RoundReached=0 AND ${jExcl}
	          AND t.Name IS NOT NULL AND trim(t.Name) != ''
	          AND lower(t.Name) NOT LIKE '%estimated%'
	          AND lower(t.Name) NOT LIKE '%unknown%'
	      `).get(tmId, ...jIds)?.cnt ?? 0;

	      // Titres & finales Junior
	      const titlesJunior = s.prepare(`
	        SELECT COUNT(*) AS cnt FROM TournamentResult tr2
	        JOIN Tournament t2 ON t2.Id = tr2.TournamentId
	        WHERE tr2.PlayerId=? AND tr2.RoundReached=-1
	          AND ${jIncl.replace(/\bt\b/g, 't2')}
	          AND t2.Name IS NOT NULL AND trim(t2.Name) != ''
	          AND lower(t2.Name) NOT LIKE '%estimated%'
	          AND lower(t2.Name) NOT LIKE '%unknown%'
	      `).get(tmId, ...jIdsIncl)?.cnt ?? 0;

	      const finalsJunior = s.prepare(`
	        SELECT COUNT(*) AS cnt FROM TournamentResult tr3
	        JOIN Tournament t3 ON t3.Id = tr3.TournamentId
	        WHERE tr3.PlayerId=? AND tr3.RoundReached=0
	          AND ${jIncl.replace(/\bt\b/g, 't3')}
	          AND t3.Name IS NOT NULL AND trim(t3.Name) != ''
	          AND lower(t3.Name) NOT LIKE '%estimated%'
	          AND lower(t3.Name) NOT LIKE '%unknown%'
	      `).get(tmId, ...jIdsIncl)?.cnt ?? 0;

	      // Bilan V/D ATP
	      const statsRow = s.prepare(`
	        SELECT SUM(MatchPlayed) AS played, SUM(MatchWon) AS won
	        FROM TennisPlayerStatistics WHERE PlayerId=? AND Circuit=0
	      `).get(tmId) ?? {};
	      const matchPlayed = statsRow.played ?? 0;
	      const matchWon    = statsRow.won ?? 0;
	      const winRate     = matchPlayed > 0 ? (matchWon / matchPlayed) * 100 : 0;

	      // Prize money total
	      const totalMoney = moneyCol
	        ? (s.prepare(`SELECT SUM(${moneyCol}) AS total FROM TournamentResult WHERE PlayerId=?`).get(tmId)?.total ?? 0)
	        : 0;

	      // Grand Chelems ATP
	      const gcTitles = s.prepare(`
	        SELECT COUNT(*) AS cnt FROM TournamentResult tr
	        JOIN Tournament t ON t.Id = tr.TournamentId
	        LEFT JOIN TournamentCategory tc ON tc.Id = t.CategoryId
	        WHERE tr.PlayerId=? AND tr.RoundReached=-1
	          AND (tc.Type=1 OR (tc.Type IS NULL AND (
	            lower(t.Name) LIKE '%grand chelem%'
	            OR lower(t.Name) LIKE '%australian open%'
	            OR lower(t.Name) LIKE '%roland garros%'
	            OR lower(t.Name) LIKE '%wimbledon%'
	            OR lower(t.Name) LIKE '%us open%'
	          )))
	          AND ${jExcl}
	      `).get(tmId, ...jIds)?.cnt ?? 0;

	      // Score composite
	      const scoreJuniorTitles  = titlesJunior * 5;
	      const scoreJuniorFinals  = finalsJunior * 2;
	      const scoreATPTitles     = titlesATP * 8;
	      const scoreATPFinals     = finalsATP * 3;
	      const scoreGC            = gcTitles * 15;
	      const scoreBestRank      = bestRankATP    != null ? Math.max(0, 200 - bestRankATP)    : 0;
	      const scoreCurrentRank   = currentRankATP != null ? Math.max(0, 150 - currentRankATP) : 0;
	      const scoreMoney         = Math.min(300, Math.round(totalMoney / 50000));
	      const scoreWinRate       = Math.round(winRate);

	      const totalScore = scoreJuniorTitles + scoreJuniorFinals
	        + scoreATPTitles + scoreATPFinals + scoreGC
	        + scoreBestRank + scoreCurrentRank
	        + scoreMoney + scoreWinRate;

	      ranking.push({
	        discordId:      sp.discord_id,
	        ingameName:     sp.ingame_name,
	        tmFullName:     `${pRow.Firstname} ${pRow.Lastname}`,
	        country:        pRow.Country ?? '—',
	        currentRankATP,
	        currentPoints,
	        bestRankATP,
	        bestRankJunior,
	        gcTitles,
	        titlesATP,
	        finalsATP,
	        titlesJunior,
	        finalsJunior,
	        matchPlayed,
	        matchWon,
	        winRate,
	        totalMoney,
	        totalScore,
	      });
	    }

	    ranking.sort((a, b) => {
	      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
	      const ra = a.currentRankATP ?? 9999;
	      const rb = b.currentRankATP ?? 9999;
	      return ra - rb;
	    });

	    return ranking;
	  } catch (e) {
	    console.error('[PowerRanking] Erreur:', e.message);
	    return null;
	  } finally {
	    s.close();
	  }
	}

	// ── Configs des tris disponibles ────────────────────────────────────────────
	const PR_SORT_CONFIGS = {
	  score:        { label: '👑 Score global',     emoji: '👑', sort: (a, b) => b.totalScore     - a.totalScore,    stat: p => `**${p.totalScore} pts**` },
	  best_rank:    { label: '📊 Best Ranking ATP',  emoji: '📊', sort: (a, b) => (a.bestRankATP ?? 9999) - (b.bestRankATP ?? 9999), stat: p => p.bestRankATP ? `Best #${p.bestRankATP}` : 'NR' },
	  current_rank: { label: '🌍 Ranking actuel',   emoji: '🌍', sort: (a, b) => (a.currentRankATP ?? 9999) - (b.currentRankATP ?? 9999), stat: p => p.currentRankATP ? `#${p.currentRankATP} (${p.currentPoints.toLocaleString()} pts)` : 'non classé' },
	  titles_atp:   { label: '🏆 Titres ATP',       emoji: '🏆', sort: (a, b) => b.titlesATP      - a.titlesATP,     stat: p => `${p.titlesATP} titre${p.titlesATP > 1 ? 's' : ''}` },
	  finals_atp:   { label: '🥈 Finales ATP',      emoji: '🥈', sort: (a, b) => b.finalsATP      - a.finalsATP,     stat: p => `${p.finalsATP} finale${p.finalsATP > 1 ? 's' : ''}` },
	  gc:           { label: '🎳 Grand Chelems',    emoji: '🎳', sort: (a, b) => b.gcTitles        - a.gcTitles,      stat: p => `${p.gcTitles} GC` },
	  titles_junior:{ label: '🎓 Titres Juniors',   emoji: '🎓', sort: (a, b) => b.titlesJunior    - a.titlesJunior,  stat: p => `${p.titlesJunior} titre${p.titlesJunior > 1 ? 's' : ''} junior` },
	  finals_junior:{ label: '🎓 Finales Juniors',  emoji: '🎓', sort: (a, b) => b.finalsJunior    - a.finalsJunior,  stat: p => `${p.finalsJunior} finale${p.finalsJunior > 1 ? 's' : ''} junior` },
	  winrate:      { label: '📈 Win Rate',         emoji: '📈', sort: (a, b) => b.winRate          - a.winRate,       stat: p => p.matchPlayed > 0 ? `${p.winRate.toFixed(1)}% (${p.matchWon}V/${p.matchPlayed - p.matchWon}D)` : '—' },
	  prize:        { label: '💰 Prize Money',      emoji: '💰', sort: (a, b) => b.totalMoney       - a.totalMoney,    stat: p => p.totalMoney > 0 ? `${(p.totalMoney / 1000).toFixed(0)}k $` : '—' },
	};

	/**
	 * Trie et construit l'embed Power Ranking selon le critère demandé.
	 * @param {Array}  rawRanking  — tableau brut retourné par getPowerRankingData()
	 * @param {string} sortKey     — clé dans PR_SORT_CONFIGS (défaut: 'score')
	 */
	function buildPowerRankingEmbed(rawRanking, sortKey = 'score') {
	  const MEDALS = ['🥇', '🥈', '🥉'];
	  const cfg    = PR_SORT_CONFIGS[sortKey] ?? PR_SORT_CONFIGS.score;

	  // Clone + tri selon le critère actif
	  const ranking = [...rawRanking].sort(cfg.sort);

	  // Titre et couleur adaptés au critère
	  const SORT_COLORS = {
	    score: COLOR.gold, best_rank: COLOR.tennis, current_rank: COLOR.tennis,
	    titles_atp: 0xE67E22, finals_atp: 0xBDC3C7, gc: 0xF39C12,
	    titles_junior: 0x9B59B6, finals_junior: 0x8E44AD,
	    winrate: COLOR.green, prize: 0x27AE60,
	  };

	  const embed = new EmbedBuilder()
	    .setColor(SORT_COLORS[sortKey] ?? COLOR.gold)
	    .setTitle(`${cfg.emoji} Power Ranking — ${cfg.label}`)
	    .setDescription(
	      `> Classement trié par **${cfg.label}** · ${rawRanking.length} joueur${rawRanking.length > 1 ? 's' : ''} dans la simulation.\n\u200B`
	    )
	    .setFooter({ text: `Tennis Manager 2026 · /power-ranking · Tri : ${cfg.label}` })
	    .setTimestamp();

	  if (!ranking.length) {
	    embed.addFields({ name: '⚠️ Aucune donnée', value: 'Aucun joueur n\'est encore lié via `/link`.' });
	    return embed;
	  }

	  // ── Podium top 3 ──────────────────────────────────────────────────────────
	  const podiumLines = ranking.slice(0, Math.min(3, ranking.length)).map((p, i) => {
	    const medal     = MEDALS[i];
	    const statStr   = cfg.stat(p);
	    const rankStr   = p.currentRankATP ? `ATP #${p.currentRankATP}` : p.bestRankATP ? `Best #${p.bestRankATP}` : 'non classé';
	    const juniorStr = p.titlesJunior > 0 ? ` 🎓${p.titlesJunior}T` : '';
	    const atpStr    = p.titlesATP    > 0 ? ` 🏆${p.titlesATP}T`    : '';
	    const gcStr     = p.gcTitles     > 0 ? ` 🎳${p.gcTitles}GC`    : '';
	    // Ligne mise en avant = la stat du tri actif
	    return (
	      `${medal} **${p.ingameName}** *(${p.tmFullName} · ${p.country})*\n` +
	      `┣ ${cfg.emoji} ${statStr}\n` +
	      `┗ ${rankStr}${juniorStr}${atpStr}${gcStr} · 📈 ${p.matchPlayed > 0 ? p.winRate.toFixed(0) + '%WR' : '—'}`
	    );
	  }).join('\n\n');

	  embed.addFields({ name: '🏆 Podium', value: podiumLines || '—' });

	  // ── Suite #4–#10 ──────────────────────────────────────────────────────────
	  if (ranking.length > 3) {
	    const restLines = ranking.slice(3, Math.min(10, ranking.length)).map((p, i) => {
	      const pos     = i + 4;
	      const statStr = cfg.stat(p);
	      const rankStr = p.currentRankATP ? `#${p.currentRankATP}` : p.bestRankATP ? `best #${p.bestRankATP}` : 'NR';
	      return `**${pos}.** ${p.ingameName} (${p.country}) — ${cfg.emoji} ${statStr}  ·  ${rankStr}`;
	    }).join('\n');
	    embed.addFields({ name: `🎾 Suite (#4–#${Math.min(10, ranking.length)})`, value: restLines });
	  }

	  // ── Légende score (uniquement en mode global) ─────────────────────────────
	  if (sortKey === 'score') {
	    embed.addFields({
	      name: '📐 Calcul du score composite',
	      value:
	        '`Titre Junior ×5`  `Finale Junior ×2`  `Titre ATP ×8`  `Finale ATP ×3`  `GC ×15`\n' +
	        '`Best Rank → 200-rank`  `Rank actuel → 150-rank`  `Prize /50k (max 300)`  `+WinRate%`',
	      inline: false,
	    });
	  }

	  return embed;
	}

	/**
	 * Génère les ActionRows de boutons de tri pour le Power Ranking.
	 * Discord limite à 5 boutons par row et 5 rows par message.
	 * On répartit les 10 tris sur 2 rows de 5.
	 * Le bouton actif est mis en style Primary, les autres en Secondary.
	 */
	function buildPowerRankingComponents(activeSortKey = 'score') {
	  // Row 1 : tris principaux
	  const row1Keys = ['score', 'best_rank', 'current_rank', 'titles_atp', 'finals_atp'];
	  // Row 2 : tris secondaires
	  const row2Keys = ['gc', 'titles_junior', 'finals_junior', 'winrate', 'prize'];

	  const makeButton = (key) => {
	    const cfg = PR_SORT_CONFIGS[key];
	    return new ButtonBuilder()
	      .setCustomId(`pr_sort:${key}`)
	      .setLabel(cfg.label)
	      .setStyle(key === activeSortKey ? ButtonStyle.Primary : ButtonStyle.Secondary);
	  };

	  return [
	    new ActionRowBuilder().addComponents(row1Keys.map(makeButton)),
	    new ActionRowBuilder().addComponents(row2Keys.map(makeButton)),
	  ];
	}

	// Détecte si TournamentCategory existe et a une colonne Type
	// Dans ce schéma : Tournament.CategoryId -> TournamentCategory.Id (colonne Type = niveau)
	function getTournCategoryJoin(s) {
	  const tcTables = s.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='TournamentCategory'").get();
	  if (tcTables) {
		const tcCols = s.prepare('PRAGMA table_info(TournamentCategory)').all().map(c => c.name);
		if (tcCols.includes('Type')) return { sel: 'tc.Type AS Category', join: 'LEFT JOIN TournamentCategory tc ON tc.Id = t.CategoryId', ord: 'tc.Type ASC,' };
	  }
	  // Fallback : cherche une colonne directe sur Tournament
	  const tCols = s.prepare('PRAGMA table_info(Tournament)').all().map(c => c.name);
	  console.log('[Palmares] Colonnes Tournament:', tCols.join(', '));
	  for (const c of ['CategoryId', 'Category', 'Type', 'TournamentType', 'Kind', 'Level']) {
		if (tCols.includes(c)) return { sel: `t.${c} AS Category`, join: '', ord: `t.${c} ASC,` };
	  }
	  return { sel: 'NULL AS Category', join: '', ord: '' };
	}

	// Retourne un Set des CategoryId juniors dans ce save.db
	// Sont considérés juniors : tournois dont le nom contient "junior" ou commence par J suivi d'un chiffre/lettre (JA, J1, J2...)
	// OU dont la catégorie a un Type >= 10 (catégories juniors dans TM2026 : 10=JA, 11=J1, 12=J2, 13=J3...)
	function getJuniorCategoryIds(s) {
	  const ids = new Set();
	  try {
		// Méthode principale : TournamentCategory.Circuit=1 (junior) dans TM2026
		try {
		  const catCols = s.prepare('PRAGMA table_info(TournamentCategory)').all().map(c => c.name);
		  if (catCols.includes('Circuit')) {
			const rows = s.prepare('SELECT DISTINCT Id FROM TournamentCategory WHERE Circuit=1').all();
			for (const r of rows) if (r.Id != null) ids.add(r.Id);
		  }
		} catch (_) {}
		// Fallback : nom du tournoi contenant "junior"
		if (ids.size === 0) {
		  const rows = s.prepare(`
			SELECT DISTINCT t.CategoryId FROM Tournament t
			WHERE lower(t.Name) LIKE '%junior%'
			   OR t.Name LIKE 'J %' OR t.Name LIKE 'J-%'
			   OR t.Name GLOB 'J[0-9]*' OR t.Name GLOB 'J[A-Z]*'
		  `).all();
		  for (const r of rows) if (r.CategoryId != null) ids.add(r.CategoryId);
		}
	  } catch (e) { console.error('[JuniorCat] Erreur:', e.message); }
	  return ids;
	}

	// Génère WHERE fragment + params pour exclure les tournois juniors
	function buildJuniorExcludeClause(juniorCatIds) {
	  const nameFilter = `(lower(t.Name) NOT LIKE '%junior%'
		AND t.Name NOT LIKE 'J %' AND t.Name NOT LIKE 'J-%'
		AND t.Name NOT GLOB 'J[0-9]*' AND t.Name NOT GLOB 'J[A-Z]*')`;
	  if (juniorCatIds.size === 0) return { clause: nameFilter, ids: [] };
	  const ids = [...juniorCatIds];
	  const ph  = ids.map(() => '?').join(',');
	  return { clause: `(t.CategoryId NOT IN (${ph}) AND ${nameFilter})`, ids };
	}

	// Palmarès filtré par catégorie (Grand Chelem, Masters 1000, etc.)
	function getTmPalmares(tmId) {
	  const s = openSaveDb();
	  if (!s) return null;
	  try {
		const { sel: catSel, join: catJoin, ord: catOrd } = getTournCategoryJoin(s);
		const juniorCatIds = getJuniorCategoryIds(s);
		const { clause: jExcl, ids: jIds } = buildJuniorExcludeClause(juniorCatIds);

		const titles = s.prepare(`
		  SELECT t.Name, ${catSel}, tr.Year, tr.MoneyWon, tr.RoundReached, tr.PointsMain
		  FROM TournamentResult tr
		  JOIN Tournament t ON t.Id=tr.TournamentId
		  ${catJoin}
		  WHERE tr.PlayerId=? AND tr.RoundReached=-1 AND ${jExcl}
		    AND t.Name IS NOT NULL AND trim(t.Name) != ''
		    AND lower(t.Name) NOT LIKE '%estimated%'
		    AND lower(t.Name) NOT LIKE '%unknown%'
		  ORDER BY ${catOrd} tr.Year DESC
		`).all(tmId, ...jIds);

		const finals = s.prepare(`
		  SELECT t.Name, ${catSel}, tr.Year, tr.RoundReached, tr.PointsMain
		  FROM TournamentResult tr
		  JOIN Tournament t ON t.Id=tr.TournamentId
		  ${catJoin}
		  WHERE tr.PlayerId=? AND tr.RoundReached=0 AND ${jExcl}
		    AND t.Name IS NOT NULL AND trim(t.Name) != ''
		    AND lower(t.Name) NOT LIKE '%estimated%'
		    AND lower(t.Name) NOT LIKE '%unknown%'
		  ORDER BY ${catOrd} tr.Year DESC
		`).all(tmId, ...jIds);

		// ── Juniors ──────────────────────────────────────────────────────────────
		const { clause: jIncl2, ids: jIdsIncl2 } = (() => {
		  const nameFilter = `(lower(t.Name) LIKE '%junior%'
			OR t.Name LIKE 'J %' OR t.Name LIKE 'J-%'
			OR t.Name GLOB 'J[0-9]*' OR t.Name GLOB 'J[A-Z]*')`;
		  if (juniorCatIds.size === 0) return { clause: nameFilter, ids: [] };
		  const ids = [...juniorCatIds];
		  const ph  = ids.map(() => '?').join(',');
		  return { clause: `(t.CategoryId IN (${ph}) OR ${nameFilter})`, ids };
		})();

		const titlesJunior = s.prepare(`
		  SELECT t.Name, tr.Year, tr.RoundReached
		  FROM TournamentResult tr
		  JOIN Tournament t ON t.Id=tr.TournamentId
		  WHERE tr.PlayerId=? AND tr.RoundReached=-1 AND ${jIncl2}
		    AND t.Name IS NOT NULL AND trim(t.Name) != ''
		    AND lower(t.Name) NOT LIKE '%estimated%'
		    AND lower(t.Name) NOT LIKE '%unknown%'
		  ORDER BY tr.Year DESC
		`).all(tmId, ...jIdsIncl2);

		const finalsJunior = s.prepare(`
		  SELECT t.Name, tr.Year, tr.RoundReached
		  FROM TournamentResult tr
		  JOIN Tournament t ON t.Id=tr.TournamentId
		  WHERE tr.PlayerId=? AND tr.RoundReached=0 AND ${jIncl2}
		    AND t.Name IS NOT NULL AND trim(t.Name) != ''
		    AND lower(t.Name) NOT LIKE '%estimated%'
		    AND lower(t.Name) NOT LIKE '%unknown%'
		  ORDER BY tr.Year DESC
		`).all(tmId, ...jIdsIncl2);

		const sf = s.prepare(`
		  SELECT t.Name, ${catSel}, tr.Year, tr.RoundReached
		  FROM TournamentResult tr
		  JOIN Tournament t ON t.Id=tr.TournamentId
		  ${catJoin}
		  WHERE tr.PlayerId=? AND tr.RoundReached=1 AND ${jExcl}
		  ORDER BY ${catOrd} tr.Year DESC
		`).all(tmId, ...jIds);

		const byCategory = {};
		for (const r of titles) {
		  const cat = categFromPoints(r.Category ?? 3, r.PointsMain, r.Name);
		  if (!byCategory[cat]) byCategory[cat] = [];
		  byCategory[cat].push(r);
		}

		return { titles, finals, sf, byCategory, titlesJunior, finalsJunior };
	  } catch (e) { console.error('Palmares error:', e.message); return null; }
	  finally { s.close(); }
	}

	// Top classement mondial TM
	function getTmClassement(limit = 20) {
	  const s = openSaveDb();
	  if (!s) { console.error('[Classement] save.db non disponible'); return []; }
	  try {
		// Inspecter le schéma réel de Ranking
		const cols = s.prepare('PRAGMA table_info(Ranking)').all().map(c => c.name);
		console.log('[Classement] Colonnes Ranking:', cols.join(', '));
		const sample = s.prepare('SELECT * FROM Ranking LIMIT 1').get();
		console.log('[Classement] Exemple Ranking:', JSON.stringify(sample));

		const hasDate = cols.includes('Date');
		const hasYear = cols.includes('Year');
		const hasWeek = cols.includes('Week');

		let rows = [];
		if (hasDate) {
		  rows = s.prepare(`
			SELECT tp.Id, tp.Firstname, tp.Lastname, tp.Country, r.Rank, r.Points
			FROM TennisPlayer tp
			JOIN Ranking r ON r.PlayerId = tp.Id
			WHERE tp.Retired=0 AND r.Circuit=0
			  AND r.Date = (SELECT MAX(r2.Date) FROM Ranking r2 WHERE r2.PlayerId=tp.Id AND r2.Circuit=0)
			ORDER BY r.Rank ASC LIMIT ?
		  `).all(limit);
		} else if (hasYear && hasWeek) {
		  rows = s.prepare(`
			SELECT tp.Id, tp.Firstname, tp.Lastname, tp.Country, r.Rank, r.Points
			FROM TennisPlayer tp
			JOIN Ranking r ON r.PlayerId = tp.Id
			WHERE tp.Retired=0 AND r.Circuit=0
			  AND r.Year*100+r.Week = (SELECT MAX(r2.Year*100+r2.Week) FROM Ranking r2 WHERE r2.PlayerId=tp.Id AND r2.Circuit=0)
			ORDER BY r.Rank ASC LIMIT ?
		  `).all(limit);
		} else {
		  // Fallback sans filtre de date
		  rows = s.prepare(`
			SELECT tp.Id, tp.Firstname, tp.Lastname, tp.Country,
			  MIN(r.Rank) AS Rank, r.Points
			FROM TennisPlayer tp
			JOIN Ranking r ON r.PlayerId = tp.Id
			WHERE tp.Retired=0 AND r.Circuit=0
			GROUP BY tp.Id ORDER BY Rank ASC LIMIT ?
		  `).all(limit);
		}
		console.log('[Classement]', rows.length, 'joueurs trouvés');
		return rows;
	  } catch (e) { console.error('[Classement] Erreur SQL:', e.message); return []; }
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

	// Référence partagée au canal de log auto-upgrade (initialisée au boot du client)
	let autoUpgradeLogChannel = null;

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
	function moneyFmt(n){ return n > 0 ? `$${Number(n).toLocaleString('fr-FR')}` : '—'; }
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
		.setDescription(`${PLAYSTYLE_EMOJI[player.playstyle] ?? '🎾'} ${player.playstyle ? `*${player.playstyle}*` : ''}  •  🌍 ${player.nationality}`.trim())
		.setThumbnail(avatarUrl)
		.addFields(
		  { name: '💰 Coins', value: `**${player.coins.toLocaleString()} 🪙**`, inline: true },
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

	  const { p, rank, race, bestRank, rankJunior, bestRankJunior, injuries } = tmData;

	  // Circuit
	  const hasJunior = rankJunior && (rankJunior.Rank != null);
	  const hasATP    = rank && (rank.Rank != null);
	  const circuitLabel = hasJunior && !hasATP ? '🎓 Junior' : hasJunior ? '🎓 Junior → 🏆 ATP' : '🏆 ATP';

	  // ── Identité TM ─────────────────────────────────────────────────────────────
	  embed.addFields(
		{ name: '─────── 👤 Joueur TM2026 ───────', value: '\u200B' },
		{ name: '🆔 Nom',         value: `${p.Firstname} ${p.Lastname}`,         inline: true },
		{ name: '🌍 Pays',        value: p.Country ?? '—',                        inline: true },
		{ name: '🎂 Âge',         value: `${age(p.DateOfBirth)} ans`,             inline: true },
		{ name: '🖐️ Main',        value: HAND_LABEL[p.Handedness] ?? '—',        inline: true },
		{ name: '🎯 Revers',      value: BH_LABEL[p.BackhandStyle] ?? '—',        inline: true },
		{ name: '📡 Circuit',     value: circuitLabel,                             inline: true },
		{ name: '💪 Condition',   value: `${p.PhysicalCondition ?? '—'}/100`,     inline: true },
		{ name: '❤️ Moral',      value: `${p.Morale ?? '—'}/100`,                inline: true },
		{ name: '🌟 Notoriété',   value: `${(p.Fame ?? 0).toFixed(1)}/20`,        inline: true },
	  );

	  if (injuries?.length) {
		embed.addFields({ name: '🩹 Blessures actives', value: `${injuries.length} blessure(s) en cours`, inline: false });
	  }

	  // ── Attributs détaillés par groupe ─────────────────────────────────────────
	  if (p) {
		for (const [groupName, attrs] of Object.entries(ATTR_GROUPS)) {
		  const lines = attrs.map(([key, label]) => {
			const val = p[key] ?? 0;
			return `\`${label.padEnd(20)}\` ${attrBar(val)}`;
		  }).join('\n');
		  embed.addFields({ name: groupName, value: lines, inline: false });
		}
	  }

	  // ── Maîtrise surface ────────────────────────────────────────────────────────
	  embed.addFields(
		{ name: '─────── 🏟️ Maîtrise surface ───────', value: '\u200B' },
		{ name: '🔶 Terre battue', value: surfBar(p.ClaySurfaceMastering),       inline: true },
		{ name: '🟩 Gazon',        value: surfBar(p.GrassSurfaceMastering),      inline: true },
		{ name: '🔷 Dur',          value: surfBar(p.HardSurfaceMastering),       inline: true },
		{ name: '🏟️ Dur indoor',  value: surfBar(p.HardIndoorSurfaceMastering),  inline: true },
	  );

	  return embed;
	}

	function buildAttributesEmbed(player, p, avatarUrl, boosts = {}) {
	  const embed = new EmbedBuilder()
		.setColor(COLOR.purple)
		.setTitle(`📋 Attributs — ${p.Firstname} ${p.Lastname}`)
		.setDescription(`${player.ingame_name ? `Profil : **${player.ingame_name}** | ` : ''}Potentiel : **${(p.Potential ?? 0).toFixed(1)}/20**`)
		.setFooter({ text: 'Tennis Manager 2026 — Attributs' })
		.setTimestamp();

	  if (avatarUrl) embed.setThumbnail(avatarUrl);

	  // Calcul de la moyenne globale
	  const allAttrs = Object.values(ATTR_GROUPS).flat().map(([key]) => {
		const boosted = boosts[key] ?? 0;
		return Math.min((p[key] ?? 0) + boosted, BOOST_ABS_CAP);
	  });
	  const avg = (allAttrs.reduce((a, b) => a + b, 0) / allAttrs.length).toFixed(1);
	  embed.addFields({ name: '⚖️ Moyenne globale', value: `**${avg}/20**` });

	  for (const [groupName, attrs] of Object.entries(ATTR_GROUPS)) {
		const lines = attrs.map(([key, label]) => {
		const boosted  = boosts[key] ?? 0;
		const val      = Math.min((p[key] ?? 0) + boosted, BOOST_ABS_CAP);
		const boostTag = boosted > 0 ? ` ⬆+${boosted}` : '';
		return `\`${label.padEnd(20)}\` ${attrBar(val)}${boostTag}`;
	  }).join('\n');
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
		  `${t.amount > 0 ? '📈' : '📉'} \`${t.amount > 0 ? '+' : ''}${t.amount}\` — ${t.reason} *(${t.created_at.split('T')[0]})*`
		).join('\n');
		embed.addFields({ name: '📋 Dernières transactions', value: lines });
	  }
	  return embed;
	}

	function buildPublicStatsEmbed(tm, forme, rivalites) {
	  const { p, rank, race, bestRank, rankJunior, bestRankJunior, statsJunior, stats, surfStats, titles, finals, lastResults, totalMoney, injuries } = tm;
	  const name = `${p.Firstname} ${p.Lastname}`;

	  // Détecter le circuit principal : Junior si rang Junior présent et rang ATP absent/faible
	  const hasJunior = rankJunior && (rankJunior.Rank != null);
	  const hasATP    = rank && (rank.Rank != null);
	  const circuitLabel = hasJunior && !hasATP ? '🎓 Junior' : hasJunior ? '🎓 Junior → 🏆 ATP' : '🏆 ATP';

	  // Ligne de classement ATP
	  const rankATPStr = hasATP
		? `🏆 ATP **#${rank.Rank + 1}** (${(rank.Points ?? 0).toLocaleString()} pts)` +
		  (bestRank != null ? ` | Meilleur : **#${bestRank}**` : '') +
		  (race.RaceRank != null ? ` | Race : **#${race.RaceRank + 1}**` : '')
		: null;

	  // Ligne de classement Junior
	  const rankJuniorStr = hasJunior
		? `🎓 Junior **#${rankJunior.Rank + 1}** (${(rankJunior.Points ?? 0).toLocaleString()} pts)` +
		  (bestRankJunior != null ? ` | Meilleur : **#${bestRankJunior}**` : '')
		: null;

	  const classementLines = [rankATPStr, rankJuniorStr].filter(Boolean).join('\n');

	  const embed = new EmbedBuilder()
		.setColor(COLOR.tennis)
		.setTitle(`📊 Stats — ${name} (${p.Country ?? '??'})`)
		.setDescription(
		  `${HAND_LABEL[p.Handedness] ?? ''} — ${BH_LABEL[p.BackhandStyle] ?? ''} | Âge : **${age(p.DateOfBirth)}** ans | ${circuitLabel}\n` +
		  (classementLines || '_Aucun classement_')
		)
		.setFooter({ text: 'Tennis Manager 2026 — Stats' })
		.setTimestamp();

	  // Bilan ATP
	  embed.addFields(
		{ name: '🏆 Titres ATP', value: `**${titles}**`, inline: true },
		{ name: '🥈 Finales ATP', value: `**${finals}**`, inline: true },
		{ name: '📊 Bilan ATP', value: stats.played ? `**${stats.won}V** / ${stats.played - stats.won}D (${pct(stats.won, stats.played)})` : '—', inline: true },
	  );

	  // Bilan Junior si le joueur a des données juniors (même s'il est passé pro)
	  if ((statsJunior?.played ?? 0) > 0 || (statsJunior?.titles ?? 0) > 0 || (statsJunior?.finals ?? 0) > 0) {
		embed.addFields(
		  { name: '🎓 Titres Junior',  value: `**${statsJunior.titles ?? 0}**`,  inline: true },
		  { name: '🥈 Finales Junior', value: `**${statsJunior.finals ?? 0}**`,  inline: true },
		  { name: '📊 Bilan Junior',   value: (statsJunior.played ?? 0) > 0 ? `**${statsJunior.won ?? 0}V** / ${(statsJunior.played ?? 0) - (statsJunior.won ?? 0)}D (${pct(statsJunior.won ?? 0, statsJunior.played ?? 0)})` : (statsJunior.titles > 0 || statsJunior.finals > 0 ? '— (stats non dispo)' : '—'), inline: true },
		);
	  }

	  // ── Forme récente ────────────────────────────────────────────────────────────
	  if (forme) {
		const streakLabel = forme.streakType
		  ? `🔥 ${forme.streak} victoire${forme.streak > 1 ? 's' : ''} de suite`
		  : `❄️ ${forme.streak} défaite${forme.streak > 1 ? 's' : ''} de suite`;
		embed.addFields({
		  name: '─────── 📈 Forme récente ───────',
		  value:
			`**${forme.wins}V / ${forme.losses}D** sur les ${forme.total} derniers matchs ` +
			`(${pct(forme.wins, forme.total)})\n` +
			`5 derniers : ${forme.last5}\n` +
			streakLabel,
		});
	  }

	  if (stats.played) {
		embed.addFields(
		  { name: '─────── 📊 Stats match ───────', value: '\u200B' },
		  { name: '🎾 Aces',          value: `${stats.aces ?? 0}`,              inline: true },
		  { name: '❌ Doubles f.',    value: `${stats.df ?? 0}`,                 inline: true },
		  { name: '\u200B',           value: '\u200B',                           inline: true },
		  { name: '💥 1er service',   value: pct(stats.fs1w, stats.fs1p),       inline: true },
		  { name: '🔄 2ème service',  value: pct(stats.fs2w, stats.fs2p),       inline: true },
		  { name: '\u200B',           value: '\u200B',                           inline: true },
		  { name: '🛡️ BP sauvés',    value: pct(stats.bpSaved, stats.bpFaced), inline: true },
		  { name: '⚡ BP convertis',  value: pct(stats.bpConv, stats.bpOpp),    inline: true },
		  { name: '💵 Gains carrière',value: moneyFmt(totalMoney),              inline: true },
		);
	  }

	  if (surfStats.length) {
		const lines = surfStats.map(s =>
		  `${SURFACE_LABEL[s.Surface] ?? `Surface ${s.Surface}`} : **${s.w}V/${s.p - s.w}D** (${pct(s.w, s.p)})`
		).join('\n');
		embed.addFields({ name: '─────── 🌍 Bilan par surface ───────', value: lines });
	  }

	  // ── Rivalités principales ────────────────────────────────────────────────────
	  if (rivalites?.length) {
		const lines = rivalites.map(r => {
		  const bilan = `**${r.wins}V**–${r.losses}D sur ${r.total} match${r.total > 1 ? 's' : ''}`;
		  const edge = r.wins > r.losses ? '🟢' : r.wins < r.losses ? '🔴' : '🟡';
		  return `${edge} **${r.Name}** (${r.Country}) — ${bilan}`;
		}).join('\n');
		embed.addFields({ name: '─────── ⚔️ Rivalités principales ───────', value: lines });
	  }

	  if (lastResults.length) {
		const lines = lastResults.map(r => {
		  const cat = categFromPoints(r.Category, r.PointsMain, r.Name);
		  const opponent = r.OpponentName ? ` vs **${r.OpponentName}**` : '';
		  return `${TOURN_CAT_SHORT[cat] ? `[${TOURN_CAT_SHORT[cat]}] ` : ''}${ROUND_LABEL[String(r.RoundReached)] ?? `R${r.RoundReached}`} — **${r.Name}** (${r.Year})${opponent}`;
		}).join('\n');
		embed.addFields({ name: `─────── 🏅 Meilleurs résultats ${lastResults[0]?.Year ? `(saison ${lastResults[0].Year})` : ''} ───────`, value: lines });
	  }

	  if (injuries.length) {
		embed.addFields({ name: '🩹 Blessures', value: injuries.map(i => `• Zone ${i.Zone} (Type ${i.Type})`).join('\n') });
	  }

	  return embed;
	}

	function buildH2HEmbed(p1, p2, h2h, stats1, stats2) {
	  const name1 = `${p1.Firstname} ${p1.Lastname}`;
	  const name2 = `${p2.Firstname} ${p2.Lastname}`;
	  const total = h2h.wins1 + h2h.wins2;

	  const bar1 = total > 0 ? Math.round(h2h.wins1 / total * 10) : 5;
	  const bar2 = 10 - bar1;
	  const barStr = `${'🟢'.repeat(bar1)}${'🔴'.repeat(bar2)}`;

	  const embed = new EmbedBuilder()
		.setColor(COLOR.blue)
		.setTitle(`⚔️ Head-to-Head`)
		.setDescription(
		  `**${name1}** (${p1.Country}) vs **${name2}** (${p2.Country})\n\n` +
		  `${barStr}\n` +
		  `**${h2h.wins1}** — ${total} matchs — **${h2h.wins2}**`
		)
		.setFooter({ text: 'Tennis Manager 2026 — H2H' })
		.setTimestamp();

	  // Breakdown par surface
	  if (h2h.surfH2H.length) {
		const surfLines = h2h.surfH2H.map(s => {
		  const label = SURFACE_LABEL[s.Surface] ?? `Surface ${s.Surface}`;
		  return `${label} : **${s.w1}**–**${s.w2}** (${s.total} matchs)`;
		}).join('\n');
		embed.addFields({ name: '🏟️ Par surface', value: surfLines });
	  }

	  // ── Comparaison d'attributs ──────────────────────────────────────────────────
	  if (stats1 && stats2) {
		// Groupes de comparaison : moyenne par catégorie
		const compareGroups = [
		  { label: '🎾 Service',       keys: ['ServePower','ServeSpin','ServeConsistency'] },
		  { label: '🎯 Fond de court', keys: ['Forehand','ForehandConsistency','Backhand','BackhandConsistency','Return','Counter','Topspin','Underspin','Dropshot','Control','Timing'] },
		  { label: '🏃 Physique',      keys: ['Speed','Footwork','Balance','Agility','Fitness','Stamina'] },
		  { label: '🧠 Mental',        keys: ['Anticipation','Focus','Composure','KillerInstinct','FightingSpirit','Tactical'] },
		  { label: '🏅 Volée',         keys: ['Volley'] },
		];

		const avg = (obj, keys) => {
		  const vals = keys.map(k => obj[k] ?? 0);
		  return vals.reduce((a, b) => a + b, 0) / vals.length;
		};

		const compLines = compareGroups.map(g => {
		  const a1 = avg(stats1, g.keys);
		  const a2 = avg(stats2, g.keys);
		  const diff = a1 - a2;
		  const edge = Math.abs(diff) < 0.3 ? '🟡' : diff > 0 ? '🟢' : '🔴';
		  // Barre visuelle centrée
		  const filled1 = Math.round(a1 / 20 * 5);
		  const filled2 = Math.round(a2 / 20 * 5);
		  return `${edge} **${g.label}** — ${a1.toFixed(1)} ${'●'.repeat(filled1)}${'○'.repeat(5-filled1)} vs ${'●'.repeat(filled2)}${'○'.repeat(5-filled2)} ${a2.toFixed(1)}`;
		}).join('\n');

		// Ligne totale
		const allKeys = compareGroups.flatMap(g => g.keys);
		const tot1 = avg(stats1, allKeys);
		const tot2 = avg(stats2, allKeys);
		const totEdge = Math.abs(tot1 - tot2) < 0.2 ? '🟡' : tot1 > tot2 ? '🟢' : '🔴';

		embed.addFields({
		  name: `─────── 📊 Comparaison — ${p1.Lastname} vs ${p2.Lastname} ───────`,
		  value: compLines + `\n\n${totEdge} **Moyenne globale** — **${tot1.toFixed(1)}** vs **${tot2.toFixed(1)}**`,
		});
	  }

	  // Derniers matchs
	  if (h2h.meetings.length) {
		const lines = h2h.meetings.map(m => {
		  const winner = (m.Player1Id === p1.Id && m.Outcome === 2) || (m.Player2Id === p1.Id && m.Outcome === 3) ? name1 : name2;
		  const cat = normalizeTournCat(m.Category, m.TournName);
		  const catLabel = TOURN_CAT_EMOJI[cat] ?? '🎾';
		  return `${catLabel} **${winner}** — ${m.TournName} (${ROUND_LABEL[String(m.Round)] ?? `R${m.Round}`})`;
		}).join('\n');
		embed.addFields({ name: '📋 Derniers matchs', value: lines.slice(0, 1024) });
	  } else {
		embed.addFields({ name: '📋 Matchs', value: '*Aucun match trouvé entre ces deux joueurs.*' });
	  }

	  return embed;
	}

	function buildPalmaresEmbed(p, palmares) {
	  const name = `${p.Firstname} ${p.Lastname}`;
	  const embed = new EmbedBuilder()
		.setColor(COLOR.gold)
		.setTitle(`🏆 Palmarès — ${name} (${p.Country})`)
		.setFooter({ text: 'Tennis Manager 2026 — Palmarès' })
		.setTimestamp();

	  const totalATPTitles  = palmares.titles.length;
	  const totalATPFinals  = palmares.finals.length;
	  const totalJrTitles   = palmares.titlesJunior?.length ?? 0;
	  const totalJrFinals   = palmares.finalsJunior?.length ?? 0;

	  const descLines = [
		`🏆 ATP : **${totalATPTitles}** titre${totalATPTitles !== 1 ? 's' : ''} — **${totalATPFinals}** finale${totalATPFinals !== 1 ? 's' : ''}`,
	  ];
	  if (totalJrTitles > 0 || totalJrFinals > 0) {
		descLines.push(`🎓 Junior : **${totalJrTitles}** titre${totalJrTitles !== 1 ? 's' : ''} — **${totalJrFinals}** finale${totalJrFinals !== 1 ? 's' : ''}`);
	  }
	  embed.setDescription(descLines.join('\n'));

	  // Titres ATP par catégorie
	  for (const [cat, results] of Object.entries(palmares.byCategory).sort((a, b) => a[0] - b[0])) {
		const catNum = Number(cat);
		const label = `${TOURN_CAT_EMOJI[catNum] ?? '🎾'} ${TOURN_CAT[catNum] ?? `Cat. ${catNum}`}`;
		const lines = results.map(r => `• **${r.Name}** (${r.Year})`).join('\n');
		embed.addFields({ name: `${label} — ${results.length} titre${results.length > 1 ? 's' : ''}`, value: lines.slice(0, 1024) });
	  }

	  if (totalATPTitles === 0) {
		embed.addFields({ name: '🏆 Titres ATP', value: '*Aucun titre ATP remporté.*' });
	  }

	  // Finales ATP perdues
	  if (totalATPFinals > 0) {
		const lines = palmares.finals.map(r => `• **${r.Name}** (${r.Year})`).join('\n');
		embed.addFields({ name: `🥈 Finales ATP — ${totalATPFinals}`, value: lines.slice(0, 1024) });
	  }

	  // Titres juniors
	  if (totalJrTitles > 0) {
		const lines = palmares.titlesJunior.map(r => `• **${r.Name}** (${r.Year})`).join('\n');
		embed.addFields({ name: `🎓 Titres Junior — ${totalJrTitles}`, value: lines.slice(0, 1024) });
	  }

	  // Finales juniors perdues
	  if (totalJrFinals > 0) {
		const lines = palmares.finalsJunior.map(r => `• **${r.Name}** (${r.Year})`).join('\n');
		embed.addFields({ name: `🎓 Finales Junior — ${totalJrFinals}`, value: lines.slice(0, 1024) });
	  }

	  return embed;
	}

	function buildHistoriqueEmbed(p, timeline) {
	  const name = `${p.Firstname} ${p.Lastname}`;
	  const embed = new EmbedBuilder()
		.setColor(COLOR.gold)
		.setTitle(`📅 Historique de carrière — ${name} (${p.Country})`)
		.setFooter({ text: 'Tennis Manager 2026 — Historique' })
		.setTimestamp();

	  if (!timeline?.length) {
		embed.setDescription('*Aucune donnée de carrière disponible.*');
		return embed;
	  }

	  // Totaux carrière en description
	  const totalTitles = timeline.reduce((s, y) => s + y.titles, 0);
	  const totalPlayed = timeline.reduce((s, y) => s + y.played, 0);
	  const totalWon    = timeline.reduce((s, y) => s + y.won, 0);
	  const totalMoney  = timeline.reduce((s, y) => s + y.money, 0);
	  const bestRankEver = timeline.reduce((best, y) => {
		if (y.bestRank == null) return best;
		return best == null ? y.bestRank : Math.min(best, y.bestRank);
	  }, null);

	  embed.setDescription(
		`**${totalTitles}** titre${totalTitles !== 1 ? 's' : ''} · ` +
		`**${totalWon}V/${totalPlayed - totalWon}D** en carrière (${pct(totalWon, totalPlayed)})` +
		(bestRankEver ? ` · Meilleur classement : **#${bestRankEver}**` : '') +
		(totalMoney > 0 ? `\n💵 Total gains : **${moneyFmt(totalMoney)}**` : '')
	  );

	  // Une ligne par année, en chunks de 10 pour éviter la limite Discord
	  const yearLines = timeline.map(y => {
		const parts = [];

		if (y.bestRank) parts.push(`📍 #${y.bestRank} (fin: #${y.endRank ?? '?'})`);
		if (y.played) parts.push(`${y.won}V/${y.played - y.won}D (${pct(y.won, y.played)})`);

		if (y.titles > 0) {
		  const titleStr = y.titleNames.length <= 3
			? y.titleNames.join(', ')
			: `${y.titleNames.slice(0, 3).join(', ')}… (+${y.titleNames.length - 3})`;
		  const gcNote = y.gcTitles > 0 ? ` 🏆×${y.gcTitles}` : '';
		  parts.push(`🥇 ${y.titles} titre${y.titles > 1 ? 's' : ''}${gcNote} — ${titleStr}`);
		}

		if (y.money > 0) parts.push(`💵 ${moneyFmt(y.money)}`);

		const line = parts.join(' · ');
		return `**${y.year}** — ${line || '*Saison sans résultat notable*'}`;
	  });

	  // ── Graphique ASCII évolution classement saison par saison ─────────────────
	  const rankData = timeline.filter(y => y.endRank != null);
	  if (rankData.length >= 2) {
	    const maxRank = Math.max(...rankData.map(y => y.endRank));
	    const minRank = Math.min(...rankData.map(y => y.endRank));
	    const HEIGHT  = 5;

	    const normalize = (r) => {
	      if (maxRank === minRank) return Math.floor(HEIGHT / 2);
	      return Math.round(((r - minRank) / (maxRank - minRank)) * (HEIGHT - 1));
	    };

	    const cols = rankData.map(y => ({
	      year: y.year,
	      rank: y.endRank,
	      row:  normalize(y.endRank),
	    }));

	    // Chaque colonne = 3 chars : point centré sur char 1, puis 2 espaces
	    // Année = 2 chars → on centre en ajoutant 1 espace devant : ' 20  21 ...'
	    // Col data : '●  ' ou '   ' ou '│  ' → join sans séparateur
	    // Col année : ' ' + 2chars + ' ' → join sans séparateur → chaque colonne = 4 chars
	    // Solution : utiliser colonne de 4 chars partout : '●   ' / ' 20 '
	    const PREFIX_W = 7; // '#XXXX  '
	    const graphRows = [];
	    for (let row = 0; row < HEIGHT; row++) {
	      const rankAtRow = Math.round(minRank + (row / (HEIGHT - 1)) * (maxRank - minRank));
	      const prefix = `#${String(rankAtRow).padStart(4)}  `; // 7 chars fixes
	      const cells = cols.map((c, idx) => {
	        let ch;
	        if (c.row === row) ch = '●';
	        else if (idx > 0) {
	          const prev = cols[idx - 1];
	          ch = ((prev.row < row && c.row > row) || (prev.row > row && c.row < row)) ? '│' : ' ';
	        } else ch = ' ';
	        return ch + '   '; // chaque colonne = 4 chars (1 point + 3 espaces)
	      });
	      // Supprimer les espaces trailing de la dernière colonne
	      graphRows.push((prefix + cells.join('')).trimEnd());
	    }
	    // Ligne des années : chaque année occupe 4 chars (' 20 ' → 1+2+1)
	    const yearPrefix = ' '.repeat(PREFIX_W);
	    const yearCells = cols.map(c => String(c.year).slice(-2) + '  '); // pas d'espace devant : aligne sur le point
	    graphRows.push((yearPrefix + yearCells.join('')).trimEnd());

	    embed.addFields({
	      name: '📈 Évolution classement (fin de saison)',
	      value: '```\n' + graphRows.join('\n') + '\n```',
	    });
	  }

	  // Découper en champs de max 10 années
	  for (let i = 0; i < yearLines.length; i += 10) {
		const chunk = yearLines.slice(i, i + 10);
		const firstYear = timeline[i].year;
		const lastYear  = timeline[Math.min(i + 9, timeline.length - 1)].year;
		const label = firstYear === lastYear ? firstYear : `${firstYear} – ${lastYear}`;
		embed.addFields({ name: `📆 ${label}`, value: chunk.join('\n').slice(0, 1024) });
	  }

	  return embed;
	}

	function buildClassementEmbed(rows, page, simuPlayers) {
	  const pageSize = 20;
	  const start = page * pageSize;
	  const slice = rows.slice(start, start + pageSize);
	  const total = rows.length;

	  const embed = new EmbedBuilder()
		.setColor(COLOR.tennis)
		.setTitle(`🌍 Classement ATP — #${start + 1} à #${Math.min(start + pageSize, total)}`)
		.setFooter({ text: `Tennis Manager 2026 — Classement · ${total} joueurs actifs` })
		.setTimestamp();

	  if (!slice.length) {
		embed.setDescription('*Classement non disponible.*');
		return embed;
	  }

	  const medals = ['🥇', '🥈', '🥉'];
	  const lines = slice.map((r) => {
		const pos = r.Rank ?? (start + slice.indexOf(r)); // Rank est 0-indexé en DB
		const displayPos = pos + 1;
		const prefix = page === 0 && pos <= 2 ? medals[pos] : `#${displayPos}`;
		return `${prefix} **${r.Firstname} ${r.Lastname}** (${r.Country ?? '??'}) — ${(r.Points ?? 0).toLocaleString()} pts`;
	  }).join('\n');

	  embed.setDescription(lines);

	  // Section joueurs de la simulation
	  if (simuPlayers && simuPlayers.length) {
		const simuLines = simuPlayers.map(sp => {
		  const rankStr = sp.rank != null ? `#${sp.rank}` : '`non classé`';
		  return `${rankStr} **${sp.ingame_name}** — ${(sp.points ?? 0).toLocaleString()} pts`;
		}).join('\n');
		embed.addFields({ name: '🎮 Joueurs de la simulation', value: simuLines });
	  }

	  return embed;
	}

	function buildClassementComponents(page, totalRows) {
	  const pageSize = 20;
	  const maxPage = Math.ceil(totalRows / pageSize) - 1;
	  const prev = new ButtonBuilder()
		.setCustomId(`classement_page:${page - 1}`)
		.setLabel('◀️ Précédent')
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(page <= 0);
	  const next = new ButtonBuilder()
		.setCustomId(`classement_page:${page + 1}`)
		.setLabel('Suivant ▶️')
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(page >= maxPage);
	  const info = new ButtonBuilder()
		.setCustomId('classement_info')
		.setLabel(`Page ${page + 1} / ${maxPage + 1}`)
		.setStyle(ButtonStyle.Primary)
		.setDisabled(true);
	  return [new ActionRowBuilder().addComponents(prev, info, next)];
	}

	// ══════════════════════════════════════════════════════════════════════════════
	//  DÉFINITION DES SLASH COMMANDS
	// ══════════════════════════════════════════════════════════════════════════════
	const COMMANDS_DATA = [

	new SlashCommandBuilder()
		.setName('creer-joueur')
		.setDescription('Crée ton joueur dans la simulation TM2026 (un seul par compte Discord)'),

	  new SlashCommandBuilder()
		.setName('supprimer-joueur')
		.setDescription('(Admin) Supprimer le joueur d\'un utilisateur pour les tests')
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.addUserOption(o => o.setName('cible').setDescription('Utilisateur Discord dont supprimer le joueur').setRequired(true)),

	  new SlashCommandBuilder()
		.setName('link')
		.setDescription('[Admin] Associe un joueur Discord à son personnage TM2026')
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.addUserOption(o => o.setName('joueur').setDescription('Joueur Discord à lier').setRequired(true))
		.addStringOption(o => o.setName('nom').setDescription('Prénom ou nom dans TM2026').setRequired(true)),

	  new SlashCommandBuilder()
		.setName('profil')
		.setDescription('Voir le profil complet et les stats d\'un joueur')
		.addUserOption(o => o.setName('joueur').setDescription('Joueur Discord à consulter (toi par défaut)').setRequired(false))
		.addStringOption(o => o.setName('nom').setDescription('Ou chercher par nom TM2026 (ex: Federer)').setRequired(false)),

	  new SlashCommandBuilder()
		.setName('attributs')
		.setDescription('Voir tous les attributs TM2026 d\'un joueur')
		.addUserOption(o => o.setName('joueur').setDescription('Joueur Discord à consulter (toi par défaut)').setRequired(false))
		.addStringOption(o => o.setName('nom').setDescription('Ou chercher par nom TM2026 (ex: Federer)').setRequired(false)),

	  new SlashCommandBuilder()
		.setName('coins')
		.setDescription('Voir ton solde de coins et tes dernières transactions'),

	  new SlashCommandBuilder()
		.setName('stats')
		.setDescription('Stats complètes d\'un joueur TM2026 (par nom, sans compte Discord requis)')
		.addStringOption(o => o.setName('nom').setDescription('Prénom ou nom du joueur TM2026').setRequired(true)),

	  new SlashCommandBuilder()
		.setName('h2h')
		.setDescription('Head-to-Head entre deux joueurs TM2026')
		.addStringOption(o => o.setName('joueur1').setDescription('Prénom/nom du 1er joueur').setRequired(true))
		.addStringOption(o => o.setName('joueur2').setDescription('Prénom/nom du 2ème joueur').setRequired(true)),

	  new SlashCommandBuilder()
		.setName('palmares')
		.setDescription('Palmarès détaillé d\'un joueur (Grand Chelem, Masters 1000...)')
		.addStringOption(o => o.setName('nom').setDescription('Prénom ou nom du joueur TM2026').setRequired(true)),

	  new SlashCommandBuilder()
		.setName('historique')
		.setDescription('Timeline de carrière année par année d\'un joueur TM2026')
		.addStringOption(o => o.setName('nom').setDescription('Prénom ou nom du joueur TM2026').setRequired(true)),

	  new SlashCommandBuilder()
		.setName('classement')
		.setDescription('Classement ATP mondial du save.db (Top 20)'),

	  new SlashCommandBuilder()
		.setName('shop')
		.setDescription('Voir le shop : coûts des boosts pour chaque attribut'),

	  new SlashCommandBuilder()
		.setName('boost')
		.setDescription('Améliorer un attribut de ton joueur TM2026 (coûte des coins)')
		.addStringOption(o =>
		  o.setName('stat')
		   .setDescription('Attribut à booster (tape pour chercher)')
		   .setRequired(true)
		   .setAutocomplete(true)),

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
		  .setName('check_rewards')
		  .setDescription('Distribue manuellement les récompenses tournois sans reload du save.db'))
		.addSubcommand(s => s
		  .setName('info_db')
		  .setDescription('Infos sur le save.db actuellement chargé'))
		.addSubcommand(s => s
		  .setName('recap_boost')
		  .setDescription('Voir tous les boosts en attente d\'application dans le save.db'))
		.addSubcommand(s => s
		  .setName('auto_upgrade_all')
		  .setDescription('(Admin) Déclenche manuellement l\'auto-upgrade pour tous les joueurs actifs'))
		.addSubcommand(s => s
		  .setName('set_photo')
		  .setDescription('Associe une photo de personnage à un joueur (affichée dans /profil, /attributs, /stats...)')
		  .addUserOption(o => o.setName('joueur').setDescription('Joueur Discord cible').setRequired(true))
		  .addStringOption(o => o.setName('url').setDescription('URL directe de l\'image (png/jpg/gif/webp)').setRequired(true))),

	  new SlashCommandBuilder()
		.setName('auto-upgrade')
		.setDescription('Active/désactive l\'amélioration automatique de tes stats (bot investit tes coins automatiquement)'),

	  new SlashCommandBuilder()
		.setName('tournoi')
		.setDescription("Voir le parcours d'un joueur dans un tournoi (sans année = récap toutes éditions)")
		.addStringOption(o => o.setName('tournoi').setDescription('Nom du tournoi (ex: Roland Garros, Wimbledon...)').setRequired(true))
		.addStringOption(o => o.setName('joueur').setDescription('Nom TM2026 du joueur à consulter (toi par défaut)').setRequired(false))
		.addIntegerOption(o => o.setName('annee').setDescription('Année spécifique (ex: 2026) — optionnel').setRequired(false)),

  new SlashCommandBuilder()
		.setName('power-ranking')
		.setDescription('👑 Power Ranking des joueurs de la simulation (titres juniors, ranking ATP, prize money, winrate)'),

  new SlashCommandBuilder()
		.setName('saison')
		.setDescription('Tous les résultats tournois d\'un joueur sur une saison donnée')
		.addIntegerOption(o => o.setName('annee').setDescription('Année de la saison (ex: 2026)').setRequired(true).setMinValue(1990).setMaxValue(2100))
		.addUserOption(o => o.setName('joueur').setDescription('Joueur Discord (toi par défaut)').setRequired(false))
		.addStringOption(o => o.setName('nom').setDescription('Ou chercher par nom TM2026 (ex: Federer)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('tops')
    .setDescription('🏆 Classements spéciaux : meilleurs par surface ou en Grand Chelem')
    .addSubcommand(s => s
      .setName('surface')
      .setDescription('Top 10 joueurs par surface (winrate V/D, min 10 matchs)')
      .addIntegerOption(o => o
        .setName('surface')
        .setDescription('Surface à filtrer (toutes par défaut)')
        .setRequired(false)
        .addChoices(
          { name: '🔶 Terre battue', value: 1 },
          { name: '🟩 Gazon',        value: 2 },
          { name: '🔷 Dur',          value: 3 },
          { name: '🏟️ Dur indoor',   value: 4 },
        )))
    .addSubcommand(s => s
      .setName('gc')
      .setDescription('Meilleurs résultats en Grand Chelem (victoires + meilleur parcours)'))
  ,
	];

	// ══════════════════════════════════════════════════════════════════════════════
	//  HANDLERS
	// ══════════════════════════════════════════════════════════════════════════════

	// Sessions de création de joueur (portée module pour être accessible dans handleCommand et startBot)
	const cjSessions = new Map(); // userId → données en cours de saisie

	async function handleCommand(interaction) {
	  const cmd = interaction.commandName;

	// ── /creer-joueur ─────────────────────────────────────────────────────────────
	//  Étape 1 : vérification existence → envoi du Modal (identité)
	if (cmd === 'creer-joueur') {
		if (await db.exists(interaction.user.id))
		  return interaction.reply({ embeds: [err('Tu as déjà un joueur ! Utilise `/profil`.')], ephemeral: true });
		// Bloque si création déjà en cours (sans table Supabase active)
		if (cjSessions.has(interaction.user.id))
		  return interaction.reply({ embeds: [err('Tu as déjà une création de joueur en cours ! Termine le formulaire ou relance `/creer-joueur` dans quelques minutes.')], ephemeral: true });

		const modal = new ModalBuilder()
		  .setCustomId('creer_joueur_modal')
		  .setTitle('🎾 Créer ton joueur — Identité');

		modal.addComponents(
		  new ActionRowBuilder().addComponents(
			new TextInputBuilder()
			  .setCustomId('cj_nom')
			  .setLabel('Prénom Nom (pseudo in-game)')
			  .setStyle(TextInputStyle.Short)
			  .setMinLength(2).setMaxLength(32)
			  .setPlaceholder('ex: Rafael Nadal')
			  .setRequired(true)
		  ),
		  new ActionRowBuilder().addComponents(
			new TextInputBuilder()
			  .setCustomId('cj_pays')
			  .setLabel('Nationalité (pays)')
			  .setStyle(TextInputStyle.Short)
			  .setMinLength(2).setMaxLength(50)
			  .setPlaceholder('ex: France')
			  .setRequired(true)
		  ),
		);

		return interaction.showModal(modal);
	}

	// ── /supprimer-joueur ─────────────────────────────────────────────────────────
	if (cmd === 'supprimer-joueur') {
		const target = interaction.options.getUser('cible');
		if (!await db.exists(target.id))
		  return interaction.reply({ embeds: [err(`**${target.username}** n'a pas de joueur.`)], ephemeral: true });
		await db.delete(target.id);
		return interaction.reply({ embeds: [ok('Joueur supprimé', `Le joueur de <@${target.id}> a été supprimé.\nIl peut relancer `/creer-joueur`.`)], ephemeral: true });
	}

	  // ── /link ─────────────────────────────────────────────────────────────────────
	  if (cmd === 'link') {
		await interaction.deferReply({ ephemeral: true });

		// Double sécurité admin côté code
		if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
		  return interaction.editReply({ embeds: [err('Commande réservée aux administrateurs.')] });

		const target = interaction.options.getUser('joueur');
		if (!target)
		  return interaction.editReply({ embeds: [err('Utilisateur Discord introuvable.')] });

		if (!seasonDbReady)
		  return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

		const query   = interaction.options.getString('nom').trim();
		const results = searchTmPlayers(query);

		if (!results.length)
		  return interaction.editReply({ embeds: [err('Aucun joueur trouvé pour **"' + query + '"** dans le save.db.')] });

		if (results.length === 1) {
		  const tm = results[0];
		  await db.linkTm(target.id, tm.Id);
		  return interaction.editReply({ embeds: [ok('Joueur lié !',
			'<@' + target.id + '> (' + target.username + ') est maintenant lié à **' + tm.Firstname + ' ' + tm.Lastname + '** (' + tm.Country + ') — ID `' + tm.Id + '`.'
		  )]});
		}

		const linkLines = results.map((tm, i) =>
		  '`' + (i + 1) + '.` **' + tm.Firstname + ' ' + tm.Lastname + '** (' + tm.Country + ') — ID `' + tm.Id + '`'
		).join('\n');
		return interaction.editReply({ embeds: [
		  new EmbedBuilder().setColor(COLOR.blue)
			.setTitle('🔍 Plusieurs joueurs trouvés')
			.setDescription(linkLines + '\n\nRefais `/link` avec le prénom + nom complet pour préciser.')
		] });
	  }
	  // ── /profil ───────────────────────────────────────────────────────────────────
	  if (cmd === 'profil') {
		await interaction.deferReply();

		const nomQuery = interaction.options.getString('nom');

		// Mode recherche par nom TM (sans compte Discord)
		if (nomQuery) {
		  if (!seasonDbReady)
			return interaction.editReply({ embeds: [err('Save.db non disponible.')] });
		  const results = getTmPlayerByName(nomQuery.trim());
		  if (!results.length)
			return interaction.editReply({ embeds: [err(`Aucun joueur trouvé pour **"${nomQuery}"** dans le save.db.`)] });
		  if (results.length > 1) {
			const lines = results.map((r, i) =>
			  `${i + 1}. **${r.Firstname} ${r.Lastname}** (${r.Country})`
			).join('\n');
			return interaction.editReply({ embeds: [
			  new EmbedBuilder().setColor(COLOR.blue)
				.setTitle('🔍 Plusieurs joueurs trouvés')
				.setDescription(`${lines}\n\nPrécise le prénom + nom complet.`)
			] });
		  }
		  const tm = getTmPlayerData(results[0].Id);
		  if (!tm) return interaction.editReply({ embeds: [err('Impossible de lire les stats de ce joueur.')] });
		  // Faux profil Discord minimal pour réutiliser buildProfileEmbed
		  const fakePlayer = {
			ingame_name: `${tm.p.Firstname} ${tm.p.Lastname}`,
			nationality: tm.p.Country ?? '—',
			playstyle: null,
			coins: 0,
			tm_player_id: results[0].Id,
		  };
		  const tmName1 = `${tm.p.Firstname} ${tm.p.Lastname}`;
		  const navRow1 = buildProfilNavButtons(tmName1);
		  return interaction.editReply({ embeds: [buildProfileEmbed(fakePlayer, tm, null)], components: navRow1 });
		}

		// Mode Discord : joueur mentionné ou soi-même
		const target = interaction.options.getUser('joueur') ?? interaction.user;
		const player = await db.get(target.id);

		if (!player) {
		  return interaction.editReply({ embeds: [err(
			target.id === interaction.user.id
			  ? 'Pas encore de joueur. Utilise `/creer-joueur` !'
			  : `**${target.username}** n'a pas de joueur.`
		  )] });
		}

		// Pas de joueur TM lié → embed léger
		if (!player.tm_player_id) {
		  const profilPhoto = player.character_photo ?? target.displayAvatarURL({ dynamic: true });
		  return interaction.editReply({ embeds: [buildProfileEmbed(player, null, profilPhoto)] });
		}

		if (!seasonDbReady)
		  return interaction.editReply({ embeds: [err('Save.db en cours de chargement, réessaie dans quelques secondes.')] });

		const tmFull = getTmPlayerData(player.tm_player_id);
		if (!tmFull) {
		  const profilPhoto = player.character_photo ?? target.displayAvatarURL({ dynamic: true });
		  return interaction.editReply({ embeds: [buildProfileEmbed(player, null, profilPhoto)] });
		}

		// Profil Discord complet : identité + classement, pas de stats détaillées (→ /stats)
		const pFull = tmFull.p;
		const profilPhoto = player.character_photo ?? target.displayAvatarURL({ dynamic: true });

		const forme2     = getTmForme(player.tm_player_id);
		const rivalites2 = getTmRivalites(player.tm_player_id);

		// Circuit du joueur
		const hasJuniorP = tmFull.rankJunior && (tmFull.rankJunior.Rank != null);
		const hasATPP    = tmFull.rank && (tmFull.rank.Rank != null);
		const circuitP   = hasJuniorP && !hasATPP ? '🎓 Junior' : hasJuniorP ? '🎓 Junior → 🏆 ATP' : '🏆 ATP';

		const rankATPLineP = hasATPP
		  ? `🏆 ATP **#${tmFull.rank.Rank + 1}** (${(tmFull.rank.Points ?? 0).toLocaleString()} pts)` +
			(tmFull.bestRank != null ? ` | Meilleur : **#${tmFull.bestRank}**` : '') +
			(tmFull.race.RaceRank != null ? ` | Race : **#${tmFull.race.RaceRank + 1}**` : '')
		  : null;
		const rankJuniorLineP = hasJuniorP
		  ? `🎓 Junior **#${tmFull.rankJunior.Rank + 1}** (${(tmFull.rankJunior.Points ?? 0).toLocaleString()} pts)` +
			(tmFull.bestRankJunior != null ? ` | Meilleur : **#${tmFull.bestRankJunior}**` : '')
		  : null;
		const classementP = [rankATPLineP, rankJuniorLineP].filter(Boolean).join('\n') || '_Aucun classement_';

		const embedDiscord = buildProfileEmbed(player, tmFull, profilPhoto);
		// Surcharge titre et description pour les infos Discord
		embedDiscord.setTitle(`🎾 ${pFull.Firstname} ${pFull.Lastname} (${pFull.Country ?? '—'})`);
		embedDiscord.setDescription(
		  `${HAND_LABEL[pFull.Handedness] ?? '—'} — ${BH_LABEL[pFull.BackhandStyle] ?? '—'} | Âge : **${age(pFull.DateOfBirth)} ans** | ${circuitP}\n` +
		  `🎮 **${player.ingame_name}** | 💰 **${player.coins.toLocaleString()} 🪙**\n` +
		  classementP
		);
		embedDiscord.setFooter({ text: 'Tennis Manager 2026 — Profil TM' });

		const tmName2 = `${pFull.Firstname} ${pFull.Lastname}`;
		const profilComponents2 = buildProfilNavButtons(tmName2);
		return interaction.editReply({
		  embeds: [embedDiscord],
		  components: profilComponents2,
		});
	  }

	  // ── /attributs ────────────────────────────────────────────────────────────────
	  if (cmd === 'attributs') {
		await interaction.deferReply();

		const nomQuery = interaction.options.getString('nom');

		// Mode recherche par nom TM (sans compte Discord)
		if (nomQuery) {
		  if (!seasonDbReady)
			return interaction.editReply({ embeds: [err('Save.db non disponible.')] });
		  const results = getTmPlayerByName(nomQuery.trim());
		  if (!results.length)
			return interaction.editReply({ embeds: [err(`Aucun joueur trouvé pour **"${nomQuery}"** dans le save.db.`)] });
		  if (results.length > 1) {
			const lines = results.map((r, i) =>
			  `${i + 1}. **${r.Firstname} ${r.Lastname}** (${r.Country})`
			).join('\n');
			return interaction.editReply({ embeds: [
			  new EmbedBuilder().setColor(COLOR.blue)
				.setTitle('🔍 Plusieurs joueurs trouvés')
				.setDescription(`${lines}\n\nPrécise le prénom + nom complet.`)
			] });
		  }
		  const s = openSaveDb();
		  if (!s) return interaction.editReply({ embeds: [err('Save.db non disponible.')] });
		  let tmPlayer;
		  try { tmPlayer = s.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(results[0].Id); }
		  finally { s.close(); }
		  if (!tmPlayer) return interaction.editReply({ embeds: [err('Joueur introuvable dans le save.db.')] });
		  // Faux profil Discord minimal pour réutiliser buildAttributesEmbed
		  const fakeProfile = { ingame_name: `${tmPlayer.Firstname} ${tmPlayer.Lastname}` };
		  return interaction.editReply({
			embeds: [buildAttributesEmbed(fakeProfile, tmPlayer, null)]
		  });
		}

		// Mode Discord
		const target = interaction.options.getUser('joueur') ?? interaction.user;
		const player = await db.get(target.id);

		if (!player)
		  return interaction.editReply({ embeds: [err(target.id === interaction.user.id ? 'Pas encore de joueur. Utilise `/creer-joueur` !' : `**${target.username}** n'a pas de joueur.`)] });

		if (!player.tm_player_id)
		  return interaction.editReply({ embeds: [err('Aucun joueur TM2026 lié. Utilise `/link` d\'abord.')] });

		if (!seasonDbReady)
		  return interaction.editReply({ embeds: [err('Save.db en cours de chargement, réessaie dans quelques secondes.')] });

		const s = openSaveDb();
		if (!s) return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

		let p;
		try { p = s.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(player.tm_player_id); }
		finally { s.close(); }

		if (!p) return interaction.editReply({ embeds: [err('Joueur TM introuvable dans le save.db.')] });

		const attrsPhoto = player.character_photo ?? target.displayAvatarURL({ dynamic: true });
		return interaction.editReply({
		  embeds: [buildAttributesEmbed(player, p, attrsPhoto, await shopDb.getBoosts(interaction.user.id))]
		});
	  }

	  // ── /coins ────────────────────────────────────────────────────────────────────
	  if (cmd === 'coins') {
		await interaction.deferReply({ ephemeral: true });
		const player = await db.get(interaction.user.id);
		if (!player)
		  return interaction.editReply({ embeds: [err('Pas encore de joueur. Utilise `/creer-joueur` !')] });
		return interaction.editReply({
		  embeds: [buildWalletEmbed(player, await db.txHistory(interaction.user.id))],
		});
	  }

	  // ── /stats ───────────────────────────────────────────────────────────────────
	  if (cmd === 'stats') {
		await interaction.deferReply();
		if (!seasonDbReady)
		  return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

		const query = interaction.options.getString('nom').trim();
		const results = getTmPlayerByName(query);

		if (!results.length)
		  return interaction.editReply({ embeds: [err(`Aucun joueur trouvé pour **"${query}"**.`)] });

		if (results.length > 1) {
		  const lines = results.map((r, i) =>
			`${i + 1}. **${r.Firstname} ${r.Lastname}** (${r.Country})`
		  ).join('\n');
		  return interaction.editReply({ embeds: [
			new EmbedBuilder().setColor(COLOR.blue)
			  .setTitle('🔍 Plusieurs joueurs trouvés')
			  .setDescription(`${lines}\n\nPrécise le prénom + nom complet.`)
		  ] });
		}

		const tm = getTmPlayerData(results[0].Id);
		if (!tm) return interaction.editReply({ embeds: [err('Impossible de lire les stats de ce joueur.')] });

		const forme     = getTmForme(results[0].Id);
		const rivalites = getTmRivalites(results[0].Id);
		return interaction.editReply({ embeds: [buildPublicStatsEmbed(tm, forme, rivalites)] });
	  }

	  // ── /h2h ─────────────────────────────────────────────────────────────────────
	  if (cmd === 'h2h') {
		await interaction.deferReply();
		if (!seasonDbReady)
		  return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

		const q1 = interaction.options.getString('joueur1').trim();
		const q2 = interaction.options.getString('joueur2').trim();

		const r1 = getTmPlayerByName(q1);
		const r2 = getTmPlayerByName(q2);

		if (!r1.length) return interaction.editReply({ embeds: [err(`Joueur **"${q1}"** introuvable.`)] });
		if (!r2.length) return interaction.editReply({ embeds: [err(`Joueur **"${q2}"** introuvable.`)] });

		if (r1.length > 1)
		  return interaction.editReply({ embeds: [err(`Plusieurs joueurs pour "${q1}" — précise le nom complet.`)] });
		if (r2.length > 1)
		  return interaction.editReply({ embeds: [err(`Plusieurs joueurs pour "${q2}" — précise le nom complet.`)] });

		const p1 = r1[0], p2 = r2[0];
		if (p1.Id === p2.Id)
		  return interaction.editReply({ embeds: [err('Les deux joueurs sont identiques.')] });

		const h2h = getH2H(p1.Id, p2.Id);
		if (!h2h) return interaction.editReply({ embeds: [err('Impossible de calculer le H2H.')] });

		const stats1 = getTmRawStats(p1.Id);
		const stats2 = getTmRawStats(p2.Id);
		return interaction.editReply({ embeds: [buildH2HEmbed(p1, p2, h2h, stats1, stats2)] });
	  }

	  // ── /palmares ────────────────────────────────────────────────────────────────
	  if (cmd === 'palmares') {
		await interaction.deferReply();
		if (!seasonDbReady)
		  return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

		const query = interaction.options.getString('nom').trim();
		const results = getTmPlayerByName(query);

		if (!results.length)
		  return interaction.editReply({ embeds: [err(`Aucun joueur trouvé pour **"${query}"**.`)] });

		if (results.length > 1) {
		  const lines = results.map((r, i) =>
			`${i + 1}. **${r.Firstname} ${r.Lastname}** (${r.Country})`
		  ).join('\n');
		  return interaction.editReply({ embeds: [
			new EmbedBuilder().setColor(COLOR.blue)
			  .setTitle('🔍 Plusieurs joueurs trouvés')
			  .setDescription(`${lines}\n\nPrécise le prénom + nom complet.`)
		  ] });
		}

		const palmares = getTmPalmares(results[0].Id);
		if (!palmares) return interaction.editReply({ embeds: [err('Impossible de lire le palmarès.')] });

		return interaction.editReply({ embeds: [buildPalmaresEmbed(results[0], palmares)] });
	  }

	  // ── /historique ──────────────────────────────────────────────────────────────
	  if (cmd === 'historique') {
		await interaction.deferReply();
		if (!seasonDbReady)
		  return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

		const query = interaction.options.getString('nom').trim();
		const results = getTmPlayerByName(query);

		if (!results.length)
		  return interaction.editReply({ embeds: [err(`Aucun joueur trouvé pour **"${query}"**.`)] });

		if (results.length > 1) {
		  const lines = results.map((r, i) =>
			`${i + 1}. **${r.Firstname} ${r.Lastname}** (${r.Country})`
		  ).join('\n');
		  return interaction.editReply({ embeds: [
			new EmbedBuilder().setColor(COLOR.blue)
			  .setTitle('🔍 Plusieurs joueurs trouvés')
			  .setDescription(`${lines}\n\nPrécise le prénom + nom complet.`)
		  ] });
		}

		const s = openSaveDb();
		if (!s) return interaction.editReply({ embeds: [err('Save.db non disponible.')] });
		let p;
		try { p = s.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(results[0].Id); }
		finally { s.close(); }
		if (!p) return interaction.editReply({ embeds: [err('Joueur introuvable dans le save.db.')] });

		const timeline = getTmHistorique(results[0].Id);
		return interaction.editReply({ embeds: [buildHistoriqueEmbed(p, timeline)] });
	  }

	  // ── /classement ──────────────────────────────────────────────────────────────
	  if (cmd === 'classement') {
		await interaction.deferReply();
		if (!seasonDbReady)
		  return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

		const rows = getTmClassement(500);
		const { data: simuRaw } = await supabase.from('players').select('ingame_name, tm_player_id').not('tm_player_id', 'is', null);
		const simuPlayers = (simuRaw ?? []).map(sp => {
		  const tmRow = rows.find(r => r.Id === sp.tm_player_id);
		  return { ingame_name: sp.ingame_name, rank: tmRow?.Rank ?? null, points: tmRow?.Points ?? 0 };
		}).sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
		return interaction.editReply({
		  embeds: [buildClassementEmbed(rows, 0, simuPlayers)],
		  components: buildClassementComponents(0, rows.length),
		});
	  }

	  // ── /admin ────────────────────────────────────────────────────────────────────
	  // ── /shop ──────────────────────────────────────────────────────────────────
	  if (cmd === 'shop') {
		const player = await db.get(interaction.user.id);
		if (!player) return interaction.reply({ embeds: [err('Tu n\'as pas de compte. Utilise `/creer-joueur`.')], ephemeral: true });
		if (!player.tm_player_id) return interaction.reply({ embeds: [err('Ton compte n\'est pas lié à un joueur TM2026. Utilise `/link`.')], ephemeral: true });
		const s = openSaveDb();
		if (!s) return interaction.reply({ embeds: [err('Save.db non disponible.')], ephemeral: true });
		const p = s.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(player.tm_player_id);
		if (!p) return interaction.reply({ embeds: [err('Joueur TM introuvable.')], ephemeral: true });
		const boosts = await shopDb.getBoosts(interaction.user.id);

		const embed = new EmbedBuilder()
		  .setColor(COLOR.gold)
		  .setTitle(`🛒 Shop — ${player.ingame_name}`)
		  .setDescription(
			`Solde : **${player.coins.toLocaleString()} 🪙** | Plafond : **18/20** | Max par stat : **+${BOOST_MAX_PER_STAT}**\n` +
			'Utilisez `/boost <stat>` pour acheter un boost.\n' +
			`Les valeurs affichées incluent déjà vos boosts actifs.`
		  )
		  .setFooter({ text: 'Coût exponentiel — plus la stat est haute, plus c\'est cher' });

		// Grouper par catégorie pour la lisibilité
		const groups = {
		  '🎾 Service':     ['ServePower','ServeSpin','ServeConsistency'],
		  '🎯 Fond de court': ['Forehand','ForehandConsistency','Backhand','BackhandConsistency','Return','Counter','Topspin','Underspin','Dropshot','Control','Timing'],
		  '🏃 Physique':    ['Speed','Footwork','Balance','Agility','Fitness','Stamina'],
		  '🧠 Mental':      ['Anticipation','Focus','Composure','KillerInstinct','FightingSpirit','Tactical'],
		  '🏅 Autre':       ['Volley'],
		};
		const labelOf = Object.fromEntries(BOOSTABLE_STATS);

		for (const [grpName, keys] of Object.entries(groups)) {
		  const lines = keys.map(k => {
			const used    = boosts[k] ?? 0;
			const baseVal = p[k] ?? 0;
			const curVal  = Math.min(baseVal + used, BOOST_ABS_CAP);
			const canBoost = used < BOOST_MAX_PER_STAT && curVal < BOOST_ABS_CAP;
			const cost    = canBoost ? boostCost(curVal).toLocaleString() + ' 🪙' : (curVal >= BOOST_ABS_CAP ? '🔒 plafond 18' : '🔒 +2 max atteint');
			const boostedTag = used > 0 ? ` (+${used})` : '';
			return `\`${(labelOf[k] ?? k).padEnd(20)}\` ${curVal.toFixed(1)}${boostedTag}/20 → ${cost}`;
		  }).join('\n');
		  embed.addFields({ name: grpName, value: lines });
		}

		return interaction.reply({ embeds: [embed], ephemeral: true });
	  }

	  // ── /boost ─────────────────────────────────────────────────────────────────
	  if (cmd === 'boost') {
		const player = await db.get(interaction.user.id);
		if (!player) return interaction.reply({ embeds: [err('Tu n\'as pas de compte.')], ephemeral: true });
		if (!player.tm_player_id) return interaction.reply({ embeds: [err('Compte non lié. Utilise `/link`.')], ephemeral: true });
		const statKey = interaction.options.getString('stat');
		const statDef = BOOSTABLE_STATS.find(([k]) => k === statKey);
		if (!statDef) return interaction.reply({ embeds: [err('Stat inconnue.')], ephemeral: true });
		const [, statLabel] = statDef;

		const s = openSaveDb();
		if (!s) return interaction.reply({ embeds: [err('Save.db non disponible.')], ephemeral: true });
		const p = s.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(player.tm_player_id);
		if (!p) return interaction.reply({ embeds: [err('Joueur TM introuvable.')], ephemeral: true });

		const boosts  = await shopDb.getBoosts(interaction.user.id);
		const used    = boosts[statKey] ?? 0;
		const baseVal = p[statKey] ?? 0;
		const curVal  = Math.min(baseVal + used, BOOST_ABS_CAP);

		if (used >= BOOST_MAX_PER_STAT)
		  return interaction.reply({ embeds: [err(`**\${statLabel}** : tu as déjà utilisé tes \${BOOST_MAX_PER_STAT} boosts sur cette stat.`)], ephemeral: true });
		if (curVal >= BOOST_ABS_CAP)
		  return interaction.reply({ embeds: [err(`**\${statLabel}** est déjà au plafond (18).`)], ephemeral: true });

		const cost = boostCost(curVal);
		if (player.coins < cost)
		  return interaction.reply({ embeds: [err(`Solde insuffisant. Ce boost coûte **\${cost.toLocaleString()} 🪙**, tu as **\${player.coins.toLocaleString()} 🪙**.`)], ephemeral: true });

		// Débit + sauvegarde boost
		const ok2 = await db.removeCoins(interaction.user.id, cost, `Boost \${statLabel} \${curVal.toFixed(1)}→\${(curVal+1).toFixed(1)}`);
		if (!ok2) return interaction.reply({ embeds: [err('Erreur lors du paiement.')], ephemeral: true });

		const newBoosts = { ...boosts, [statKey]: used + 1 };
		await shopDb.applyBoost(interaction.user.id, statKey, newBoosts);

		const embed = new EmbedBuilder()
		  .setColor(COLOR.green)
		  .setTitle('🚀 Boost acheté !')
		  .setDescription(
			`<@\${interaction.user.id}> a boosté **\${statLabel}** !\n` +
			`\${curVal.toFixed(1)} → **\${(curVal + 1).toFixed(1)}** (+1)\n` +
			`Coût : **-\${cost.toLocaleString()} 🪙** | Solde restant : **\${(player.coins - cost).toLocaleString()} 🪙**\n` +
			`Boosts restants sur cette stat : **\${BOOST_MAX_PER_STAT - used - 1}**`
		  )
		  .setFooter({ text: 'Boost en attente d\'application dans le save.db — visible dans /admin recap_boost' });

		// Stocker le boost dans boost_log pour recap admin
		await supabase.from('boost_log').insert({
		  discord_id: interaction.user.id,
		  ingame_name: player.ingame_name ?? player.username,
		  stat_key: statKey,
		  stat_label: statLabel,
		  from_val: curVal,
		  to_val: curVal + 1,
		  cost,
		});

		return interaction.reply({ embeds: [embed] });
	  }

	  // ── /auto-upgrade ─────────────────────────────────────────────────────────────
  if (cmd === 'auto-upgrade') {
	await interaction.deferReply({ ephemeral: true });
	const player = await db.get(interaction.user.id);
	if (!player)
	  return interaction.editReply({ embeds: [err('Tu n\'as pas de joueur. Utilise `/creer-joueur` !')] });
	if (!player.tm_player_id)
	  return interaction.editReply({ embeds: [err('Ton compte n\'est pas lié à un joueur TM2026. Utilise `/link`.')] });

	const current = player.auto_upgrade ?? false;
	const next = !current;
	await supabase.from('players').update({ auto_upgrade: next }).eq('discord_id', interaction.user.id);

	if (next) {
	  // Aperçu des boosts disponibles
	  const s = openSaveDb();
	  let previewLines = '';
	  if (s) {
		try {
		  const p = s.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(player.tm_player_id);
		  if (p) {
			const boosts = player.boosts ?? {};
			const candidates = BOOSTABLE_STATS
			  .map(([key, label]) => {
				const used = boosts[key] ?? 0;
				const baseVal = p[key] ?? 0;
				const curVal = Math.min(baseVal + used, BOOST_ABS_CAP);
				if (used >= BOOST_MAX_PER_STAT || curVal >= BOOST_ABS_CAP) return null;
				const cost = boostCost(curVal);
				if (!isFinite(cost)) return null;
				return { label, curVal, cost };
			  })
			  .filter(Boolean)
			  .sort((a, b) => a.cost - b.cost)
			  .slice(0, 5);
			if (candidates.length) {
			  previewLines = '\n\n**Prochains boosts ciblés (du moins cher) :**\n' +
				candidates.map(c => `• **${c.label}** (${c.curVal.toFixed(1)}/20) → ${c.cost.toLocaleString()} 🪙`).join('\n');
			}
		  }
		} finally { s.close(); }
	  }

	  return interaction.editReply({ embeds: [
		new EmbedBuilder()
		  .setColor(COLOR.purple)
		  .setTitle('🤖 Auto-Upgrade activé !')
		  .setDescription(
			`Le bot va automatiquement améliorer les stats de **${player.ingame_name}** toutes les **5 minutes**, ` +
			`en investissant tes coins dans les boosts les moins chers disponibles.\n\n` +
			`💰 Solde actuel : **${player.coins.toLocaleString()} 🪙**` +
			previewLines +
			`\n\n> ⚠️ Les boosts restent dans le **boost_log** — l'admin doit les appliquer manuellement dans le save.db.\n` +
			`> Désactive avec \`/auto-upgrade\` à tout moment.`
		  )
		  .setFooter({ text: 'Auto-Upgrade actif · toutes les 5 min' })
		  .setTimestamp(),
	  ] });
	} else {
	  return interaction.editReply({ embeds: [
		new EmbedBuilder()
		  .setColor(COLOR.blue)
		  .setTitle('⏸️ Auto-Upgrade désactivé')
		  .setDescription(`Le bot ne boostera plus automatiquement **${player.ingame_name}**.\nTes coins ne seront plus dépensés automatiquement.`)
		  .setTimestamp(),
	  ] });
	}
  }

  // ── /power-ranking ────────────────────────────────────────────────────────
  if (cmd === 'power-ranking') {
    await interaction.deferReply();

    if (!seasonDbReady)
      return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

    const ranking = await getPowerRankingData();

    if (!ranking)
      return interaction.editReply({ embeds: [err('Impossible de calculer le Power Ranking.\nVérifie que le save.db est bien chargé.')] });

    return interaction.editReply({
      embeds: [buildPowerRankingEmbed(ranking, 'score')],
      components: buildPowerRankingComponents('score'),
    });
  }

  // ── /tournoi ──────────────────────────────────────────────────────────────────
  if (cmd === 'tournoi') {
	await interaction.deferReply();

	if (!seasonDbReady)
	  return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

	const nomTournoi  = interaction.options.getString('tournoi').trim();
	const nomJoueur   = interaction.options.getString('joueur')?.trim() ?? null;
	const annee       = interaction.options.getInteger('annee'); // null si pas précisé

	// ── Résolution du joueur cible ─────────────────────────────────────────────
	let tmId, pDisplayName;
	const s0 = openSaveDb();
	if (!s0) return interaction.editReply({ embeds: [err('Base de données non disponible.')] });
	try {
	  if (nomJoueur) {
		// Recherche par nom TM dans le save.db
		const found = s0.prepare(`
		  SELECT Id, Firstname, Lastname FROM TennisPlayer
		  WHERE (Firstname LIKE ? OR Lastname LIKE ? OR (Firstname||' '||Lastname) LIKE ?)
		  LIMIT 5
		`).all(`%${nomJoueur}%`, `%${nomJoueur}%`, `%${nomJoueur}%`);
		if (!found.length)
		  return interaction.editReply({ embeds: [err(`Aucun joueur TM trouvé pour **"${nomJoueur}"**.`)] });
		if (found.length > 1) {
		  const list = found.map((r, i) => `${i+1}. **${r.Firstname} ${r.Lastname}**`).join('\n');
		  return interaction.editReply({ embeds: [
			new EmbedBuilder().setColor(COLOR.blue)
			  .setTitle('🔍 Plusieurs joueurs trouvés')
			  .setDescription(`${list}\n\nPrécise le prénom + nom complet.`)
		  ] });
		}
		tmId = found[0].Id;
		pDisplayName = `${found[0].Firstname} ${found[0].Lastname}`;
	  } else {
		// Joueur Discord de l'utilisateur
		const player = await db.get(interaction.user.id);
		if (!player?.tm_player_id)
		  return interaction.editReply({ embeds: [err('Tu n\'as pas de joueur lié. Utilise `/creer-joueur` ou précise un nom avec l\'option `joueur`.')] });
		tmId = player.tm_player_id;
		const pRow = s0.prepare('SELECT Firstname, Lastname FROM TennisPlayer WHERE Id=?').get(tmId);
		pDisplayName = pRow ? `${pRow.Firstname} ${pRow.Lastname}` : player.ingame_name ?? `Joueur #${tmId}`;
	  }
	} finally { s0.close(); }

	// ── Helper : résolution du label de catégorie (ATP / Junior / etc.) ────────
	// Tente d'abord TOURN_CAT, sinon lit TournamentCategory dans le save.db
	function resolveCatLabel(s, categoryId) {
	  if (TOURN_CAT[categoryId]) return { label: TOURN_CAT[categoryId], isJunior: false };
	  try {
		const row = s.prepare('SELECT Name FROM TournamentCategory WHERE Id=? LIMIT 1').get(categoryId);
		if (row?.Name) {
		  const isJunior = /junior|juniors/i.test(row.Name);
		  return { label: row.Name, isJunior };
		}
	  } catch {}
	  // Heuristique sur le nom du tournoi
	  return { label: `Cat. ${categoryId}`, isJunior: false };
	}

	// ── Helper : label de catégorie depuis le nom du tournoi ──────────────────
	function isJuniorTournament(tournName) {
	  return /junior|juniors/i.test(tournName);
	}

	// ── Mode sans année : récap global + boutons d'années ──────────────────────
	if (!annee) {
	  const s = openSaveDb();
	  if (!s) return interaction.editReply({ embeds: [err('Base de données non disponible.')] });
	  try {
		// Récupérer TOUS les Ids de tournois correspondant au nom
		// Vérifier si TournamentCategory a une colonne Name avant de l'utiliser
		const tcCols = s.prepare('PRAGMA table_info(TournamentCategory)').all().map(c => c.name);
		const hasTcName = tcCols.includes('Name');
		const catNameSel = hasTcName ? 'tc.Name AS CatName' : 'NULL AS CatName';
		const tournois = s.prepare(`
		  SELECT t.Id, t.Name, t.CategoryId, ${catNameSel}
		  FROM Tournament t
		  LEFT JOIN TournamentCategory tc ON tc.Id = t.CategoryId
		  WHERE t.Name LIKE ? COLLATE NOCASE
		  ORDER BY t.CategoryId ASC
		`).all(`%${nomTournoi}%`);

		if (!tournois.length)
		  return interaction.editReply({ embeds: [err(`Tournoi introuvable : **${nomTournoi}**\nEssaie un nom plus précis (ex: \`Roland Garros\`, \`Wimbledon\`, \`US Open\`...)`)] });

		// ── Classifier chaque tournoi : ATP vs Junior
		const isTournJunior = (t) =>
		  /junior|juniors/i.test(t.Name) ||
		  /junior|juniors/i.test(t.CatName ?? '') ||
		  (!TOURN_CAT[t.CategoryId] && /junior|juniors/i.test(t.CatName ?? ''));

		const atpTournois    = tournois.filter(t => !isTournJunior(t));
		const juniorTournois = tournois.filter(t => isTournJunior(t));

		// Déterminer quel(s) circuit(s) utiliser selon les participations réelles du joueur
		const atpIds    = atpTournois.map(t => t.Id);
		const juniorIds = juniorTournois.map(t => t.Id);
		const allIds    = tournois.map(t => t.Id);

		const hasParticipation = (ids) => {
		  if (!ids.length) return false;
		  const ph2 = ids.map(() => '?').join(',');
		  return !!s.prepare(`SELECT 1 FROM TournamentResult WHERE TournamentId IN (${ph2}) AND PlayerId=? LIMIT 1`).get(...ids, tmId);
		};

		const hasAtp    = hasParticipation(atpIds);
		const hasJunior = hasParticipation(juniorIds);

		if (!hasAtp && !hasJunior) {
		  const refTourn = tournois[0];
		  return interaction.editReply({ embeds: [
			new EmbedBuilder()
			  .setColor(COLOR.blue)
			  .setTitle(`🎾 ${refTourn.Name}`)
			  .setDescription(`**${pDisplayName}** n'a jamais participé à **${refTourn.Name}**.`)
			  .setTimestamp(),
		  ] });
		}

		// Si le joueur a des participations dans les deux circuits, afficher les deux sections
		// Sinon, afficher uniquement le circuit concerné
		const buildCircuitBlock = (ids, circuitIsJunior) => {
		  if (!ids.length) return null;
		  const ph2 = ids.map(() => '?').join(',');
		  const participations = s.prepare(`
			SELECT tr.TournamentId, tr.Year, tr.RoundReached, tr.MoneyWon, tr.PointsMain, tr.EntryRank
			FROM TournamentResult tr
			WHERE tr.TournamentId IN (${ph2}) AND tr.PlayerId = ?
			ORDER BY tr.Year ASC
		  `).all(...ids, tmId);
		  if (!participations.length) return null;

		  const tag   = circuitIsJunior ? '🎓 Junior' : '🏆 ATP';
		  const emoji = circuitIsJunior ? '🎓' : '🎾';

		  const titles     = participations.filter(p => p.RoundReached === -1).length;
		  const finals     = participations.filter(p => p.RoundReached === 0).length;
		  const semis      = participations.filter(p => p.RoundReached === 1).length;
		  const qf         = participations.filter(p => p.RoundReached === 2).length;
		  const totalMoney = participations.reduce((acc, p) => acc + (p.MoneyWon ?? 0), 0);
		  const totalPts   = participations.reduce((acc, p) => acc + (p.PointsMain ?? 0), 0);
		  const bestResult = participations.reduce((best, p) => p.RoundReached < best ? p.RoundReached : best, 99);

		  const matchStats = s.prepare(`
			SELECT
			  SUM(CASE WHEN (m.Player1Id=? AND m.Outcome=2) OR (m.Player2Id=? AND m.Outcome=3) THEN 1 ELSE 0 END) AS wins,
			  SUM(CASE WHEN (m.Player1Id=? AND m.Outcome=3) OR (m.Player2Id=? AND m.Outcome=2) THEN 1 ELSE 0 END) AS losses
			FROM Match m
			WHERE m.TournamentId IN (${ph2}) AND (m.Player1Id=? OR m.Player2Id=?) AND m.Outcome IN (2,3)
		  `).get(tmId, tmId, tmId, tmId, ...ids, tmId, tmId);

		  const wins   = matchStats?.wins ?? 0;
		  const losses = matchStats?.losses ?? 0;
		  const wr     = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : '0';

		  const yearLines = participations.map(p => {
			const rrLabel = ROUND_LABEL[String(p.RoundReached)] ?? `Tour ${p.RoundReached}`;
			const money   = p.MoneyWon > 0 ? ` · ${p.MoneyWon.toLocaleString('fr-FR')} $` : '';
			const pts     = p.PointsMain > 0 ? ` · ${p.PointsMain} pts` : '';
			return `**${p.Year}** — ${rrLabel}${money}${pts}`;
		  }).join('\n');

		  // Boutons filtrés (années avec matchs dispo)
		  const participationsWithMatches = participations.filter(p => {
			const cnt = s.prepare(`
			  SELECT COUNT(*) AS c FROM Match
			  WHERE TournamentId = ? AND CAST(strftime('%Y', Date, 'unixepoch') AS INTEGER) = ?
				AND (Player1Id = ? OR Player2Id = ?) AND Outcome IN (2, 3)
			`).get(p.TournamentId, p.Year, tmId, tmId);
			return (cnt?.c ?? 0) > 0;
		  });

		  return { tag, emoji, titles, finals, semis, qf, totalMoney, totalPts, bestResult, wins, losses, wr, yearLines, participations, participationsWithMatches };
		};

		const atpBlock    = hasAtp    ? buildCircuitBlock(atpIds,    false) : null;
		const juniorBlock = hasJunior ? buildCircuitBlock(juniorIds, true)  : null;

		// Choisir le bloc "principal" à afficher (ATP prioritaire, sinon Junior)
		const mainBlock  = atpBlock ?? juniorBlock;
		const refTourn   = (atpBlock ? atpTournois : juniorTournois)[0];
		const isJunior   = !atpBlock;
		const circuitTag = isJunior ? '🎓 Junior' : '🏆 ATP';
		const _normCatId = isJunior ? null : normalizeTournCat(refTourn?.CategoryId, refTourn?.Name);
		const catEmoji   = isJunior ? '🎓' : (TOURN_CAT_EMOJI[_normCatId] ?? '🎾');
		const { label: catLabel } = isJunior ? { label: 'Junior' } : (TOURN_CAT[_normCatId] ? { label: TOURN_CAT[_normCatId] } : resolveCatLabel(s, refTourn?.CategoryId));

		const embed = new EmbedBuilder()
		  .setColor(mainBlock.titles > 0 ? COLOR.gold : COLOR.tennis)
		  .setTitle(`${catEmoji} ${refTourn.Name} — Bilan carrière`)
		  .setDescription(`Statistiques de **${pDisplayName}** · ${catLabel} · **${circuitTag}**`)
		  .addFields(
			{ name: '📅 Éditions',              value: `**${mainBlock.participations.length}** participation${mainBlock.participations.length > 1 ? 's' : ''}`, inline: true },
			{ name: `🏆 Titres ${circuitTag}`,  value: `**${mainBlock.titles}**`,  inline: true },
			{ name: `🥈 Finales ${circuitTag}`, value: `**${mainBlock.finals}**`,  inline: true },
			{ name: '🥉 Demi-finales',          value: `**${mainBlock.semis}**`,   inline: true },
			{ name: '⚡ Quarts de finale',       value: `**${mainBlock.qf}**`,      inline: true },
			{ name: '🎯 Meilleur résultat',      value: ROUND_LABEL[String(mainBlock.bestResult)] ?? `Tour ${mainBlock.bestResult}`, inline: true },
			{ name: `🎾 Bilan matchs`,           value: `**${mainBlock.wins}V / ${mainBlock.losses}D** (${mainBlock.wr}% winrate)`, inline: true },
			{ name: '💰 Prize money total',      value: mainBlock.totalMoney > 0 ? mainBlock.totalMoney.toLocaleString('fr-FR') + ' $' : '—', inline: true },
			{ name: isJunior ? '📊 Points Junior totaux' : '📊 Points ATP totaux', value: mainBlock.totalPts > 0 ? mainBlock.totalPts.toLocaleString() : '—', inline: true },
		  )
		  .setFooter({ text: 'Tennis Manager 2026 · /tournoi — Clique sur une année pour le détail du parcours' })
		  .setTimestamp();

		if (mainBlock.yearLines)
		  embed.addFields({ name: '📋 Historique par édition', value: mainBlock.yearLines.length <= 1024 ? mainBlock.yearLines : mainBlock.yearLines.slice(0, 1021) + '…' });

		// Si le joueur a aussi des participations dans l'autre circuit, ajouter une section info
		if (atpBlock && juniorBlock) {
		  const juniorYears = juniorBlock.participations.map(p => p.Year).join(', ');
		  embed.addFields({ name: '🎓 Participations Junior également', value: `Années : **${juniorYears}** — utilise \`/tournoi ${nomTournoi} annee:[année]\` pour le détail.`, inline: false });
		}

		// Boutons des années du circuit principal
		const components = [];
		for (let i = 0; i < Math.min(mainBlock.participationsWithMatches.length, 25); i += 5) {
		  const row = new ActionRowBuilder();
		  for (const p of mainBlock.participationsWithMatches.slice(i, i + 5)) {
			row.addComponents(
			  new ButtonBuilder()
				.setCustomId(`tournoi_year:${p.TournamentId}:${p.Year}:${tmId}`)
				.setLabel(String(p.Year))
				.setStyle(ButtonStyle.Secondary)
			);
		  }
		  components.push(row);
		}

		return interaction.editReply({ embeds: [embed], components });
	  } finally {
		s.close();
	  }
	}

	// ── Mode avec année : parcours détaillé ────────────────────────────────────
	const s = openSaveDb();
	if (!s) return interaction.editReply({ embeds: [err('Base de données non disponible.')] });

	try {
	  const tourn = s.prepare(`
		SELECT Id, Name, CategoryId FROM Tournament
		WHERE Name LIKE ? COLLATE NOCASE
		ORDER BY CategoryId ASC LIMIT 1
	  `).get(`%${nomTournoi}%`);

	  if (!tourn)
		return interaction.editReply({ embeds: [err(`Tournoi introuvable : **${nomTournoi}**\nEssaie un nom plus précis (ex: \`Roland Garros\`, \`Wimbledon\`, \`US Open\`...)`)] });

	  const _normCatId2 = normalizeTournCat(tourn.CategoryId, tourn.Name);
	  const { label: catLabel, isJunior: catIsJunior } = TOURN_CAT[_normCatId2] ? { label: TOURN_CAT[_normCatId2], isJunior: false } : resolveCatLabel(s, tourn.CategoryId);
	  const isJunior   = catIsJunior || isJuniorTournament(tourn.Name);
	  const catEmoji   = isJunior ? '🎓' : (TOURN_CAT_EMOJI[_normCatId2] ?? '🎾');
	  const circuitTag = isJunior ? '🎓 Junior' : '🏆 ATP';
	  const ptsLabel   = isJunior ? 'Points Junior' : 'Points ATP';

	  const result = s.prepare(`
		SELECT tr.RoundReached, tr.EntryMode, tr.MoneyWon, tr.PointsMain, tr.EntryRank
		FROM TournamentResult tr
		WHERE tr.TournamentId = ? AND tr.PlayerId = ? AND tr.Year = ?
	  `).get(tourn.Id, tmId, annee);

	  if (!result) {
		return interaction.editReply({ embeds: [
		  new EmbedBuilder()
			.setColor(COLOR.blue)
			.setTitle(`${catEmoji} ${tourn.Name} ${annee}`)
			.setDescription(`**${pDisplayName}** n'a pas participé à ce tournoi en **${annee}**.`)
			.setTimestamp(),
		] });
	  }

	  // Tous les matchs du joueur dans ce tournoi/année
	  const matches = s.prepare(`
		SELECT m.Round, m.Outcome, m.Player1Id, m.Player2Id,
			   m.Player1Set1Score, m.Player2Set1Score,
			   m.Player1Set2Score, m.Player2Set2Score,
			   m.Player1Set3Score, m.Player2Set3Score,
			   m.Player1Set4Score, m.Player2Set4Score,
			   m.Player1Set5Score, m.Player2Set5Score,
			   p1.Firstname AS P1First, p1.Lastname AS P1Last,
			   p2.Firstname AS P2First, p2.Lastname AS P2Last
		FROM Match m
		LEFT JOIN TennisPlayer p1 ON m.Player1Id = p1.Id
		LEFT JOIN TennisPlayer p2 ON m.Player2Id = p2.Id
		WHERE m.TournamentId = ? AND CAST(strftime('%Y', m.Date, 'unixepoch') AS INTEGER) = ?
		  AND (m.Player1Id = ? OR m.Player2Id = ?)
		  AND m.Outcome IN (2, 3)
		ORDER BY m.Round DESC
	  `).all(tourn.Id, annee, tmId, tmId);

	  const MATCH_ROUND_LABEL = {
		'0': '🥈 Finale',      '1': '🥉 Demi-finale',
		'2': '⚡ Quart',        '3': '🎾 8ème',
		'4': '🎾 16ème',        '5': '🎾 32ème',
		'6': '🎾 64ème',        '7': '🔸 Qualif.',
		'8': '🔸 Qualif.',      '9': '🔸 Qualif.',
	  };
	  const ENTRY_MODE = { 0: 'Direct', 1: 'Wild Card', 2: 'Qualifié', 3: 'Lucky Loser', 4: 'Invité', 5: 'Protégé' };

	  const matchLines = matches.map(m => {
		const isP1    = m.Player1Id === tmId;
		const oppName = isP1
		  ? (m.P2First ? `${m.P2First} ${m.P2Last}` : 'Inconnu')
		  : (m.P1First ? `${m.P1First} ${m.P1Last}` : 'Inconnu');
		const won = (isP1 && m.Outcome === 2) || (!isP1 && m.Outcome === 3);
		const sets = [
		  [m.Player1Set1Score, m.Player2Set1Score],
		  [m.Player1Set2Score, m.Player2Set2Score],
		  [m.Player1Set3Score, m.Player2Set3Score],
		  [m.Player1Set4Score, m.Player2Set4Score],
		  [m.Player1Set5Score, m.Player2Set5Score],
		].filter(([a, b]) => a !== null && b !== null);
		const scoreStr = sets.map(([a, b]) => isP1 ? `${a}-${b}` : `${b}-${a}`).join('  ');
		const roundLabel = m.Round === 0 && result.RoundReached === -1
		  ? '🏆 Finale (Victoire)'
		  : (MATCH_ROUND_LABEL[String(m.Round)] ?? `Tour ${m.Round}`);
		return `${won ? '✅' : '❌'} **${roundLabel}** — ${won ? 'bat' : 'perd vs'} **${oppName}**${scoreStr ? `  \`${scoreStr}\`` : ''}`;
	  });

	  const rrLabel  = ROUND_LABEL[String(result.RoundReached)] ?? `Tour ${result.RoundReached}`;
	  const entryStr = ENTRY_MODE[result.EntryMode] ?? `Mode ${result.EntryMode}`;
	  const rankStr  = result.EntryRank > 0 ? ` (#${result.EntryRank} à l'entrée)` : '';

	  const summaryLines = [
		`🏁 **Résultat :** ${rrLabel}`,
		`🎟️ **Entrée :** ${entryStr}${rankStr}`,
		result.MoneyWon > 0 ? `💰 **Prize money :** ${result.MoneyWon.toLocaleString('fr-FR')} $` : null,
		result.PointsMain > 0 ? `📊 **${ptsLabel} :** ${result.PointsMain}` : null,
	  ].filter(Boolean).join('\n');

	  const embed = new EmbedBuilder()
		.setColor(result.RoundReached === -1 ? COLOR.gold : COLOR.tennis)
		.setTitle(`${catEmoji} ${tourn.Name} ${annee} · ${circuitTag}`)
		.setDescription(`Parcours de **${pDisplayName}** · ${catLabel}`)
		.addFields({ name: '📋 Résumé', value: summaryLines, inline: false })
		.setFooter({ text: 'Tennis Manager 2026 · /tournoi' })
		.setTimestamp();

	  if (matchLines.length > 0) {
		const full = matchLines.join('\n');
		embed.addFields({ name: '🗓️ Matchs', value: full.length <= 1024 ? full : full.slice(0, 1021) + '…', inline: false });
	  } else {
		embed.addFields({ name: '🗓️ Matchs', value: '_Détail non disponible_', inline: false });
	  }

	  return interaction.editReply({ embeds: [embed] });

	} finally {
	  s.close();
	}
  }

  if (cmd === 'admin') {
		const sub = interaction.options.getSubcommand();

		if (sub === 'donner_coins') {
		  const target = interaction.options.getUser('joueur');
		  const amount = interaction.options.getInteger('montant');
		  const reason = interaction.options.getString('raison') ?? 'Don admin';
		  if (!await db.exists(target.id)) return interaction.reply({ embeds: [err('Joueur non inscrit.')], ephemeral: true });
		  await db.addCoins(target.id, amount, reason);
		  return interaction.reply({ embeds: [ok('Coins ajoutés', `**+${amount} 🪙** → <@${target.id}>\n*${reason}*`)], ephemeral: true });
		}

		if (sub === 'retirer_coins') {
		  const target = interaction.options.getUser('joueur');
		  const amount = interaction.options.getInteger('montant');
		  const reason = interaction.options.getString('raison') ?? 'Retrait admin';
		  if (!await db.exists(target.id)) return interaction.reply({ embeds: [err('Joueur non inscrit.')], ephemeral: true });
		  if (!await db.removeCoins(target.id, amount, reason)) return interaction.reply({ embeds: [err('Solde insuffisant.')], ephemeral: true });
		  return interaction.reply({ embeds: [ok('Coins retirés', `**-${amount} 🪙** → <@${target.id}>\n*${reason}*`)], ephemeral: true });
		}

		if (sub === 'reload_db') {
		  await interaction.deferReply({ ephemeral: true });
		  seasonDbReady = false;
		  try {
			await r2Download();
			seasonDbReady = true;
			const info = getSaveDbInfo();
			// Distribuer les récompenses tournois automatiquement
			try {
			  const rewarded = await checkAndRewardResults(interaction.channel);
			  if (rewarded?.length) console.log(`[Rewards] ${rewarded.length} joueur(s) récompensé(s) après reload`);
			} catch(re) { console.error('[Rewards] Erreur:', re.message); }
			return interaction.editReply({ embeds: [ok('Save.db rechargé !',
			  info
				? `📅 Date : **${info.date}** | 👤 **${info.mainPlayer}** | 📦 **${info.size} Mo**`
				: 'Rechargé avec succès.'
			)]});
		  } catch (e) {
			return interaction.editReply({ embeds: [err(`Échec du rechargement : ${e.message}`)] });
		  }
		}

		if (sub === 'check_rewards') {
		  await interaction.deferReply({ ephemeral: false });
		  try {
			const rewarded = await checkAndRewardResults(interaction.channel);
			if (!rewarded?.length)
			  return interaction.editReply({ embeds: [ok('Récompenses vérifiées', 'Aucun nouveau résultat à récompenser.')] });
			const summary = rewarded.map(n => `• **\${n.name}** : +\${n.total.toLocaleString()} 🪙`).join('\n');
			return interaction.editReply({ embeds: [ok(`✅ \${rewarded.length} joueur(s) récompensé(s)`, summary)] });
		  } catch(e) {
			return interaction.editReply({ embeds: [err(`Erreur : \${e.message}`)] });
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

		if (sub === 'recap_boost') {
		  await interaction.deferReply({ ephemeral: true });
		  return sendRecapBoost(interaction, true);
		}

		if (sub === 'auto_upgrade_all') {
		  await interaction.deferReply({ ephemeral: true });
		  try {
			await runAutoUpgrade(interaction.channel);
			return interaction.editReply({ embeds: [ok('Auto-Upgrade déclenché', 'L\'auto-upgrade a été exécuté pour tous les joueurs actifs. Consulte `/admin recap_boost` pour voir les boosts appliqués.')] });
		  } catch (e) {
			return interaction.editReply({ embeds: [err(`Erreur auto-upgrade : ${e.message}`)] });
		  }
		}

		if (sub === 'set_photo') {
		  const target = interaction.options.getUser('joueur');
		  const url    = interaction.options.getString('url');
		  if (!await db.exists(target.id))
			return interaction.reply({ embeds: [err(`**${target.username}** n'a pas de joueur inscrit.`)], ephemeral: true });
		  // Validation basique de l'URL
		  if (!/^https?:\/\/.+\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i.test(url))
			return interaction.reply({ embeds: [err('URL invalide. Utilise un lien direct vers une image (png, jpg, gif, webp).')], ephemeral: true });
		  await db.setPhoto(target.id, url);
		  return interaction.reply({
			embeds: [
			  new EmbedBuilder()
				.setColor(COLOR.green)
				.setTitle('🖼️ Photo de personnage mise à jour')
				.setDescription(`Photo associée à <@${target.id}> avec succès.\nElle sera visible dans \`/profil\`, \`/attributs\` et \`/stats\`.`)
				.setThumbnail(url)
				.setFooter({ text: 'Pour retirer la photo, utilise /admin set_photo avec une URL vide.' })
			],
			ephemeral: true
		  });
		}
	  }

  // ── /tops ─────────────────────────────────────────────────────────────────────
  if (cmd === 'tops') {
    await interaction.deferReply();

    if (!seasonDbReady)
      return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

    const sub = interaction.options.getSubcommand();

    // ── /tops surface ────────────────────────────────────────────────────────
    if (sub === 'surface') {
      const surfFilter = interaction.options.getInteger('surface'); // null = toutes
      const s = openSaveDb();
      if (!s) return interaction.editReply({ embeds: [err('Base de données non disponible.')] });
      try {
        // Récupérer les tm_player_id des joueurs de la simulation
        const { data: simPlayers } = await supabase
          .from('players')
          .select('tm_player_id, ingame_name')
          .not('tm_player_id', 'is', null);

        if (!simPlayers || !simPlayers.length)
          return interaction.editReply({ embeds: [err('Aucun joueur de la simulation trouvé.')] });

        const simIds = simPlayers.map(p => p.tm_player_id);
        const simMap = Object.fromEntries(simPlayers.map(p => [p.tm_player_id, p.ingame_name]));
        const placeholders = simIds.map(() => '?').join(',');

        // Surfaces à afficher : soit la surface demandée, soit toutes
        const surfaces = surfFilter ? [surfFilter] : [1, 2, 3, 4];

        const embed = new EmbedBuilder()
          .setColor(COLOR.tennis)
          .setTitle(surfFilter
            ? `🎾 Top simulation — ${SURFACE_LABEL[surfFilter] ?? `Surface ${surfFilter}`}`
            : '🎾 Top simulation par surface')
          .setFooter({ text: 'Tennis Manager 2026 · /tops surface · min. 10 matchs · joueurs simulation uniquement' })
          .setTimestamp();

        let hasAny = false;
        for (const surf of surfaces) {
          const rows = s.prepare(`
            SELECT
              tp.Id AS tmId,
              tp.Firstname || ' ' || tp.Lastname AS name,
              tp.Country,
              SUM(tps.MatchPlayed) AS played,
              SUM(tps.MatchWon)    AS won
            FROM TennisPlayerStatistics tps
            JOIN TennisPlayer tp ON tp.Id = tps.PlayerId
            WHERE tps.Circuit = 0
              AND tps.Surface = ?
              AND tp.Id IN (${placeholders})
            GROUP BY tps.PlayerId
            HAVING played >= 10
            ORDER BY (CAST(won AS REAL) / played) DESC
            LIMIT 10
          `).all(surf, ...simIds);

          if (!rows.length) continue;
          hasAny = true;

          const lines = rows.map((r, i) => {
            const wr       = pct(r.won, r.played);
            const pos      = `\`${i + 1}.\``;
            const dispName = simMap[r.tmId] ?? r.name;
            return `${pos} **${dispName}** (${r.Country ?? '??'}) — **${r.won}V** / ${r.played - r.won}D — ${wr}`;
          }).join('\n');

          embed.addFields({
            name: SURFACE_LABEL[surf] ?? `Surface ${surf}`,
            value: lines,
          });
        }

        if (!hasAny)
          embed.setDescription('*Aucune donnée disponible (min. 10 matchs) pour les joueurs de la simulation.*');

        return interaction.editReply({ embeds: [embed] });
      } finally { s.close(); }
    }

    // ── /tops gc ─────────────────────────────────────────────────────────────
    if (sub === 'gc') {
      const s = openSaveDb();
      if (!s) return interaction.editReply({ embeds: [err('Base de données non disponible.')] });
      try {
        // Récupérer les tm_player_id des joueurs de la simulation
        const { data: simPlayers } = await supabase
          .from('players')
          .select('tm_player_id, ingame_name')
          .not('tm_player_id', 'is', null);

        if (!simPlayers || !simPlayers.length)
          return interaction.editReply({ embeds: [err('Aucun joueur de la simulation trouvé.')] });

        const simIds  = simPlayers.map(p => p.tm_player_id);
        const simMap  = Object.fromEntries(simPlayers.map(p => [p.tm_player_id, p.ingame_name]));
        const ph      = simIds.map(() => '?').join(',');

        // Exclusion des catégories Junior (même logique que le reste du bot)
        const juniorCatIds = getJuniorCategoryIds(s);
        const { clause: jExcl, ids: jIds } = buildJuniorExcludeClause(juniorCatIds);

        // Vérifier si TournamentCategory a une colonne Circuit (TM2026)
        const tcCols = s.prepare('PRAGMA table_info(TournamentCategory)').all().map(c => c.name);
        const hasTcCircuit = tcCols.includes('Circuit');

        // Filtre GC ATP : tc.Type=1 ET circuit non-junior (Circuit IS NULL ou Circuit=0)
        // + fallback nom de tournoi pour les saves sans TournamentCategory correcte
        const gcAtpCondition = hasTcCircuit
          ? `((tc.Type = 1 AND (tc.Circuit IS NULL OR tc.Circuit = 0)) OR lower(t.Name) LIKE ?)`
          : `(tc.Type = 1 OR lower(t.Name) LIKE ?)`;

        // Les 4 GC avec leur label et filtre SQL
        const GC_LIST = [
          { label: '🔴 Roland Garros',    like: '%roland%' },
          { label: '🟢 Wimbledon',         like: '%wimbledon%' },
          { label: '🔵 US Open',           like: '%us open%' },
          { label: '🟡 Australian Open',   like: '%australian%' },
        ];

        const embed = new EmbedBuilder()
          .setColor(COLOR.gold)
          .setTitle('🏆 Grand Chelem ATP — Palmarès simulation')
          .setFooter({ text: 'Tennis Manager 2026 · /tops gc · ATP uniquement · joueurs simulation' })
          .setTimestamp();

        let hasAny = false;

        for (const gc of GC_LIST) {
          // Params : [gc.like, ...jIds (pour jExcl), ...simIds]
          const rows = s.prepare(`
            SELECT
              tp.Id AS tmId,
              tp.Firstname || ' ' || tp.Lastname AS name,
              tp.Country,
              COUNT(CASE WHEN tr.RoundReached = -1 THEN 1 END) AS titres,
              COUNT(CASE WHEN tr.RoundReached =  0 THEN 1 END) AS finales,
              COUNT(CASE WHEN tr.RoundReached =  1 THEN 1 END) AS demis,
              COUNT(CASE WHEN tr.RoundReached =  2 THEN 1 END) AS quarts,
              COUNT(*) AS participations
            FROM TournamentResult tr
            JOIN Tournament t    ON t.Id  = tr.TournamentId
            JOIN TennisPlayer tp ON tp.Id = tr.PlayerId
            LEFT JOIN TournamentCategory tc ON tc.Id = t.CategoryId
            WHERE ${gcAtpCondition}
              AND ${jExcl}
              AND tp.Id IN (${ph})
            GROUP BY tr.PlayerId
            HAVING participations >= 1
            ORDER BY titres DESC, finales DESC, demis DESC, quarts DESC
            LIMIT 15
          `).all(gc.like, ...jIds, ...simIds);

          if (!rows.length) continue;
          hasAny = true;

          const lines = rows.map((r, i) => {
            const dispName = simMap[r.tmId] ?? r.name;
            const parts = [];
            if (r.titres  > 0) parts.push(`${r.titres} titre${r.titres > 1 ? 's' : ''}`);
            if (r.finales > 0) parts.push(`${r.finales} finale${r.finales > 1 ? 's' : ''}`);
            if (r.demis   > 0) parts.push(`${r.demis} demi${r.demis > 1 ? 's' : ''}`);
            if (r.quarts  > 0) parts.push(`${r.quarts} quart${r.quarts > 1 ? 's' : ''}`);
            const detail = parts.join(' · ') || 'Participations';
            return `\`${i + 1}.\` **${dispName}** (${r.Country ?? '??'}) — ${detail} *(${r.participations} part.)*`;
          }).join('\n');

          embed.addFields({ name: gc.label, value: lines.slice(0, 1024) });
        }

        if (!hasAny)
          embed.setDescription('*Aucune donnée Grand Chelem ATP disponible pour les joueurs de la simulation.*');

        // Bouton "Moi uniquement" — parcours GC par année du joueur lié
        const gcBtn = new ButtonBuilder()
          .setCustomId('topsgc_moi')
          .setLabel('Moi uniquement')
          .setEmoji('👤')
          .setStyle(ButtonStyle.Secondary);
        const gcRow = new ActionRowBuilder().addComponents(gcBtn);

        return interaction.editReply({ embeds: [embed], components: [gcRow] });
      } finally { s.close(); }
    }
  }

  // ── /saison ───────────────────────────────────────────────────────────────────
  if (cmd === 'saison') {
	await interaction.deferReply();

	if (!seasonDbReady)
	  return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

	const annee    = interaction.options.getInteger('annee');
	const nomQuery = interaction.options.getString('nom');
	const userOpt  = interaction.options.getUser('joueur');

	// ── Résolution du joueur ──────────────────────────────────────────────────
	let tmId, pDisplayName;
	const s0s = openSaveDb();
	if (!s0s) return interaction.editReply({ embeds: [err('Base de données non disponible.')] });
	try {
	  if (nomQuery) {
		const found = getTmPlayerByName(nomQuery.trim());
		if (!found.length)
		  return interaction.editReply({ embeds: [err(`Aucun joueur trouvé pour **"${nomQuery}"** dans le save.db.`)] });
		if (found.length > 1) {
		  const list = found.map((r, i) => `${i+1}. **${r.Firstname} ${r.Lastname}** (${r.Country})`).join('\n');
		  return interaction.editReply({ embeds: [
			new EmbedBuilder().setColor(COLOR.blue)
			  .setTitle('🔍 Plusieurs joueurs trouvés')
			  .setDescription(`${list}\n\nPrécise le prénom + nom complet.`)
		  ] });
		}
		tmId = found[0].Id;
		pDisplayName = `${found[0].Firstname} ${found[0].Lastname}`;
	  } else {
		const target = userOpt ?? interaction.user;
		const player = await db.get(target.id);
		if (!player?.tm_player_id)
		  return interaction.editReply({ embeds: [err(
			target.id === interaction.user.id
			  ? 'Tu n\'as pas de joueur lié. Utilise `/creer-joueur` ou précise un nom avec l\'option `nom`.'
			  : `**${target.username}** n'a pas de joueur lié.`
		  )] });
		tmId = player.tm_player_id;
		const pRow = s0s.prepare('SELECT Firstname, Lastname FROM TennisPlayer WHERE Id=?').get(tmId);
		pDisplayName = pRow ? `${pRow.Firstname} ${pRow.Lastname}` : player.ingame_name ?? `Joueur #${tmId}`;
	  }
	} finally { s0s.close(); }

	// ── Lecture save.db pour les données de la saison ─────────────────────────
	const ss = openSaveDb();
	if (!ss) return interaction.editReply({ embeds: [err('Base de données non disponible.')] });
	try {
	  const tcCols = ss.prepare('PRAGMA table_info(TournamentCategory)').all().map(c => c.name);
	  const hasTcName = tcCols.includes('Name');
	  const catNameSel = hasTcName ? 'tc.Name AS CatName' : 'NULL AS CatName';

	  const results = ss.prepare(`
		SELECT tr.TournamentId, tr.RoundReached, tr.EntryMode, tr.EntryRank,
		       tr.MoneyWon, tr.PointsMain,
		       t.Name AS TournName, t.CategoryId, ${catNameSel},
		       (
		         SELECT tp2.Firstname || ' ' || tp2.Lastname
		         FROM Match m
		         JOIN TennisPlayer tp2 ON tp2.Id = CASE
		           WHEN m.Player1Id = tr.PlayerId THEN m.Player2Id
		           ELSE m.Player1Id
		         END
		         WHERE m.TournamentId = tr.TournamentId
		           AND m.Year = tr.Year
		           AND (m.Player1Id = tr.PlayerId OR m.Player2Id = tr.PlayerId)
		           AND m.Outcome IN (2, 3)
		         ORDER BY m.Date DESC LIMIT 1
		       ) AS OpponentName
		FROM TournamentResult tr
		JOIN Tournament t ON t.Id = tr.TournamentId
		LEFT JOIN TournamentCategory tc ON tc.Id = t.CategoryId
		WHERE tr.PlayerId = ? AND tr.Year = ?
		ORDER BY t.CategoryId ASC, tr.MoneyWon DESC
	  `).all(tmId, annee);

	  if (!results.length) {
		return interaction.editReply({ embeds: [
		  new EmbedBuilder()
			.setColor(COLOR.blue)
			.setTitle(`📅 Saison ${annee} — ${pDisplayName}`)
			.setDescription(`**${pDisplayName}** n'a pas de résultats enregistrés en **${annee}**.`)
			.setTimestamp(),
		] });
	  }

	  const rankEndRow = ss.prepare(`
		SELECT Rank+1 AS Rank, Points FROM Ranking
		WHERE PlayerId=? AND Circuit=0 AND strftime('%Y', Date, 'unixepoch')=?
		ORDER BY Date DESC LIMIT 1
	  `).get(tmId, String(annee));
	  const rankJrEndRow = ss.prepare(`
		SELECT Rank+1 AS Rank, Points FROM Ranking
		WHERE PlayerId=? AND Circuit=1 AND strftime('%Y', Date, 'unixepoch')=?
		ORDER BY Date DESC LIMIT 1
	  `).get(tmId, String(annee));
	  const raceRow = (() => {
	try {
	  return ss.prepare(`
		SELECT Rank+1 AS RaceRank, Points AS RacePoints FROM RaceRanking
		WHERE PlayerId=? AND Circuit=0 AND Year=?
		ORDER BY Year DESC LIMIT 1
	  `).get(tmId, annee);
	} catch {
	  try {
		return ss.prepare(`
		  SELECT RaceRank+1 AS RaceRank, Points AS RacePoints FROM RaceRanking
		  WHERE PlayerId=? AND Circuit=0 AND Year=?
		  ORDER BY Year DESC LIMIT 1
		`).get(tmId, annee);
	  } catch { return null; }
	}
  })();

	  const bilanRow = ss.prepare(`
		SELECT SUM(MatchPlayed) AS played, SUM(MatchWon) AS won
		FROM TennisPlayerStatistics WHERE PlayerId=? AND Year=? AND Circuit=0
	  `).get(tmId, annee);
	  const bilanJrRow = ss.prepare(`
		SELECT SUM(MatchPlayed) AS played, SUM(MatchWon) AS won
		FROM TennisPlayerStatistics WHERE PlayerId=? AND Year=? AND Circuit=1
	  `).get(tmId, annee);

	  const totalPlayed = bilanRow?.played ?? 0;
	  const totalWon   = bilanRow?.won ?? 0;
	  const jrPlayed   = bilanJrRow?.played ?? 0;
	  const jrWon      = bilanJrRow?.won ?? 0;

	  const totalMoney = results.reduce((sum, r) => sum + (r.MoneyWon ?? 0), 0);
	  const totalPts   = results.reduce((sum, r) => sum + (r.PointsMain ?? 0), 0);
	  const titles     = results.filter(r => r.RoundReached === -1).length;
	  const finals     = results.filter(r => r.RoundReached === 0).length;

	  const ROUND_LABEL_S = {
		'-1': '🏆 Titre', '0': '🥈 Finale', '1': '🥉 Demi',
		'2': '⚡ Quart', '3': '🎾 8ème', '4': '🎾 16ème',
		'5': '🎾 32ème', '6': '🎾 64ème', '7': '🔸 Qualif.',
		'8': '🔸 Qualif.', '9': '🔸 Qualif.',
	  };
	  const ENTRY_MODE_S = { 0: '', 1: 'WC', 2: 'Q', 3: 'LL', 4: 'Invité', 5: 'PR' };

	  const isJuniorResult = (r) =>
		/junior|juniors/i.test(r.TournName ?? '') ||
		/junior|juniors/i.test(r.CatName ?? '');

	  const atpResults    = results.filter(r => !isJuniorResult(r));
	  const juniorResults = results.filter(r =>  isJuniorResult(r));

	  const buildResultLines = (rows) => rows.map(r => {
		const rawCat   = normalizeTournCat(r.CategoryId, r.TournName);
		const effCat   = TOURN_CAT_SHORT[rawCat] ? rawCat : categFromPoints(rawCat, r.PointsMain, r.TournName);
		const catEmoji = TOURN_CAT_EMOJI[effCat] ?? (isJuniorResult(r) ? '🎓' : '🎾');
		const catShort = TOURN_CAT_SHORT[effCat] ?? (r.CatName ? r.CatName.slice(0, 10) : `Cat.${r.CategoryId}`);
		const rrLabel  = ROUND_LABEL_S[String(r.RoundReached)] ?? `Tour ${r.RoundReached}`;
		const entryTag = r.EntryMode && ENTRY_MODE_S[r.EntryMode] ? ` *(${ENTRY_MODE_S[r.EntryMode]})*` : '';
		const money    = r.MoneyWon > 0 ? ` · 💵 ${r.MoneyWon.toLocaleString('fr-FR')} $` : '';
		const pts      = r.PointsMain > 0 ? ` · 📊 ${r.PointsMain} pts` : '';
		const oppStr   = r.OpponentName
		  ? (r.RoundReached === -1 ? ` *(bat ${r.OpponentName})*` : ` *(vs ${r.OpponentName})*`)
		  : '';
		return `${catEmoji} **${r.TournName}** \`${catShort}\`${entryTag} → ${rrLabel}${oppStr}${money}${pts}`;
	  });

	  const atpLines    = buildResultLines(atpResults);
	  const juniorLines = buildResultLines(juniorResults);

	  const rankLine = [
		rankEndRow   ? `🏆 ATP **#${rankEndRow.Rank}** · ${(rankEndRow.Points ?? 0).toLocaleString()} pts` : null,
		raceRow      ? `🏁 Race **#${raceRow.RaceRank}** · ${(raceRow.RacePoints ?? 0).toLocaleString()} pts` : null,
		rankJrEndRow ? `🎓 Junior **#${rankJrEndRow.Rank}** · ${(rankJrEndRow.Points ?? 0).toLocaleString()} pts` : null,
	  ].filter(Boolean).join('  ·  ') || '_Classement non disponible_';

	  const bilanLine = [
		totalPlayed > 0 ? `🏆 ATP **${totalWon}V/${totalPlayed - totalWon}D** (${pct(totalWon, totalPlayed)})` : null,
		jrPlayed    > 0 ? `🎓 Junior **${jrWon}V/${jrPlayed - jrWon}D** (${pct(jrWon, jrPlayed)})` : null,
	  ].filter(Boolean).join('  ·  ') || '_Bilan non disponible_';

	  const descLines = [
		rankLine,
		bilanLine,
		totalMoney > 0 ? `💵 Prize money total : **${totalMoney.toLocaleString('fr-FR')} $**` : null,
		totalPts   > 0 ? `📊 Points ATP totaux : **${totalPts.toLocaleString()}**` : null,
	  ].filter(Boolean);

	  const embed = new EmbedBuilder()
		.setColor(titles > 0 ? COLOR.gold : COLOR.tennis)
		.setTitle(`📅 Saison ${annee} — ${pDisplayName}`)
		.setDescription(descLines.join('\n'))
		.addFields(
		  { name: '🏆 Titres', value: `**${titles}**`, inline: true },
		  { name: '🥈 Finales', value: `**${finals}**`, inline: true },
		  { name: '🎾 Tournois', value: `**${results.length}**`, inline: true },
		)
		.setFooter({ text: `Tennis Manager 2026 · /saison` })
		.setTimestamp();

	  // Résultats ATP (chunks si > 1024)
	  if (atpLines.length > 0) {
		let chunk = '';
		let chunkIdx = 1;
		const flushChunk = (label) => { if (chunk) embed.addFields({ name: label, value: chunk }); };
		for (const line of atpLines) {
		  const next = chunk ? chunk + '\n' + line : line;
		  if (next.length > 1020) {
			flushChunk(`🏆 Résultats ATP${atpLines.length > 20 ? ` — partie ${chunkIdx}` : ''}`);
			chunk = line;
			chunkIdx++;
		  } else {
			chunk = next;
		  }
		}
		flushChunk(`🏆 Résultats ATP${chunkIdx > 1 ? ` — partie ${chunkIdx}` : ''} (${atpResults.length})`);
	  }

	  // Résultats Junior
	  if (juniorLines.length > 0) {
		const jrFull = juniorLines.join('\n');
		embed.addFields({ name: `🎓 Résultats Junior (${juniorResults.length})`, value: jrFull.length <= 1024 ? jrFull : jrFull.slice(0, 1021) + '…' });
	  }

	  return interaction.editReply({ embeds: [embed] });
	} finally {
	  ss.close();
	}
  }
}

// ── Helpers recap_boost ────────────────────────────────────────────────────────
async function buildRecapBoostEmbed() {
  const { data: logs, error } = await supabase
	.from('boost_log')
	.select('*')
	.order('created_at', { ascending: true });

  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('📋 Boosts en attente d\'application');

  if (error || !logs || logs.length === 0) {
	embed.setDescription('✅ Aucun boost en attente — save.db à jour !');
	return embed;
  }

  // Grouper par joueur
  const byPlayer = {};
  for (const row of logs) {
	if (!byPlayer[row.discord_id]) byPlayer[row.discord_id] = { name: row.ingame_name, lines: [] };
	const ts = Math.floor(new Date(row.created_at).getTime() / 1000);
	const autoTag = row.auto ? ' 🤖' : '';
	byPlayer[row.discord_id].lines.push(
	  `• **${row.stat_label}** : ${Number(row.from_val).toFixed(1)} → **${Number(row.to_val).toFixed(1)}** \`(-${(row.cost ?? 0).toLocaleString()} 🪙)\`${autoTag} <t:${ts}:R>`
	);
  }

  for (const [discordId, data] of Object.entries(byPlayer)) {
	embed.addFields({ name: `👤 ${data.name} (<@${discordId}>)`, value: data.lines.join('\n') });
  }

  embed.setFooter({ text: `${logs.length} boost(s) au total (🤖 = auto-upgrade) — appuie sur 🗑️ après les avoir appliqués manuellement` });
  return embed;
}

async function sendRecapBoost(interaction, edit = false) {
  const embed = await buildRecapBoostEmbed();
  const row = new ActionRowBuilder().addComponents(
	new ButtonBuilder().setCustomId('recap_boost:refresh').setEmoji('🔄').setLabel('Rafraîchir').setStyle(ButtonStyle.Secondary),
	new ButtonBuilder().setCustomId('recap_boost:clear').setEmoji('🗑️').setLabel('Clear (appliqués)').setStyle(ButtonStyle.Danger),
  );
  const payload = { embeds: [embed], components: [row] };
  if (edit) return interaction.editReply(payload);
  return interaction.reply({ ...payload, ephemeral: true });
}

	// ══════════════════════════════════════════════════════════════════════════════
	//  AUTO-UPGRADE — Amélioration automatique des stats
	//  Déclenchement : à chaque addCoins pour le joueur concerné (réactif).
	//  Filet de sécurité : tick toutes les 30 min pour rattraper les éventuels ratés.
	// ══════════════════════════════════════════════════════════════════════════════

	// Exécute l'auto-upgrade pour un joueur précis (ou tous si discordId=null)
	async function runAutoUpgrade(logChannel, discordId = null) {
	  if (!seasonDbReady) return;

	  let query = supabase
		.from('players')
		.select('discord_id, ingame_name, coins, tm_player_id, boosts, auto_upgrade')
		.eq('auto_upgrade', true)
		.not('tm_player_id', 'is', null);

	  if (discordId) query = query.eq('discord_id', discordId);

	  const { data: players, error } = await query;
	  if (error || !players?.length) return;

	  const s = openSaveDb();
	  if (!s) return;

	  try {
		for (const player of players) {
		  try {
			const p = s.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(player.tm_player_id);
			if (!p) continue;

			const boosts = player.boosts ?? {};
			let coins = player.coins;
			const boostedThisRun = [];

			// Stats boostables triées par coût croissant (la moins chère en priorité)
			const candidates = BOOSTABLE_STATS
			  .map(([key, label]) => {
				const used = boosts[key] ?? 0;
				const baseVal = p[key] ?? 0;
				const curVal = Math.min(baseVal + used, BOOST_ABS_CAP);
				if (used >= BOOST_MAX_PER_STAT) return null;
				if (curVal >= BOOST_ABS_CAP) return null;
				const cost = boostCost(curVal);
				if (!isFinite(cost)) return null;
				return { key, label, used, curVal, cost };
			  })
			  .filter(Boolean)
			  .sort((a, b) => a.cost - b.cost);

			// Vérifie d'abord si le joueur peut se payer au moins un boost
			const affordable = candidates.filter(c => coins >= c.cost);
			if (!affordable.length) continue; // rien à faire pour ce joueur

			for (const cand of candidates) {
			  if (coins < cand.cost) continue;

			  const paid = await db.removeCoins(
				player.discord_id,
				cand.cost,
				`[Auto-Upgrade] ${cand.label} ${cand.curVal.toFixed(1)}→${(cand.curVal + 1).toFixed(1)}`
			  );
			  if (!paid) continue;

			  coins -= cand.cost;
			  boosts[cand.key] = (boosts[cand.key] ?? 0) + 1;
			  await supabase.from('players').update({ boosts }).eq('discord_id', player.discord_id);

			  // Logger dans boost_log — visible dans /admin recap_boost
			  await supabase.from('boost_log').insert({
				discord_id: player.discord_id,
				ingame_name: player.ingame_name ?? 'Inconnu',
				stat_key: cand.key,
				stat_label: cand.label,
				from_val: cand.curVal,
				to_val: cand.curVal + 1,
				cost: cand.cost,
				auto: true,
			  });

			  boostedThisRun.push({ label: cand.label, from: cand.curVal, to: cand.curVal + 1, cost: cand.cost });
			}

			if (boostedThisRun.length && logChannel) {
			  const lines = boostedThisRun.map(b =>
				`⬆️ **${b.label}** : ${b.from.toFixed(1)} → **${b.to.toFixed(1)}** \`(-${b.cost.toLocaleString()} 🪙)\``
			  ).join('\n');
			  const embed = new EmbedBuilder()
				.setColor(COLOR.purple)
				.setTitle('🤖 Auto-Upgrade déclenché')
				.setDescription(
				  `<@${player.discord_id}> — **${player.ingame_name}**\n\n${lines}\n\n` +
				  `💰 Solde restant : **${coins.toLocaleString()} 🪙**`
				)
				.setFooter({ text: 'Auto-Upgrade automatique · désactive avec /auto-upgrade' })
				.setTimestamp();
			  try { await logChannel.send({ embeds: [embed] }); }
			  catch (e) { console.error('[AutoUpgrade] Erreur notif:', e.message); }
			}

			if (boostedThisRun.length) {
			  console.log(`[AutoUpgrade] ${player.ingame_name} — ${boostedThisRun.length} boost(s) appliqué(s)`);
			}
		  } catch (e) {
			console.error(`[AutoUpgrade] Erreur pour ${player.discord_id}:`, e.message);
		  }
		}
	  } finally {
		s.close();
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

	// ── Démarrage du client Discord ──────────────────────────────────────────────
	// Si --deploy est passé en argument, on déploie les commandes PUIS on démarre
	// le bot (comportement Render : la Start Command est toujours "node index.js").
	// Pour un deploy one-shot depuis ta machine : node index.js --deploy --exit

// ── Boutons de navigation rapide du profil ──────────────────────────────────
function buildProfilNavButtons(tmName) {
  const n = tmName.slice(0, 80);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pnav:stats:${n}`)      .setLabel('📊 Stats')       .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`pnav:palmares:${n}`)   .setLabel('🏆 Palmarès')    .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`pnav:historique:${n}`) .setLabel('📅 Historique')  .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`pnav:attributs:${n}`)  .setLabel('📋 Attributs')   .setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pnav:h2h:${n}`)        .setLabel('⚔️ H2H')          .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`pnav:coins:${n}`)      .setLabel('💰 Mes coins')    .setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2];
}

	async function startBot() {
	  if (process.argv.includes('--deploy')) {
		console.log('[Boot] Mode --deploy détecté : déploiement des commandes slash...');
		await deployCommands().catch((e) => {
		  console.error('[Deploy] Erreur lors du déploiement :', e);
		});
		// Si --exit est aussi passé (usage local), on s'arrête là
		if (process.argv.includes('--exit')) {
		  console.log('[Boot] --exit détecté — arrêt après deploy.');
		  process.exit(0);
		}
		console.log('[Boot] Commandes déployées — démarrage du bot...');
	  }

	  if (!process.env.DISCORD_TOKEN) {
		console.error('[Boot] ❌ DISCORD_TOKEN manquant — impossible de démarrer le bot.');
		process.exit(1);
	  }

	  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

	  client.once('ready', () => {
		console.log(`[Discord] ✅ Bot connecté : ${client.user.tag} (ID: ${client.user.id})`);
		console.log(`[Discord] Serveurs : ${client.guilds.cache.size}`);
		// Premier keep-alive immédiat
		keepAlive();

		// ── Auto-Upgrade : init canal + filet de sécurité toutes les 30 min ────────
		const AUTO_UPGRADE_LOG_CHANNEL_ID = process.env.AUTO_UPGRADE_LOG_CHANNEL;
		if (AUTO_UPGRADE_LOG_CHANNEL_ID) {
		  autoUpgradeLogChannel = client.channels.cache.get(AUTO_UPGRADE_LOG_CHANNEL_ID) ?? null;
		}

		// Filet de sécurité : rattrapage toutes les 30 min (les gains normaux déclenchent déjà runAutoUpgrade en réactif via db.addCoins)
		setInterval(() => {
		  runAutoUpgrade(autoUpgradeLogChannel).catch(e =>
			console.error('[AutoUpgrade] Erreur tick rattrapage:', e.message)
		  );
		}, 30 * 60 * 1000);

		console.log('[AutoUpgrade] Mode réactif actif (déclenché sur chaque addCoins) + rattrapage 30 min');
	  });

	  client.on('disconnect', () => console.warn('[Discord] ⚠️  Déconnecté !'));
	  client.on('error',      (e) => console.error('[Discord] Erreur client :', e));
	  client.on('warn',       (w) => console.warn('[Discord] Avertissement :', w));

	  // ══════════════════════════════════════════════════════════════════════════════
	  //  SESSION STORE : données de création de joueur (évite les customId trop longs)
	  // ══════════════════════════════════════════════════════════════════════════════
	
	  // ══════════════════════════════════════════════════════════════════════════════
	  //  ÉTAPES CREER-JOUEUR : modal submit + select menus personnalité
	  // ══════════════════════════════════════════════════════════════════════════════

	  // Étape 2 : modal soumis → afficher directement sélecteur trait 1 (style de jeu supprimé)
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isModalSubmit()) return;
		if (interaction.customId !== 'creer_joueur_modal') return;

		const ingameName  = interaction.fields.getTextInputValue('cj_nom').trim();
		const nationality = interaction.fields.getTextInputValue('cj_pays').trim();

		if (ingameName.length < 2 || ingameName.length > 32)
		  return interaction.reply({ embeds: [err('Le nom doit faire entre 2 et 32 caractères.')], ephemeral: true });
		if (await db.exists(interaction.user.id))
		  return interaction.reply({ embeds: [err('Tu as déjà un joueur ! Utilise `/profil`.')], ephemeral: true });
		if (await db.nameTaken(ingameName))
		  return interaction.reply({ embeds: [err(`Le nom **${ingameName}** est déjà pris.`)], ephemeral: true });

		// Stocker les données en session mémoire
		cjSessions.set(interaction.user.id, { n: ingameName, p: nationality });

		const trait1Select = new StringSelectMenuBuilder()
		  .setCustomId(`cj_t1:${interaction.user.id}`)
		  .setPlaceholder('1er trait de personnalité')
		  .addOptions(
			{ label: '🎲 Opportuniste', value: 'Opportuniste', description: 'Saisit chaque occasion' },
			{ label: '⚖️ Exigeant',     value: 'Exigeant',     description: 'Perfectionniste et rigoureux' },
			{ label: '🌍 Aventurier',   value: 'Aventurier',   description: 'Aime l\'imprévu et la prise de risque' },
			{ label: '🤝 Fidèle',       value: 'Fidèle',       description: 'Loyal, constant dans l\'effort' },
			{ label: '🚀 Ambitieux',    value: 'Ambitieux',    description: 'Vise toujours plus haut' },
		  );

		return interaction.reply({
		  ephemeral: true,
		  embeds: [new EmbedBuilder().setColor(COLOR.tennis)
			.setTitle('🎾 Créer ton joueur — Personnalité (1/3)')
			.setDescription(`**${ingameName}** · 🌍 ${nationality}\n\n**1er trait de personnalité**`)],
		  components: [new ActionRowBuilder().addComponents(trait1Select)],
		});
	  });

	  // Étape 4 : trait 1 choisi → afficher sélecteur trait 2
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isStringSelectMenu()) return;
		if (!interaction.customId.startsWith('cj_t1:')) return;

		const userId4 = interaction.customId.split(':')[1];
		const sess4 = cjSessions.get(userId4) ?? cjSessions.get(interaction.user.id);
		if (!sess4) return interaction.update({ embeds: [err('Session expirée, relance `/creer-joueur`.')], components: [] });
		const trait1 = interaction.values[0];
		cjSessions.set(interaction.user.id, { ...sess4, t1: trait1 });

		const trait2Select = new StringSelectMenuBuilder()
		  .setCustomId(`cj_t2:${interaction.user.id}`)
		  .setPlaceholder('2e trait de personnalité')
		  .addOptions(
			{ label: '💙 Sensible',     value: 'Sensible',     description: 'Émotif, ressent fortement la pression' },
			{ label: '🔥 Sanguin',      value: 'Sanguin',      description: 'Impulsif, joue avec les émotions' },
			{ label: '💪 Déterminé',    value: 'Déterminé',    description: 'Rien ne l\'arrête' },
			{ label: '😌 Détendu',      value: 'Détendu',      description: 'Relax, ne se laisse pas déborder' },
			{ label: '🧘 Serein',       value: 'Serein',       description: 'Calme intérieur, mental solide' },
		  );

		return interaction.update({
		  embeds: [new EmbedBuilder().setColor(COLOR.tennis)
			.setTitle('🎾 Créer ton joueur — Personnalité (2/3)')
			.setDescription(
			  `**${sess4.n}** · 🌍 ${sess4.p}\n\n` +
			  `✅ Trait 1 : **${trait1}**\n\n**2e trait de personnalité**`
			)],
		  components: [new ActionRowBuilder().addComponents(trait2Select)],
		});
	  });

	  // Étape 5 : trait 2 choisi → afficher sélecteur trait 3
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isStringSelectMenu()) return;
		if (!interaction.customId.startsWith('cj_t2:')) return;

		const userId5 = interaction.customId.split(':')[1];
		const sess5 = cjSessions.get(userId5) ?? cjSessions.get(interaction.user.id);
		if (!sess5) return interaction.update({ embeds: [err('Session expirée, relance `/creer-joueur`.')], components: [] });
		const trait2 = interaction.values[0];
		cjSessions.set(interaction.user.id, { ...sess5, t2: trait2 });

		const trait3Select = new StringSelectMenuBuilder()
		  .setCustomId(`cj_t3:${interaction.user.id}`)
		  .setPlaceholder('3e trait de personnalité')
		  .addOptions(
			{ label: '🎙️ Charismatique', value: 'Charismatique', description: 'Fédérateur, charisme naturel' },
			{ label: '📖 Posé',          value: 'Posé',          description: 'Réfléchi, jamais dans la précipitation' },
			{ label: '👂 Attentif',      value: 'Attentif',      description: 'À l\'écoute, lit bien le jeu adverse' },
			{ label: '🛡️ Responsable',  value: 'Responsable',   description: 'Fiable, ne lâche jamais rien' },
			{ label: '🏆 Compétiteur',   value: 'Compétiteur',   description: 'Vit pour gagner' },
		  );

		return interaction.update({
		  embeds: [new EmbedBuilder().setColor(COLOR.tennis)
			.setTitle('🎾 Créer ton joueur — Personnalité (3/3)')
			.setDescription(
			  `**${sess5.n}** · 🌍 ${sess5.p}\n\n` +
			  `✅ Trait 1 : **${sess5.t1}**\n✅ Trait 2 : **${trait2}**\n\n**3e trait de personnalité**`
			)],
		  components: [new ActionRowBuilder().addComponents(trait3Select)],
		});
	  });

	  // Étape 6 : trait 3 choisi → modal caractéristiques physiques
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isStringSelectMenu()) return;
		if (!interaction.customId.startsWith('cj_t3:')) return;

		const userId6 = interaction.customId.split(':')[1];
		const prev = cjSessions.get(userId6) ?? cjSessions.get(interaction.user.id);
		if (!prev) return interaction.update({ embeds: [err('Session expirée, relance `/creer-joueur`.')], components: [] });
		const trait3 = interaction.values[0];
		cjSessions.set(interaction.user.id, { ...prev, t3: trait3 });

		// Afficher le sélecteur Main principale
		const mainSelect = new StringSelectMenuBuilder()
		  .setCustomId(`cj_main:${interaction.user.id}`)
		  .setPlaceholder('Main principale')
		  .addOptions(
			{ label: '🤜 Droitier', value: 'Droitier', description: 'Joue de la main droite' },
			{ label: '🤛 Gaucher',  value: 'Gaucher',  description: 'Joue de la main gauche' },
		  );

		return interaction.update({
		  embeds: [new EmbedBuilder().setColor(COLOR.tennis)
			.setTitle('🎾 Créer ton joueur — Caractéristiques (1/2)')
			.setDescription(
			  `**${prev.n}** · 🌍 ${prev.p}\n` +
			  `🧠 **${prev.t1}** · **${prev.t2}** · **${trait3}**\n\n` +
			  `**Main principale :**`
			)],
		  components: [new ActionRowBuilder().addComponents(mainSelect)],
		});
	  });

	  // Étape 7 : main choisie → sélecteur revers
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isStringSelectMenu()) return;
		if (!interaction.customId.startsWith('cj_main:')) return;

		const userId7 = interaction.customId.split(':')[1];
		const sess7 = cjSessions.get(userId7) ?? cjSessions.get(interaction.user.id);
		if (!sess7) return interaction.update({ embeds: [err('Session expirée, relance `/creer-joueur`.')], components: [] });
		const mainHand = interaction.values[0];
		cjSessions.set(interaction.user.id, { ...sess7, main: mainHand });

		const reversSelect = new StringSelectMenuBuilder()
		  .setCustomId(`cj_revers:${interaction.user.id}`)
		  .setPlaceholder('Type de revers')
		  .addOptions(
			{ label: '☝️ Une main',   value: 'Une main',   description: 'Revers à une main' },
			{ label: '✌️ Deux mains', value: 'Deux mains', description: 'Revers à deux mains' },
		  );

		return interaction.update({
		  embeds: [new EmbedBuilder().setColor(COLOR.tennis)
			.setTitle('🎾 Créer ton joueur — Caractéristiques (2/2)')
			.setDescription(
			  `**${sess7.n}** · 🌍 ${sess7.p}\n\n` +
			  `✅ Main : **${mainHand}**\n\n` +
			  `**Type de revers :**`
			)],
		  components: [new ActionRowBuilder().addComponents(reversSelect)],
		});
	  });

	  // Étape 8 : revers choisi → modal taille/poids
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isStringSelectMenu()) return;
		if (!interaction.customId.startsWith('cj_revers:')) return;

		const userId8 = interaction.customId.split(':')[1];
		const sess8 = cjSessions.get(userId8) ?? cjSessions.get(interaction.user.id);
		if (!sess8) return interaction.update({ embeds: [err('Session expirée, relance `/creer-joueur`.')], components: [] });
		const revers = interaction.values[0];
		cjSessions.set(interaction.user.id, { ...sess8, revers });

		const physModal = new ModalBuilder()
		  .setCustomId(`cj_phys_modal:${interaction.user.id}`)
		  .setTitle('Taille & Poids');
		physModal.addComponents(
		  new ActionRowBuilder().addComponents(
			new TextInputBuilder().setCustomId('cj_taille').setLabel('Taille (ex: 185)').setStyle(TextInputStyle.Short).setPlaceholder('en cm').setRequired(true).setMinLength(2).setMaxLength(3)
		  ),
		  new ActionRowBuilder().addComponents(
			new TextInputBuilder().setCustomId('cj_poids').setLabel('Poids (ex: 78)').setStyle(TextInputStyle.Short).setPlaceholder('en kg').setRequired(true).setMinLength(2).setMaxLength(3)
		  ),
		);
		return interaction.showModal(physModal);
	  });

	  // Étape 9 : modal taille/poids soumis → modal attributs techniques (15 stats, 180 pts)
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isModalSubmit()) return;
		if (!interaction.customId.startsWith('cj_phys_modal:')) return;

		const userId9 = interaction.customId.split(':')[1];
		const sess9 = cjSessions.get(userId9) ?? cjSessions.get(interaction.user.id);
		if (!sess9) return interaction.reply({ embeds: [err('Session expirée, relance `/creer-joueur`.')], ephemeral: true });

		const tailleRaw = interaction.fields.getTextInputValue('cj_taille').trim();
		const poidsRaw  = interaction.fields.getTextInputValue('cj_poids').trim();
		const taille = parseInt(tailleRaw, 10);
		const poids  = parseInt(poidsRaw, 10);
		if (isNaN(taille) || taille < 140 || taille > 230)
		  return interaction.reply({ embeds: [err('Taille invalide (entre 140 et 230 cm).')], ephemeral: true });
		if (isNaN(poids) || poids < 40 || poids > 150)
		  return interaction.reply({ embeds: [err('Poids invalide (entre 40 et 150 kg).')], ephemeral: true });

		cjSessions.set(interaction.user.id, { ...sess9, taille, poids });

		// Discord interdit d'ouvrir un modal depuis un ModalSubmit.
		// On envoie un message éphémère avec un bouton intermédiaire.
		const btnAttr1 = new ButtonBuilder()
		  .setCustomId(`cj_open_attr1:${interaction.user.id}`)
		  .setLabel('➡️ Attributs techniques (1/3)')
		  .setStyle(ButtonStyle.Primary);
		return interaction.reply({
		  embeds: [new EmbedBuilder()
			.setColor(0x2ecc71)
			.setTitle('🎾 Attributs techniques — écran 1/3')
			.setDescription(
			  '✅ Taille et poids enregistrés !\n\n' +
			  '**Budget total :** 180 pts à répartir sur 3 écrans (5 stats chacun)\n' +
			  '**Conseil :** vise environ **60 pts sur cet écran** pour garder de la marge.\n\n' +
			  '> Chaque stat : min **1**, max **20**\n' +
			  '> Écran 1 — Service & Coup droit'
			)],
		  components: [new ActionRowBuilder().addComponents(btnAttr1)],
		  ephemeral: true,
		});
	  });

	  // Étape 9b : bouton intermédiaire → ouvre le modal attrs 1/3
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isButton()) return;
		if (!interaction.customId.startsWith('cj_open_attr1:')) return;

		const userId9b = interaction.customId.split(':')[1];
		if (interaction.user.id !== userId9b) return interaction.reply({ content: 'Ce bouton ne t\'appartient pas.', ephemeral: true });

		const attrModal1 = new ModalBuilder()
		  .setCustomId(`cj_attr1:${interaction.user.id}`)
		  .setTitle('Attrs tech 1/3 — visée ~60 pts ici');
		attrModal1.addComponents(
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_puiss_serv').setLabel('Puissance service (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_effet_serv').setLabel('Effet service (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_reg_serv').setLabel('Régularité service (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_cd').setLabel('Coup droit (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_reg_cd').setLabel('Régularité coup droit (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		);
		return interaction.showModal(attrModal1);
	  });

	  // Étape 10 : modal attrs 1/3 soumis → modal 2/3
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isModalSubmit()) return;
		if (!interaction.customId.startsWith('cj_attr1:')) return;

		const userId10 = interaction.customId.split(':')[1];
		const sess10 = cjSessions.get(userId10) ?? cjSessions.get(interaction.user.id);
		if (!sess10) return interaction.reply({ embeds: [err('Session expirée, relance `/creer-joueur`.')], ephemeral: true });

		const parseAttr = (key) => {
		  const v = parseInt(interaction.fields.getTextInputValue(key), 10);
		  return isNaN(v) ? null : v;
		};
		const rawA1 = { a_puiss_serv: interaction.fields.getTextInputValue('a_puiss_serv'), a_effet_serv: interaction.fields.getTextInputValue('a_effet_serv'), a_reg_serv: interaction.fields.getTextInputValue('a_reg_serv'), a_cd: interaction.fields.getTextInputValue('a_cd'), a_reg_cd: interaction.fields.getTextInputValue('a_reg_cd') };
		const a1 = { puiss_serv: parseAttr('a_puiss_serv'), effet_serv: parseAttr('a_effet_serv'), reg_serv: parseAttr('a_reg_serv'), cd: parseAttr('a_cd'), reg_cd: parseAttr('a_reg_cd') };
		const invalidA1 = Object.entries(a1).find(([, v]) => v === null || v < 1 || v > 20);
		if (invalidA1) {
		  const fix1 = new ModalBuilder().setCustomId(`cj_attr1:${interaction.user.id}`).setTitle('Attrs tech 1/3 — corrige les valeurs');
		  fix1.addComponents(
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_puiss_serv').setLabel('Puissance service (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA1.a_puiss_serv)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_effet_serv').setLabel('Effet service (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA1.a_effet_serv)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_reg_serv').setLabel('Régularité service (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA1.a_reg_serv)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_cd').setLabel('Coup droit (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA1.a_cd)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_reg_cd').setLabel('Régularité coup droit (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA1.a_reg_cd)),
		  );
		  return interaction.showModal(fix1);
		}
		cjSessions.set(interaction.user.id, { ...sess10, a1 });

		const spent1 = Object.values(a1).reduce((s, v) => s + v, 0);
		const remaining2 = 180 - spent1;
		const avgRemaining2 = Math.round(remaining2 / 2);
		const btnAttr2 = new ButtonBuilder()
		  .setCustomId(`cj_open_attr2:${interaction.user.id}`)
		  .setLabel(`➡️ Attributs techniques (2/3) — ${remaining2} pts restants`)
		  .setStyle(ButtonStyle.Primary);
		return interaction.reply({
		  embeds: [new EmbedBuilder()
			.setColor(spent1 <= 65 ? 0x2ecc71 : 0xe67e22)
			.setTitle('🎾 Attributs techniques — écran 2/3')
			.setDescription(
			  `✅ Écran 1/3 validé — **${spent1} pts dépensés**\n\n` +
			  `**Pts restants :** ${remaining2} / 180 (sur 2 écrans)\n` +
			  `**Conseil :** vise environ **${avgRemaining2} pts sur cet écran** pour garder de la marge.\n\n` +
			  `> Chaque stat : min **1**, max **20**\n` +
			  `> Écran 2 — Revers, Retour & Volée` +
			  (spent1 > 65 ? `\n\n⚠️ Tu as dépensé beaucoup sur l'écran 1 — ajuste en conséquence !` : '')
			)],
		  components: [new ActionRowBuilder().addComponents(btnAttr2)],
		  ephemeral: true,
		});
	  });

	  // Étape 10b : bouton → ouvre modal attrs 2/3
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isButton()) return;
		if (!interaction.customId.startsWith('cj_open_attr2:')) return;
		const userId10b = interaction.customId.split(':')[1];
		if (interaction.user.id !== userId10b) return interaction.reply({ content: 'Ce bouton ne t\'appartient pas.', ephemeral: true });
		const attrModal2 = new ModalBuilder()
		  .setCustomId(`cj_attr2:${interaction.user.id}`)
		  .setTitle('Attrs tech 2/3 — visée ~60 pts ici');
		attrModal2.addComponents(
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_revers').setLabel('Revers (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_reg_rv').setLabel('Régularité revers (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_retour').setLabel('Retour (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_contre').setLabel('Contre (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_volee').setLabel('Volée (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		);
		return interaction.showModal(attrModal2);
	  });

	  // Étape 11 : modal attrs 2/3 soumis → modal 3/3
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isModalSubmit()) return;
		if (!interaction.customId.startsWith('cj_attr2:')) return;

		const userId11 = interaction.customId.split(':')[1];
		const sess11 = cjSessions.get(userId11) ?? cjSessions.get(interaction.user.id);
		if (!sess11) return interaction.reply({ embeds: [err('Session expirée, relance `/creer-joueur`.')], ephemeral: true });

		const parseAttr = (key) => {
		  const v = parseInt(interaction.fields.getTextInputValue(key), 10);
		  return isNaN(v) ? null : v;
		};
		const rawA2 = { a_revers: interaction.fields.getTextInputValue('a_revers'), a_reg_rv: interaction.fields.getTextInputValue('a_reg_rv'), a_retour: interaction.fields.getTextInputValue('a_retour'), a_contre: interaction.fields.getTextInputValue('a_contre'), a_volee: interaction.fields.getTextInputValue('a_volee') };
		const a2 = { revers: parseAttr('a_revers'), reg_rv: parseAttr('a_reg_rv'), retour: parseAttr('a_retour'), contre: parseAttr('a_contre'), volee: parseAttr('a_volee') };
		const invalidA2 = Object.entries(a2).find(([, v]) => v === null || v < 1 || v > 20);
		if (invalidA2) {
		  const fix2 = new ModalBuilder().setCustomId(`cj_attr2:${interaction.user.id}`).setTitle('Attrs tech 2/3 — corrige les valeurs');
		  fix2.addComponents(
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_revers').setLabel('Revers (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA2.a_revers)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_reg_rv').setLabel('Régularité revers (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA2.a_reg_rv)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_retour').setLabel('Retour (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA2.a_retour)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_contre').setLabel('Contre (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA2.a_contre)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_volee').setLabel('Volée (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA2.a_volee)),
		  );
		  return interaction.showModal(fix2);
		}
		cjSessions.set(interaction.user.id, { ...sess11, a2 });

		const spent1b = Object.values(sess11.a1 ?? {}).reduce((s, v) => s + v, 0);
		const spent2 = Object.values(a2).reduce((s, v) => s + v, 0);
		const remaining3 = 180 - spent1b - spent2;
		const isOk3 = remaining3 >= 5 && remaining3 <= 100; // 5 stats × [1–20]
		const btnAttr3 = new ButtonBuilder()
		  .setCustomId(`cj_open_attr3:${interaction.user.id}`)
		  .setLabel(`➡️ Attributs techniques (3/3) — ${remaining3} pts à placer`)
		  .setStyle(isOk3 ? ButtonStyle.Primary : ButtonStyle.Danger);
		return interaction.reply({
		  embeds: [new EmbedBuilder()
			.setColor(isOk3 ? 0x2ecc71 : 0xe74c3c)
			.setTitle('🎾 Attributs techniques — écran 3/3 (dernier !)')
			.setDescription(
			  `✅ Écran 2/3 validé — **${spent2} pts dépensés** (écran 2)\n` +
			  `📊 Total dépensé : **${spent1b + spent2} / 180**\n\n` +
			  `**Tu dois placer exactement ${remaining3} pts sur cet écran** (5 stats).\n` +
			  `> Min par stat : **1** — Max par stat : **20**\n` +
			  `> Écran 3 — Lift, Coupé, Amorti, Contrôle & Timing` +
			  (!isOk3 ? `\n\n⛔ ${remaining3 < 5 ? 'Trop peu de points restants (min 5 pour 5 stats)' : 'Trop de points restants (max 100 pour 5 stats × 20)'}. Relance `/creer-joueur`.` : '')
			)],
		  components: [new ActionRowBuilder().addComponents(btnAttr3)],
		  ephemeral: true,
		});
	  });

	  // Étape 11b : bouton → ouvre modal attrs 3/3
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isButton()) return;
		if (!interaction.customId.startsWith('cj_open_attr3:')) return;
		const userId11b = interaction.customId.split(':')[1];
		if (interaction.user.id !== userId11b) return interaction.reply({ content: 'Ce bouton ne t\'appartient pas.', ephemeral: true });
		const attrModal3 = new ModalBuilder()
		  .setCustomId(`cj_attr3:${interaction.user.id}`)
		  .setTitle('Attrs tech 3/3 — voir pts restants ↑');
		attrModal3.addComponents(
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_lift').setLabel('Lift (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_coupe').setLabel('Coupé (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_amorti').setLabel('Amorti (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_controle').setLabel('Contrôle (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_timing').setLabel('Timing (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		);
		return interaction.showModal(attrModal3);
	  });

	  // Étape 12 : modal attrs 3/3 soumis → validation total 180 pts → modal attributs physiques
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isModalSubmit()) return;
		if (!interaction.customId.startsWith('cj_attr3:')) return;

		const userId12 = interaction.customId.split(':')[1];
		const prev = cjSessions.get(userId12) ?? cjSessions.get(interaction.user.id);
		if (!prev) return interaction.reply({ embeds: [err('Session expirée, relance `/creer-joueur`.')], ephemeral: true });

		const parseAttr = (key) => {
		  const v = parseInt(interaction.fields.getTextInputValue(key), 10);
		  return isNaN(v) ? null : v;
		};
		const rawA3 = { a_lift: interaction.fields.getTextInputValue('a_lift'), a_coupe: interaction.fields.getTextInputValue('a_coupe'), a_amorti: interaction.fields.getTextInputValue('a_amorti'), a_controle: interaction.fields.getTextInputValue('a_controle'), a_timing: interaction.fields.getTextInputValue('a_timing') };
		const a3 = { lift: parseAttr('a_lift'), coupe: parseAttr('a_coupe'), amorti: parseAttr('a_amorti'), controle: parseAttr('a_controle'), timing: parseAttr('a_timing') };

		const reopenAttr3 = (titleSuffix) => {
		  const fix3 = new ModalBuilder().setCustomId(`cj_attr3:${interaction.user.id}`).setTitle(`Attrs tech 3/3 — ${titleSuffix}`);
		  fix3.addComponents(
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_lift').setLabel('Lift (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA3.a_lift)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_coupe').setLabel('Coupé (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA3.a_coupe)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_amorti').setLabel('Amorti (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA3.a_amorti)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_controle').setLabel('Contrôle (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA3.a_controle)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a_timing').setLabel('Timing (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawA3.a_timing)),
		  );
		  return interaction.showModal(fix3);
		};

		const invalidA3 = Object.entries(a3).find(([, v]) => v === null || v < 1 || v > 20);
		if (invalidA3) return reopenAttr3('corrige les valeurs');

		const allAttrs = { ...prev.a1, ...prev.a2, ...a3 };
		const total = Object.values(allAttrs).reduce((s, v) => s + v, 0);
		if (total > 180) {
		  const delta = total - 180;
		  return reopenAttr3(`+${delta} pts en trop — réduis ici`);
		}

		cjSessions.set(interaction.user.id, { ...prev, a3 });

		const btnPhysAttr = new ButtonBuilder()
		  .setCustomId(`cj_open_physattr:${interaction.user.id}`)
		  .setLabel('➡️ Attributs physiques — 80 pts à répartir')
		  .setStyle(ButtonStyle.Primary);
		return interaction.reply({
		  embeds: [new EmbedBuilder()
			.setColor(0x2ecc71)
			.setTitle('💪 Attributs physiques')
			.setDescription(
			  `✅ Attributs techniques validés — **${total}/180** ✅\n\n` +
			  '**Budget physique :** 80 pts à répartir sur **5 stats** + **endurance auto-calculée**\n\n' +
			  '> Chaque stat : min **1**, max **20**\n' +
			  '> **L\'endurance** sera calculée automatiquement : `endurance = 80 − (somme des 5 stats)`\n' +
			  '> Pour que l\'endurance soit valide (1–20), place entre **60 et 79 pts** au total sur les 5 stats.'
			)],
		  components: [new ActionRowBuilder().addComponents(btnPhysAttr)],
		  ephemeral: true,
		});
	  });

	  // Étape 12b : bouton → ouvre modal attributs physiques
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isButton()) return;
		if (!interaction.customId.startsWith('cj_open_physattr:')) return;
		const userId12b = interaction.customId.split(':')[1];
		if (interaction.user.id !== userId12b) return interaction.reply({ content: 'Ce bouton ne t\'appartient pas.', ephemeral: true });
		const physAttrModal = new ModalBuilder()
		  .setCustomId(`cj_physattr:${interaction.user.id}`)
		  .setTitle('Attrs physiques — 60–79 pts (endurance auto)');
		physAttrModal.addComponents(
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_accel').setLabel('Accélération (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_jambes').setLabel('Jeu de jambes (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_equilibre').setLabel('Équilibre (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_agilite').setLabel('Agilité (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_capa_phys').setLabel('Capacité physique (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)),
		);
		return interaction.showModal(physAttrModal);
	  });

	  // Étape 13 : modal attributs physiques soumis → validation 80 pts → création joueur
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isModalSubmit()) return;
		if (!interaction.customId.startsWith('cj_physattr:')) return;

		const userId13 = interaction.customId.split(':')[1];
		const prev = cjSessions.get(userId13) ?? cjSessions.get(interaction.user.id);
		if (!prev) return interaction.reply({ embeds: [err('Session expirée, relance `/creer-joueur`.')], ephemeral: true });

		const parseAttr = (key) => {
		  const v = parseInt(interaction.fields.getTextInputValue(key), 10);
		  return isNaN(v) ? null : v;
		};

		const rawPhys = { p_accel: interaction.fields.getTextInputValue('p_accel'), p_jambes: interaction.fields.getTextInputValue('p_jambes'), p_equilibre: interaction.fields.getTextInputValue('p_equilibre'), p_agilite: interaction.fields.getTextInputValue('p_agilite'), p_capa_phys: interaction.fields.getTextInputValue('p_capa_phys') };

		const physAttrs = {
		  acceleration:    parseAttr('p_accel'),
		  jeu_de_jambes:   parseAttr('p_jambes'),
		  equilibre:       parseAttr('p_equilibre'),
		  agilite:         parseAttr('p_agilite'),
		  capacite_physique: parseAttr('p_capa_phys'),
		};

		const reopenPhys = (titleSuffix) => {
		  const fixP = new ModalBuilder().setCustomId(`cj_physattr:${interaction.user.id}`).setTitle(`Attrs physiques — ${titleSuffix}`);
		  fixP.addComponents(
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_accel').setLabel('Accélération (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawPhys.p_accel)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_jambes').setLabel('Jeu de jambes (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawPhys.p_jambes)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_equilibre').setLabel('Équilibre (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawPhys.p_equilibre)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_agilite').setLabel('Agilité (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawPhys.p_agilite)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_capa_phys').setLabel('Capacité physique (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawPhys.p_capa_phys)),
		  );
		  return interaction.showModal(fixP);
		};

		// Note: endurance est calculée automatiquement pour atteindre exactement 80 pts
		const sumFive = Object.values(physAttrs).reduce((s, v) => s + (v ?? 0), 0);
		const invalidPhys = Object.entries(physAttrs).find(([, v]) => v === null || v < 1 || v > 20);
		if (invalidPhys) return reopenPhys('corrige les valeurs');

		const endurance = 80 - sumFive;
		if (endurance < 1 || endurance > 20) {
		  const needed = endurance < 1 ? `enlève ${1 - endurance} pts` : `ajoute ${endurance - 20} pts`;
		  return reopenPhys(`endurance=${endurance} → ${needed}`);
		}
		physAttrs.endurance = endurance;

		cjSessions.set(interaction.user.id, { ...prev, physAttrs });

		const btnMental = new ButtonBuilder()
		  .setCustomId(`cj_open_mental:${interaction.user.id}`)
		  .setLabel('➡️ Attributs mentaux — 80 pts à répartir')
		  .setStyle(ButtonStyle.Primary);
		return interaction.reply({
		  embeds: [new EmbedBuilder()
			.setColor(0x2ecc71)
			.setTitle('🧠 Attributs mentaux')
			.setDescription(
			  `✅ Attributs physiques validés — endurance auto : **${endurance}** ✅\n\n` +
			  '**Budget mental :** 80 pts à répartir sur **6 stats** — même logique que le physique\n\n' +
			  '> Chaque stat : min **1**, max **20**\n' +
			  '> Tu saisiras **5 stats** dans le formulaire\n' +
			  '> La **Ténacité** sera calculée automatiquement : `ténacité = 80 − (somme des 5 stats)`\n' +
			  '> Pour que la ténacité soit valide (1–20), place entre **60 et 79 pts** au total sur les 5 stats\n\n' +
			  '> Stats : Anticipation · Concentration · Sens tactique · Sang froid · Instinct de tueur · **Ténacité (auto)**'
			)],
		  components: [new ActionRowBuilder().addComponents(btnMental)],
		  ephemeral: true,
		});
	  });

	  // Étape 13b : bouton → ouvre modal attributs mentaux (aussi utilisé pour retour depuis ténacité invalide)
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isButton()) return;
		if (!interaction.customId.startsWith('cj_open_mental:')) return;
		const userId13b = interaction.customId.split(':')[1];
		if (interaction.user.id !== userId13b) return interaction.reply({ content: 'Ce bouton ne t\'appartient pas.', ephemeral: true });
		const sess13b = cjSessions.get(userId13b) ?? cjSessions.get(interaction.user.id);
		if (!sess13b) return interaction.reply({ embeds: [err('Session expirée, relance `/creer-joueur`.')], ephemeral: true });

		// Si on revient depuis une ténacité invalide, pré-remplir avec les valeurs déjà saisies
		const prev = sess13b.m1;
		const mentalModal = new ModalBuilder()
		  .setCustomId(`cj_mental:${interaction.user.id}`)
		  .setTitle(prev ? 'Attrs mentaux — corrige pour ténacité valide' : 'Attrs mentaux (5/6) — visée 60–79 pts ici');
		mentalModal.addComponents(
		  new ActionRowBuilder().addComponents((() => { const b = new TextInputBuilder().setCustomId('m_anticipation').setLabel('Anticipation (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2); return prev ? b.setValue(String(prev.anticipation)) : b; })()),
		  new ActionRowBuilder().addComponents((() => { const b = new TextInputBuilder().setCustomId('m_concentration').setLabel('Concentration (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2); return prev ? b.setValue(String(prev.concentration)) : b; })()),
		  new ActionRowBuilder().addComponents((() => { const b = new TextInputBuilder().setCustomId('m_sens_tactique').setLabel('Sens tactique (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2); return prev ? b.setValue(String(prev.sens_tactique)) : b; })()),
		  new ActionRowBuilder().addComponents((() => { const b = new TextInputBuilder().setCustomId('m_sang_froid').setLabel('Sang froid (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2); return prev ? b.setValue(String(prev.sang_froid)) : b; })()),
		  new ActionRowBuilder().addComponents((() => { const b = new TextInputBuilder().setCustomId('m_instinct').setLabel('Instinct de tueur (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2); return prev ? b.setValue(String(prev.instinct_tueur)) : b; })()),
		);
		return interaction.showModal(mentalModal);
	  });

	  // Étape 14 : modal mentaux page 1 soumis (5 stats) → bouton page 2 (ténacité)
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isModalSubmit()) return;
		if (!interaction.customId.startsWith('cj_mental:')) return;

		const userId14 = interaction.customId.split(':')[1];
		const prev14 = cjSessions.get(userId14) ?? cjSessions.get(interaction.user.id);
		if (!prev14) return interaction.reply({ embeds: [err('Session expirée, relance `/creer-joueur`.')], ephemeral: true });

		const parseAttr = (key) => {
		  const v = parseInt(interaction.fields.getTextInputValue(key), 10);
		  return isNaN(v) ? null : v;
		};

		const rawM1 = { m_anticipation: interaction.fields.getTextInputValue('m_anticipation'), m_concentration: interaction.fields.getTextInputValue('m_concentration'), m_sens_tactique: interaction.fields.getTextInputValue('m_sens_tactique'), m_sang_froid: interaction.fields.getTextInputValue('m_sang_froid'), m_instinct: interaction.fields.getTextInputValue('m_instinct') };
		const m1 = { anticipation: parseAttr('m_anticipation'), concentration: parseAttr('m_concentration'), sens_tactique: parseAttr('m_sens_tactique'), sang_froid: parseAttr('m_sang_froid'), instinct_tueur: parseAttr('m_instinct') };

		const reopenMental1 = (titleSuffix) => {
		  const fixM = new ModalBuilder().setCustomId(`cj_mental:${interaction.user.id}`).setTitle(`Attrs mentaux — ${titleSuffix}`);
		  fixM.addComponents(
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('m_anticipation').setLabel('Anticipation (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawM1.m_anticipation)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('m_concentration').setLabel('Concentration (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawM1.m_concentration)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('m_sens_tactique').setLabel('Sens tactique (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawM1.m_sens_tactique)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('m_sang_froid').setLabel('Sang froid (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawM1.m_sang_froid)),
			new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('m_instinct').setLabel('Instinct de tueur (1–20)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setValue(rawM1.m_instinct)),
		  );
		  return interaction.showModal(fixM);
		};

		const invalidM1 = Object.entries(m1).find(([, v]) => v === null || v < 1 || v > 20);
		if (invalidM1) return reopenMental1('corrige les valeurs');

		const sumM1 = Object.values(m1).reduce((s, v) => s + v, 0);
		if (sumM1 >= 80) return reopenMental1(`${sumM1}/80 déjà — réduis ici`);

		const tenaciteNeeded = 80 - sumM1;
		cjSessions.set(interaction.user.id, { ...prev14, m1, tenaciteNeeded });

		const btnTenacite = new ButtonBuilder()
		  .setCustomId(`cj_open_tenacite:${interaction.user.id}`)
		  .setLabel(`➡️ Confirmer — Ténacité : ${tenaciteNeeded}`)
		  .setStyle(tenaciteNeeded >= 1 && tenaciteNeeded <= 20 ? ButtonStyle.Success : ButtonStyle.Danger)
		  .setDisabled(!(tenaciteNeeded >= 1 && tenaciteNeeded <= 20));

		const row = new ActionRowBuilder().addComponents(btnTenacite);

		if (!(tenaciteNeeded >= 1 && tenaciteNeeded <= 20)) {
		  const btnRetour = new ButtonBuilder()
			.setCustomId(`cj_open_mental:${interaction.user.id}`)
			.setLabel('↩️ Modifier les 5 stats')
			.setStyle(ButtonStyle.Primary);
		  row.addComponents(btnRetour);
		}

		return interaction.reply({
		  embeds: [new EmbedBuilder()
			.setColor(tenaciteNeeded >= 1 && tenaciteNeeded <= 20 ? 0x2ecc71 : 0xe74c3c)
			.setTitle('🧠 Attributs mentaux — Ténacité auto')
			.setDescription(
			  `✅ 5 stats mentales enregistrées — **${sumM1} / 80**\n\n` +
			  `**Ténacité calculée automatiquement : ${tenaciteNeeded}**\n` +
			  (tenaciteNeeded >= 1 && tenaciteNeeded <= 20
				? `> ✅ Valeur valide (1–20) — clique sur **Confirmer** pour finaliser`
				: `> ⛔ Valeur invalide — la ténacité doit être entre 1 et 20\n> Total actuel : **${sumM1}/80** → pour une ténacité valide, place entre **60 et 79 pts** sur les 5 stats\n> Utilise **↩️ Modifier les 5 stats** pour corriger`)
			)],
		  components: [row],
		  ephemeral: true,
		});
	  });

	  // Étape 14b : bouton ténacité → confirmation et création joueur
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isButton()) return;
		if (!interaction.customId.startsWith('cj_open_tenacite:')) return;
		const userId14b = interaction.customId.split(':')[1];
		if (interaction.user.id !== userId14b) return interaction.reply({ content: 'Ce bouton ne t\'appartient pas.', ephemeral: true });
		const sess14b = cjSessions.get(userId14b) ?? cjSessions.get(interaction.user.id);
		if (!sess14b) return interaction.reply({ embeds: [err('Session expirée, relance `/creer-joueur`.')], ephemeral: true });
		if (!sess14b.tenaciteNeeded || sess14b.tenaciteNeeded < 1 || sess14b.tenaciteNeeded > 20)
		  return interaction.reply({ embeds: [err('Ténacité invalide. Relance `/creer-joueur`.')], ephemeral: true });

		const mentalAttrs = { ...sess14b.m1, tenacite: sess14b.tenaciteNeeded };
		cjSessions.set(interaction.user.id, { ...sess14b, mentalAttrs });

		// → Passer aux tactiques
		const TACTIQUES = [
		  { label: '🌍 Jeu tout-terrain',                   value: 'Jeu tout-terrain',                   description: 'Polyvalent, s\'adapte à tout' },
		  { label: '🎯 Fond de court offensif',             value: 'Jeu de fond de court offensif',      description: 'Frappe fort depuis le fond' },
		  { label: '⚔️ Jeu d\'attaque',                    value: 'Jeu d\'attaque',                     description: 'Cherche le filet et l\'offensive' },
		  { label: '🛡️ Défensif fond de court',            value: 'Jeu défensif fond de court',         description: 'Construit sur la solidité et la patience' },
		  { label: '🔄 Contre-attaque',                    value: 'Jeu basé sur la contre-attaque',     description: 'Retourne la pression adverse' },
		  { label: '💪 Fond de court solide',               value: 'Jeu solide fond de court',           description: 'Régularité et efficacité sans failles' },
		  { label: '🧩 Jeu tactique varié',                 value: 'Jeu tactique varié',                 description: 'Déroute l\'adversaire par la variation' },
		  { label: '🎾 Service-volée',                      value: 'Service-volée',                      description: 'Monte au filet dès le service' },
		  { label: '💥 Gros service',                       value: 'Jeu basé sur un gros service',       description: 'Le service comme arme principale' },
		];

		const tac1Select = new StringSelectMenuBuilder()
		  .setCustomId(`cj_tac1:${interaction.user.id}`)
		  .setPlaceholder('Tactique principale')
		  .addOptions(TACTIQUES);

		return interaction.reply({
		  ephemeral: true,
		  embeds: [new EmbedBuilder().setColor(COLOR.tennis)
			.setTitle('🎾 Créer ton joueur — Tactiques (1/3)')
			.setDescription(
			  `**${sess14b.n}** · 🌍 ${sess14b.p}\n\n` +
			  `✅ Stats mentales confirmées !\n\n` +
			  `**Choisis ta tactique principale :**\n> C'est ton style de jeu dominant, celui que tu pratiques le plus naturellement.`
			)],
		  components: [new ActionRowBuilder().addComponents(tac1Select)],
		});
	  });

	  // ─── TACTIQUES ────────────────────────────────────────────────────────────────

	  const TACTIQUES_ALL = [
		{ label: '🌍 Jeu tout-terrain',        value: 'Jeu tout-terrain',                description: 'Polyvalent, s\'adapte à tout' },
		{ label: '🎯 Fond de court offensif',  value: 'Jeu de fond de court offensif',   description: 'Frappe fort depuis le fond' },
		{ label: '⚔️ Jeu d\'attaque',         value: 'Jeu d\'attaque',                  description: 'Cherche le filet et l\'offensive' },
		{ label: '🛡️ Défensif fond de court', value: 'Jeu défensif fond de court',      description: 'Construit sur la solidité et la patience' },
		{ label: '🔄 Contre-attaque',         value: 'Jeu basé sur la contre-attaque',  description: 'Retourne la pression adverse' },
		{ label: '💪 Fond de court solide',    value: 'Jeu solide fond de court',        description: 'Régularité et efficacité sans failles' },
		{ label: '🧩 Jeu tactique varié',      value: 'Jeu tactique varié',              description: 'Déroute l\'adversaire par la variation' },
		{ label: '🎾 Service-volée',           value: 'Service-volée',                   description: 'Monte au filet dès le service' },
		{ label: '💥 Gros service',            value: 'Jeu basé sur un gros service',    description: 'Le service comme arme principale' },
	  ];

	  // Étape 15a : tactique principale choisie → sélecteur tactique secondaire
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isStringSelectMenu()) return;
		if (!interaction.customId.startsWith('cj_tac1:')) return;

		const userId15a = interaction.customId.split(':')[1];
		const sess15a = cjSessions.get(userId15a) ?? cjSessions.get(interaction.user.id);
		if (!sess15a) return interaction.update({ embeds: [err('Session expirée, relance `/creer-joueur`.')], components: [] });

		const tac1 = interaction.values[0];
		cjSessions.set(interaction.user.id, { ...sess15a, tac1 });

		const tac2Select = new StringSelectMenuBuilder()
		  .setCustomId(`cj_tac2:${interaction.user.id}`)
		  .setPlaceholder('Tactique secondaire')
		  .addOptions(TACTIQUES_ALL.filter(t => t.value !== tac1));

		return interaction.update({
		  embeds: [new EmbedBuilder().setColor(COLOR.tennis)
			.setTitle('🎾 Créer ton joueur — Tactiques (2/3)')
			.setDescription(
			  `**${sess15a.n}** · 🌍 ${sess15a.p}\n\n` +
			  `✅ Principale : **${tac1}**\n\n` +
			  `**Choisis ta tactique secondaire :**\n> Ton plan B, celui que tu alternes selon la situation.`
			)],
		  components: [new ActionRowBuilder().addComponents(tac2Select)],
		});
	  });

	  // Étape 15b : tactique secondaire choisie → sélecteur troisième tactique
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isStringSelectMenu()) return;
		if (!interaction.customId.startsWith('cj_tac2:')) return;

		const userId15b = interaction.customId.split(':')[1];
		const sess15b = cjSessions.get(userId15b) ?? cjSessions.get(interaction.user.id);
		if (!sess15b) return interaction.update({ embeds: [err('Session expirée, relance `/creer-joueur`.')], components: [] });

		const tac2 = interaction.values[0];
		cjSessions.set(interaction.user.id, { ...sess15b, tac2 });

		const tac3Select = new StringSelectMenuBuilder()
		  .setCustomId(`cj_tac3:${interaction.user.id}`)
		  .setPlaceholder('Troisième tactique')
		  .addOptions(TACTIQUES_ALL.filter(t => t.value !== sess15b.tac1 && t.value !== tac2));

		return interaction.update({
		  embeds: [new EmbedBuilder().setColor(COLOR.tennis)
			.setTitle('🎾 Créer ton joueur — Tactiques (3/3)')
			.setDescription(
			  `**${sess15b.n}** · 🌍 ${sess15b.p}\n\n` +
			  `✅ Principale : **${sess15b.tac1}**\n` +
			  `✅ Secondaire : **${tac2}**\n\n` +
			  `**Choisis ta troisième tactique :**\n> Ton option de repli, l'alternative ultime.`
			)],
		  components: [new ActionRowBuilder().addComponents(tac3Select)],
		});
	  });

	  // Étape 16 : troisième tactique choisie → création du joueur
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isStringSelectMenu()) return;
		if (!interaction.customId.startsWith('cj_tac3:')) return;

		const userId16 = interaction.customId.split(':')[1];
		const sess16 = cjSessions.get(userId16) ?? cjSessions.get(interaction.user.id);
		if (!sess16) return interaction.update({ embeds: [err('Session expirée, relance `/creer-joueur`.')], components: [] });

		const tac3 = interaction.values[0];

		const allAttrs = { ...sess16.a1, ...sess16.a2, ...sess16.a3 };
		const totalTech = Object.values(allAttrs).reduce((s, v) => s + v, 0);
		const physAttrs = sess16.physAttrs;
		const mentalAttrs = sess16.mentalAttrs;

		cjSessions.delete(interaction.user.id);

		// Vérifications finales
		if (await db.exists(interaction.user.id))
		  return interaction.update({ embeds: [err('Tu as déjà un joueur ! Utilise `/profil`.')], components: [] });
		if (await db.nameTaken(sess16.n))
		  return interaction.update({ embeds: [err(`Le nom **${sess16.n}** a été pris entre-temps. Relance `/creer-joueur`.`)], components: [] });

		await db.create({
		  discordId:   interaction.user.id,
		  username:    interaction.user.username,
		  ingameName:  sess16.n,
		  nationality: sess16.p,
		  trait1:      sess16.t1,
		  trait2:      sess16.t2,
		  trait3:      sess16.t3,
		  mainHand:    sess16.main,
		  backhand:    sess16.revers,
		  taille:      sess16.taille,
		  poids:       sess16.poids,
		  attrs:       allAttrs,
		  physAttrs:   physAttrs,
		  mentalAttrs: mentalAttrs,
		  tac1:        sess16.tac1,
		  tac2:        sess16.tac2,
		  tac3:        tac3,
		});

		const traitsLine = `🧠 **${sess16.t1}** · **${sess16.t2}** · **${sess16.t3}**`;
		const tactiquesLine = `🎯 **${sess16.tac1}** (principale) · **${sess16.tac2}** (secondaire) · **${tac3}** (3e)`;
		const statsBlock =
		  `🎯 **Service** — Puissance: ${allAttrs.puiss_serv} · Effet: ${allAttrs.effet_serv} · Régularité: ${allAttrs.reg_serv}\n` +
		  `🏓 **Fond** — CD: ${allAttrs.cd} (rég. ${allAttrs.reg_cd}) · RV: ${allAttrs.revers} (rég. ${allAttrs.reg_rv})\n` +
		  `⚡ **Divers** — Retour: ${allAttrs.retour} · Contre: ${allAttrs.contre} · Volée: ${allAttrs.volee}\n` +
		  `🔄 **Effets** — Lift: ${allAttrs.lift} · Coupé: ${allAttrs.coupe} · Amorti: ${allAttrs.amorti}\n` +
		  `🎛️ **Précision** — Contrôle: ${allAttrs.controle} · Timing: ${allAttrs.timing}\n` +
		  `📊 **Total technique : ${totalTech}/180**\n\n` +
		  `🏃 **Physique** — Accél: ${physAttrs.acceleration} · Jambes: ${physAttrs.jeu_de_jambes} · Équilibre: ${physAttrs.equilibre} · Agilité: ${physAttrs.agilite} · Capa: ${physAttrs.capacite_physique} · Endurance: ${physAttrs.endurance}\n` +
		  `📊 **Total physique : 80/80**\n\n` +
		  `🧠 **Mental** — Anticipation: ${mentalAttrs.anticipation} · Concentration: ${mentalAttrs.concentration} · Tactique: ${mentalAttrs.sens_tactique} · Sang froid: ${mentalAttrs.sang_froid} · Instinct: ${mentalAttrs.instinct_tueur} · Ténacité: ${mentalAttrs.tenacite}\n` +
		  `📊 **Total mental : 80/80**`;

		// Message public dans le canal
		await interaction.channel.send({
		  embeds: [ok('Nouveau joueur créé ! 🎾',
			`Bienvenue <@${interaction.user.id}> — **${sess16.n}** vient de rejoindre la simulation !\n\n` +
			`🌍 ${sess16.p}  —  ${sess16.main} · Revers ${sess16.revers}  —  📏 ${sess16.taille} cm / ⚖️ ${sess16.poids} kg\n` +
			`${traitsLine}\n` +
			`${tactiquesLine}\n\n` +
			`${statsBlock}\n\n` +
			`💰 Solde de départ : **500 🪙**`
		  )],
		});
		// Confirmation privée
		return interaction.update({ content: '✅ Ton joueur a été créé avec succès !', embeds: [], components: [] });
	  });

	  // ── Boutons recap_boost ──────────────────────────────────────────────────────
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isButton()) return;
		if (!interaction.customId.startsWith('recap_boost:')) return;
		if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
		  return interaction.reply({ content: '❌ Réservé aux admins.', ephemeral: true });

		await interaction.deferUpdate();

		if (interaction.customId === 'recap_boost:refresh') {
		  return sendRecapBoost(interaction, true);
		}

		if (interaction.customId === 'recap_boost:clear') {
		  const { error } = await supabase.from('boost_log').delete().neq('id', 0);
		  if (error) {
			const errEmbed = new EmbedBuilder().setColor(0xe74c3c).setDescription(`❌ Erreur clear : ${error.message}`);
			return interaction.editReply({ embeds: [errEmbed], components: [] });
		  }
		  const doneEmbed = new EmbedBuilder().setColor(0x2ecc71).setTitle('🗑️ Boost log vidé').setDescription('Tous les boosts ont été marqués comme appliqués dans le save.db.');
		  return interaction.editReply({ embeds: [doneEmbed], components: [] });
		}
	  });

	  // ── Boutons pagination classement ──────────────────────────────────────────────
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isButton()) return;
		if (!interaction.customId.startsWith('classement_page:')) return;

		const page = parseInt(interaction.customId.split(':')[1], 10);
		if (isNaN(page) || page < 0) return;

		await interaction.deferUpdate();

		if (!seasonDbReady)
		  return interaction.editReply({ embeds: [err('Save.db non disponible.')], components: [] });

		const rows = getTmClassement(500);
		const { data: simuRaw } = await supabase.from('players').select('ingame_name, tm_player_id').not('tm_player_id', 'is', null);
		const simuPlayers = (simuRaw ?? []).map(sp => {
		  const tmRow = rows.find(r => r.Id === sp.tm_player_id);
		  return { ingame_name: sp.ingame_name, rank: tmRow?.Rank ?? null, points: tmRow?.Points ?? 0 };
		}).sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));

		return interaction.editReply({
		  embeds: [buildClassementEmbed(rows, page, simuPlayers)],
		  components: buildClassementComponents(page, rows.length),
		});
	  });

  // ── Bouton "Moi uniquement" — parcours GC ATP par année ───────────────────
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.customId !== 'topsgc_moi') return;

    await interaction.deferReply({ ephemeral: true });

    if (!seasonDbReady)
      return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

    const player = await db.get(interaction.user.id);
    if (!player?.tm_player_id)
      return interaction.editReply({ embeds: [err('Tu n\'as pas de joueur lié. Utilise `/creer-joueur` d\'abord.')] });

    const tmId = player.tm_player_id;
    const s = openSaveDb();
    if (!s) return interaction.editReply({ embeds: [err('Base de données non disponible.')] });
    try {
      const pRow = s.prepare('SELECT Firstname, Lastname FROM TennisPlayer WHERE Id=?').get(tmId);
      const pName = pRow ? `${pRow.Firstname} ${pRow.Lastname}` : player.ingame_name ?? `Joueur #${tmId}`;

      // Exclusion junior (même logique que le reste du bot)
      const juniorCatIds = getJuniorCategoryIds(s);
      const { clause: jExcl, ids: jIds } = buildJuniorExcludeClause(juniorCatIds);

      const tcCols = s.prepare('PRAGMA table_info(TournamentCategory)').all().map(c => c.name);
      const hasTcCircuit = tcCols.includes('Circuit');
      const gcAtpCondition = hasTcCircuit
        ? `((tc.Type = 1 AND (tc.Circuit IS NULL OR tc.Circuit = 0)) OR (lower(t.Name) LIKE '%australian open%' OR lower(t.Name) LIKE '%roland garros%' OR lower(t.Name) LIKE '%wimbledon%' OR lower(t.Name) LIKE '%us open%'))`
        : `(tc.Type = 1 OR lower(t.Name) LIKE '%australian open%' OR lower(t.Name) LIKE '%roland garros%' OR lower(t.Name) LIKE '%wimbledon%' OR lower(t.Name) LIKE '%us open%')`;

      // Parcours GC ATP par année
      const rows = s.prepare(`
        SELECT
          tr.Year,
          t.Name AS TournName,
          tr.RoundReached
        FROM TournamentResult tr
        JOIN Tournament t    ON t.Id = tr.TournamentId
        LEFT JOIN TournamentCategory tc ON tc.Id = t.CategoryId
        WHERE tr.PlayerId = ?
          AND ${gcAtpCondition}
          AND ${jExcl}
        ORDER BY tr.Year ASC, t.Name ASC
      `).all(tmId, ...jIds);

      const GC_ROUND_LABEL = {
        '-1': '🏆 Vainqueur',
         '0': '🥈 Finaliste',
         '1': '🎯 1/2',
         '2': '🔹 1/4',
         '3': '⚙️ 1/8',
         '4': '⚙️ 1/16',
         '5': '⚙️ 1/32',
         '6': '⚙️ 1/64',
         '7': '⚙️ 1/128',
      };
      const GC_SHORT_NAME = {
        'australian': '🟡 AO',
        'roland':     '🔴 RG',
        'wimbledon':  '🟢 WIM',
        'us open':    '🔵 USO',
      };
      function gcShort(name) {
        const n = name.toLowerCase();
        for (const [k, v] of Object.entries(GC_SHORT_NAME)) {
          if (n.includes(k)) return v;
        }
        return name.slice(0, 12);
      }

      if (!rows.length) {
        return interaction.editReply({ embeds: [
          new EmbedBuilder()
            .setColor(COLOR.tennis)
            .setTitle(`👤 ${player.ingame_name} — Parcours GC ATP`)
            .setDescription('*Aucune participation en Grand Chelem ATP trouvée.*')
            .setFooter({ text: 'Tennis Manager 2026 · /tops gc' })
        ]});
      }

      // Grouper par année
      const byYear = {};
      for (const r of rows) {
        if (!byYear[r.Year]) byYear[r.Year] = [];
        byYear[r.Year].push(r);
      }

      const GC_ORDER = ['australian', 'roland', 'wimbledon', 'us open'];
      const lines = [];
      for (const year of Object.keys(byYear).sort((a, b) => Number(a) - Number(b))) {
        const entries = byYear[year];
        entries.sort((a, b) => {
          const ia = GC_ORDER.findIndex(k => a.TournName.toLowerCase().includes(k));
          const ib = GC_ORDER.findIndex(k => b.TournName.toLowerCase().includes(k));
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
        const parts = entries.map(r => {
          const rnd = GC_ROUND_LABEL[String(r.RoundReached)] ?? `Tour ${r.RoundReached}`;
          return `${gcShort(r.TournName)} → ${rnd}`;
        });
        lines.push(`**${year}** · ${parts.join('  |  ')}`);
      }

      // Récap
      const totalPart = rows.length;
      const titresGC  = rows.filter(r => r.RoundReached === -1).length;
      const finalesGC = rows.filter(r => r.RoundReached ===  0).length;
      const demisGC   = rows.filter(r => r.RoundReached ===  1).length;
      const recapParts = [];
      if (titresGC  > 0) recapParts.push(`🏆 ${titresGC} titre${titresGC > 1 ? 's' : ''}`);
      if (finalesGC > 0) recapParts.push(`🥈 ${finalesGC} finale${finalesGC > 1 ? 's' : ''}`);
      if (demisGC   > 0) recapParts.push(`🎯 ${demisGC} demi${demisGC > 1 ? 's' : ''}`);
      recapParts.push(`🎟️ ${totalPart} participation${totalPart > 1 ? 's' : ''}`);

      const fullText = lines.join('\n');
      const embed = new EmbedBuilder()
        .setColor(titresGC > 0 ? COLOR.gold : COLOR.tennis)
        .setTitle(`👤 ${player.ingame_name} (${pName}) — Parcours GC ATP`)
        .setDescription(recapParts.join('  ·  '))
        .addFields({ name: '📅 Historique par année', value: fullText.length <= 1024 ? fullText : fullText.slice(0, 1021) + '…' })
        .setFooter({ text: 'Tennis Manager 2026 · /tops gc · ATP uniquement' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (e) {
      console.error('[topsgc_moi] Erreur:', e.message);
      return interaction.editReply({ embeds: [err('Erreur lors du calcul du parcours GC.')] });
    } finally { s.close(); }
  });

  // ── Boutons tri Power Ranking ──────────────────────────────────────────────
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('pr_sort:')) return;

    const sortKey = interaction.customId.split(':')[1];
    if (!PR_SORT_CONFIGS[sortKey]) return;

    await interaction.deferUpdate();

    if (!seasonDbReady)
      return interaction.editReply({ embeds: [err('Save.db non disponible.')], components: [] });

    const ranking = await getPowerRankingData();
    if (!ranking)
      return interaction.editReply({ embeds: [err('Impossible de recalculer le Power Ranking.')], components: [] });

    return interaction.editReply({
      embeds: [buildPowerRankingEmbed(ranking, sortKey)],
      components: buildPowerRankingComponents(sortKey),
    });
  });


  // ── Boutons tournoi : navigation par année ─────────────────────────────────────
  client.on('interactionCreate', async (interaction) => {
	if (!interaction.isButton()) return;
	if (!interaction.customId.startsWith('tournoi_year:')) return;

	const parts   = interaction.customId.split(':');
	const tournId = parseInt(parts[1], 10);
	const annee   = parseInt(parts[2], 10);
	// parts[3] = tmId encodé dans le bouton (peut être absent pour vieux boutons)
	const encodedTmId = parts[3] ? parseInt(parts[3], 10) : null;

	if (isNaN(tournId) || isNaN(annee)) return;

	await interaction.deferReply({ ephemeral: true });

	if (!seasonDbReady)
	  return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

	// Résolution du joueur : tmId encodé dans le bouton, sinon Discord de l'utilisateur
	let tmId, pDisplayName;
	if (encodedTmId && !isNaN(encodedTmId)) {
	  tmId = encodedTmId;
	  const s0 = openSaveDb();
	  if (!s0) return interaction.editReply({ embeds: [err('Base de données non disponible.')] });
	  try {
		const pRow = s0.prepare('SELECT Firstname, Lastname FROM TennisPlayer WHERE Id=?').get(tmId);
		pDisplayName = pRow ? `${pRow.Firstname} ${pRow.Lastname}` : `Joueur #${tmId}`;
	  } finally { s0.close(); }
	} else {
	  const player = await db.get(interaction.user.id);
	  if (!player?.tm_player_id)
		return interaction.editReply({ embeds: [err('Tu n\'as pas de joueur lié.')] });
	  tmId = player.tm_player_id;
	  const s0 = openSaveDb();
	  if (!s0) return interaction.editReply({ embeds: [err('Base de données non disponible.')] });
	  try {
		const pRow = s0.prepare('SELECT Firstname, Lastname FROM TennisPlayer WHERE Id=?').get(tmId);
		pDisplayName = pRow ? `${pRow.Firstname} ${pRow.Lastname}` : `Joueur #${tmId}`;
	  } finally { s0.close(); }
	}

	const s = openSaveDb();
	if (!s) return interaction.editReply({ embeds: [err('Base de données non disponible.')] });

	try {
	  const tourn = s.prepare('SELECT Id, Name, CategoryId FROM Tournament WHERE Id=?').get(tournId);
	  if (!tourn)
		return interaction.editReply({ embeds: [err('Tournoi introuvable.')] });

	  // Résolution catégorie
	  let catLabel = TOURN_CAT[tourn.CategoryId];
	  let isJunior = false;
	  if (!catLabel) {
		try {
		  const row = s.prepare('SELECT Name FROM TournamentCategory WHERE Id=? LIMIT 1').get(tourn.CategoryId);
		  if (row?.Name) { catLabel = row.Name; isJunior = /junior|juniors/i.test(row.Name); }
		} catch {}
		catLabel = catLabel ?? `Cat. ${tourn.CategoryId}`;
	  }
	  if (!isJunior) isJunior = /junior|juniors/i.test(tourn.Name);
	  const _normCatId3 = isJunior ? tourn.CategoryId : normalizeTournCat(tourn.CategoryId, tourn.Name);
	  if (!isJunior && TOURN_CAT[_normCatId3]) catLabel = TOURN_CAT[_normCatId3];
	  const catEmoji   = isJunior ? '🎓' : (TOURN_CAT_EMOJI[_normCatId3] ?? '🎾');
	  const circuitTag = isJunior ? '🎓 Junior' : '🏆 ATP';
	  const ptsLabel   = isJunior ? 'Points Junior' : 'Points ATP';

	  const result = s.prepare(`
		SELECT tr.RoundReached, tr.EntryMode, tr.MoneyWon, tr.PointsMain, tr.EntryRank
		FROM TournamentResult tr
		WHERE tr.TournamentId = ? AND tr.PlayerId = ? AND tr.Year = ?
	  `).get(tournId, tmId, annee);

	  if (!result)
		return interaction.editReply({ embeds: [err(`Pas de participation à **${tourn.Name}** en **${annee}**.`)] });

	  const matches = s.prepare(`
		SELECT m.Round, m.Outcome, m.Player1Id, m.Player2Id,
			   m.Player1Set1Score, m.Player2Set1Score,
			   m.Player1Set2Score, m.Player2Set2Score,
			   m.Player1Set3Score, m.Player2Set3Score,
			   m.Player1Set4Score, m.Player2Set4Score,
			   m.Player1Set5Score, m.Player2Set5Score,
			   p1.Firstname AS P1First, p1.Lastname AS P1Last,
			   p2.Firstname AS P2First, p2.Lastname AS P2Last
		FROM Match m
		LEFT JOIN TennisPlayer p1 ON m.Player1Id = p1.Id
		LEFT JOIN TennisPlayer p2 ON m.Player2Id = p2.Id
		WHERE m.TournamentId = ? AND CAST(strftime('%Y', m.Date, 'unixepoch') AS INTEGER) = ?
		  AND (m.Player1Id = ? OR m.Player2Id = ?)
		  AND m.Outcome IN (2, 3)
		ORDER BY m.Round DESC
	  `).all(tournId, annee, tmId, tmId);

	  const MATCH_ROUND_LABEL = {
		'0': '🥈 Finale',    '1': '🥉 Demi-finale',
		'2': '⚡ Quart',      '3': '🎾 8ème',
		'4': '🎾 16ème',      '5': '🎾 32ème',
		'6': '🎾 64ème',      '7': '🔸 Qualif.',
		'8': '🔸 Qualif.',    '9': '🔸 Qualif.',
	  };
	  const ENTRY_MODE = { 0: 'Direct', 1: 'Wild Card', 2: 'Qualifié', 3: 'Lucky Loser', 4: 'Invité', 5: 'Protégé' };

	  const matchLines = matches.map(m => {
		const isP1    = m.Player1Id === tmId;
		const oppName = isP1
		  ? (m.P2First ? `${m.P2First} ${m.P2Last}` : 'Inconnu')
		  : (m.P1First ? `${m.P1First} ${m.P1Last}` : 'Inconnu');
		const won = (isP1 && m.Outcome === 2) || (!isP1 && m.Outcome === 3);
		const sets = [
		  [m.Player1Set1Score, m.Player2Set1Score],
		  [m.Player1Set2Score, m.Player2Set2Score],
		  [m.Player1Set3Score, m.Player2Set3Score],
		  [m.Player1Set4Score, m.Player2Set4Score],
		  [m.Player1Set5Score, m.Player2Set5Score],
		].filter(([a, b]) => a !== null && b !== null);
		const scoreStr = sets.map(([a, b]) => isP1 ? `${a}-${b}` : `${b}-${a}`).join('  ');
		const roundLabel = m.Round === 0 && result.RoundReached === -1
		  ? '🏆 Finale (Victoire)'
		  : (MATCH_ROUND_LABEL[String(m.Round)] ?? `Tour ${m.Round}`);
		return `${won ? '✅' : '❌'} **${roundLabel}** — ${won ? 'bat' : 'perd vs'} **${oppName}**${scoreStr ? `  \`${scoreStr}\`` : ''}`;
	  });

	  const rrLabel  = ROUND_LABEL[String(result.RoundReached)] ?? `Tour ${result.RoundReached}`;
	  const entryStr = ENTRY_MODE[result.EntryMode] ?? `Mode ${result.EntryMode}`;
	  const rankStr  = result.EntryRank > 0 ? ` (#${result.EntryRank} à l'entrée)` : '';

	  const summaryLines = [
		`🏁 **Résultat :** ${rrLabel}`,
		`🎟️ **Entrée :** ${entryStr}${rankStr}`,
		result.MoneyWon > 0 ? `💰 **Prize money :** ${result.MoneyWon.toLocaleString('fr-FR')} $` : null,
		result.PointsMain > 0 ? `📊 **${ptsLabel} :** ${result.PointsMain}` : null,
	  ].filter(Boolean).join('\n');

	  const embed = new EmbedBuilder()
		.setColor(result.RoundReached === -1 ? COLOR.gold : COLOR.tennis)
		.setTitle(`${catEmoji} ${tourn.Name} ${annee} · ${circuitTag}`)
		.setDescription(`Parcours de **${pDisplayName}** · ${catLabel}`)
		.addFields({ name: '📋 Résumé', value: summaryLines, inline: false })
		.setFooter({ text: 'Tennis Manager 2026 · /tournoi' })
		.setTimestamp();

	  if (matchLines.length > 0) {
		const full = matchLines.join('\n');
		embed.addFields({ name: '🗓️ Matchs', value: full.length <= 1024 ? full : full.slice(0, 1021) + '…', inline: false });
	  } else {
		embed.addFields({ name: '🗓️ Matchs', value: '_Détail non disponible_', inline: false });
	  }

	  return interaction.editReply({ embeds: [embed] });
	} finally {
	  s.close();
	}
  });

	  	  // ── Autocomplete ──────────────────────────────────────────────────────────────
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isAutocomplete()) return;
		if (interaction.commandName === 'boost') {
		  const focused = interaction.options.getFocused().toLowerCase();
		  const choices = BOOSTABLE_STATS
			.filter(([k, l]) => l.toLowerCase().includes(focused) || k.toLowerCase().includes(focused))
			.slice(0, 25)
			.map(([k, l]) => ({ name: l, value: k }));
		  await interaction.respond(choices);
		}
	  });

	  // ── Commandes slash (existant) ────────────────────────────────────────────────
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isChatInputCommand()) return;
		console.log(`[Cmd] /${interaction.commandName} par ${interaction.user.tag} (${interaction.user.id})`);
		try {
		  await handleCommand(interaction);
		} catch (e) {
		  console.error(`[Cmd] Erreur /${interaction.commandName}:`, e);
		  const msg = { content: '❌ Une erreur est survenue.', ephemeral: true };
		  if (interaction.replied || interaction.deferred) interaction.followUp(msg);
		  else interaction.reply(msg);
		}
	  });

	  // ── Navigation profil : boutons ─────────────────────────────────────────────
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isButton()) return;
		if (!interaction.customId.startsWith('pnav:')) return;

		const parts  = interaction.customId.split(':');
		const action = parts[1];
		const tmName = parts.slice(2).join(':');

		if (!seasonDbReady)
		  return interaction.reply({ embeds: [err('Save.db non disponible.')], ephemeral: true });

		const results = getTmPlayerByName(tmName);
		if (!results.length)
		  return interaction.reply({ embeds: [err(`Joueur **${tmName}** introuvable.`)], ephemeral: true });
		const r = results[0];

		if (action === 'stats') {
		  await interaction.deferReply({ ephemeral: true });
		  const tm   = getTmPlayerData(r.Id);
		  if (!tm) return interaction.editReply({ embeds: [err('Impossible de lire les stats.')] });
		  const forme     = getTmForme(r.Id);
		  const rivalites = getTmRivalites(r.Id);
		  return interaction.editReply({ embeds: [buildPublicStatsEmbed(tm, forme, rivalites)] });
		}

		if (action === 'palmares') {
		  await interaction.deferReply({ ephemeral: true });
		  const palmares = getTmPalmares(r.Id);
		  if (!palmares) return interaction.editReply({ embeds: [err('Impossible de lire le palmarès.')] });
		  return interaction.editReply({ embeds: [buildPalmaresEmbed(r, palmares)] });
		}

		if (action === 'historique') {
		  await interaction.deferReply({ ephemeral: true });
		  const s2 = openSaveDb();
		  if (!s2) return interaction.editReply({ embeds: [err('Save.db non disponible.')] });
		  let pRow;
		  try { pRow = s2.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(r.Id); }
		  finally { s2.close(); }
		  const timeline = getTmHistorique(r.Id);
		  return interaction.editReply({ embeds: [buildHistoriqueEmbed(pRow, timeline)] });
		}

		if (action === 'attributs') {
		  await interaction.deferReply({ ephemeral: true });
		  const s2 = openSaveDb();
		  if (!s2) return interaction.editReply({ embeds: [err('Save.db non disponible.')] });
		  let pRow;
		  try { pRow = s2.prepare('SELECT * FROM TennisPlayer WHERE Id=?').get(r.Id); }
		  finally { s2.close(); }
		  const fakeP = { ingame_name: `${pRow.Firstname} ${pRow.Lastname}` };
		  return interaction.editReply({ embeds: [buildAttributesEmbed(fakeP, pRow, null)] });
		}

		if (action === 'coins') {
		  await interaction.deferReply({ ephemeral: true });
		  const player = await db.get(interaction.user.id);
		  if (!player) return interaction.editReply({ embeds: [err('Tu n\'as pas de compte Discord lié.')] });
		  return interaction.editReply({ embeds: [buildWalletEmbed(player, await db.txHistory(interaction.user.id))] });
		}

		if (action === 'h2h') {
		  // Ouvrir un modal pour saisir le nom de l'adversaire
		  const modal = new ModalBuilder()
			.setCustomId(`pnav_h2h_modal:${tmName}`)
			.setTitle(`🎾 H2H — vs ${tmName}`);
		  modal.addComponents(
			new ActionRowBuilder().addComponents(
			  new TextInputBuilder()
				.setCustomId('h2h_adversaire')
				.setLabel('Prénom / Nom de l\'adversaire')
				.setStyle(TextInputStyle.Short)
				.setMinLength(2).setMaxLength(50)
				.setPlaceholder('ex: Novak Djokovic')
				.setRequired(true)
			)
		  );
		  return interaction.showModal(modal);
		}
	  });

	  // ── Navigation profil : modal H2H submit ─────────────────────────────────────
	  client.on('interactionCreate', async (interaction) => {
		if (!interaction.isModalSubmit()) return;
		if (!interaction.customId.startsWith('pnav_h2h_modal:')) return;

		await interaction.deferReply({ ephemeral: true });

		const tmName1 = interaction.customId.split(':').slice(1).join(':');
		const tmName2 = interaction.fields.getTextInputValue('h2h_adversaire').trim();

		const r1 = getTmPlayerByName(tmName1);
		const r2 = getTmPlayerByName(tmName2);

		if (!r1.length) return interaction.editReply({ embeds: [err(`Joueur **${tmName1}** introuvable.`)] });
		if (!r2.length) return interaction.editReply({ embeds: [err(`Joueur **"${tmName2}"** introuvable dans le save.db.`)] });
		if (r1[0].Id === r2[0].Id) return interaction.editReply({ embeds: [err('Les deux joueurs sont identiques.')] });

		const h2h    = getH2H(r1[0].Id, r2[0].Id);
		if (!h2h) return interaction.editReply({ embeds: [err('Impossible de calculer le H2H.')] });
		const stats1 = getTmRawStats(r1[0].Id);
		const stats2 = getTmRawStats(r2[0].Id);
		return interaction.editReply({ embeds: [buildH2HEmbed(r1[0], r2[0], h2h, stats1, stats2)] });
	  });


	  console.log('[Discord] Connexion en cours...');
	  client.login(process.env.DISCORD_TOKEN).catch((e) => {
		console.error('[Discord] ❌ Échec du login :', e.message);
		process.exit(1);
	  });
	}

	startBot();
