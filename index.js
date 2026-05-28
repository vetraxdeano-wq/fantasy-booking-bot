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
	console.log('[Boot] ═══════════════════════════════════════════════');
	console.log('[Boot] 🎾 Tennis Manager 2026 — démarrage...');
	console.log(`[Boot] DISCORD_TOKEN  : ${process.env.DISCORD_TOKEN  ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] CLIENT_ID      : ${process.env.CLIENT_ID      ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] GUILD_ID       : ${process.env.GUILD_ID       ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] SUPABASE_URL   : ${process.env.SUPABASE_URL   ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] SUPABASE_KEY   : ${process.env.SUPABASE_KEY   ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] SUPABASE_BUCKET: ${process.env.SUPABASE_BUCKET ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] SUPABASE_FILE  : ${process.env.SUPABASE_FILE  ? '✅ défini' : '❌ MANQUANT'}`);
	console.log(`[Boot] RENDER_EXTERNAL_URL: ${process.env.RENDER_EXTERNAL_URL ?? '⚠️  non défini (keep-alive désactivé)'}`);
	console.log('[Boot] ═══════════════════════════════════════════════');
	console.log('[Boot] Téléchargement du save.db depuis Supabase...');
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
	//  BASE DE DONNÉES JOUEURS — Supabase (persistante, survive aux re-deploys)
	//  Tables requises dans Supabase :
	//    players(discord_id text PK, username text, ingame_name text,
	//            nationality text, playstyle text, tm_player_id int8,
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
		});
	  },
	  linkTm: async (id, tmId) => {
		await supabase.from('players').update({ tm_player_id: tmId }).eq('discord_id', id);
	  },
	  addCoins: async (id, n, r) => {
		const { data: p } = await supabase.from('players').select('coins').eq('discord_id', id).single();
		if (!p) return;
		await supabase.from('players').update({ coins: p.coins + n }).eq('discord_id', id);
		await supabase.from('transactions').insert({ discord_id: id, amount: n, reason: r ?? 'Gain' });
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

	// ── Catégories de tournois ───────────────────────────────────────────────────
	const TOURN_CAT = { 0: 'Grand Chelem', 1: 'Masters 1000', 2: 'ATP 500', 3: 'ATP 250', 4: 'Masters Cup' };
	const TOURN_CAT_EMOJI = { 0: '🏆', 1: '🥇', 2: '🥈', 3: '🥉', 4: '👑' };

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
		// Cherche les matchs dans MatchResult où les deux joueurs s'affrontent
		// Structure TM2026 : MatchResult(WinnerId, LoserId, TournamentId, Round, Date, ...)
		const wins1 = s.prepare(`
		  SELECT COUNT(*) AS cnt FROM MatchResult
		  WHERE WinnerId=? AND LoserId=?
		`).get(id1, id2)?.cnt ?? 0;

		const wins2 = s.prepare(`
		  SELECT COUNT(*) AS cnt FROM MatchResult
		  WHERE WinnerId=? AND LoserId=?
		`).get(id2, id1)?.cnt ?? 0;

		// Derniers matchs entre les deux
		const meetings = s.prepare(`
		  SELECT mr.*, t.Name AS TournName, t.Category
		  FROM MatchResult mr
		  JOIN Tournament t ON t.Id = mr.TournamentId
		  WHERE (mr.WinnerId=? AND mr.LoserId=?) OR (mr.WinnerId=? AND mr.LoserId=?)
		  ORDER BY mr.Date DESC LIMIT 10
		`).all(id1, id2, id2, id1);

		// Surface breakdown
		const surfH2H = s.prepare(`
		  SELECT mr.Surface, 
		    SUM(CASE WHEN mr.WinnerId=? THEN 1 ELSE 0 END) AS w1,
		    SUM(CASE WHEN mr.WinnerId=? THEN 1 ELSE 0 END) AS w2,
		    COUNT(*) AS total
		  FROM MatchResult mr
		  WHERE (mr.WinnerId=? AND mr.LoserId=?) OR (mr.WinnerId=? AND mr.LoserId=?)
		  GROUP BY mr.Surface
		`).all(id1, id2, id1, id2, id2, id1);

		return { wins1, wins2, meetings, surfH2H };
	  } catch (e) { console.error('H2H error:', e.message); return null; }
	  finally { s.close(); }
	}

	// Palmarès filtré par catégorie (Grand Chelem, Masters 1000, etc.)
	function getTmPalmares(tmId) {
	  const s = openSaveDb();
	  if (!s) return null;
	  try {
		const titles = s.prepare(`
		  SELECT t.Name, t.Category, tr.Year, tr.MoneyWon, tr.RoundReached
		  FROM TournamentResult tr JOIN Tournament t ON t.Id=tr.TournamentId
		  WHERE tr.PlayerId=? AND tr.RoundReached=-1
		  ORDER BY t.Category ASC, tr.Year DESC
		`).all(tmId);

		const finals = s.prepare(`
		  SELECT t.Name, t.Category, tr.Year, tr.RoundReached
		  FROM TournamentResult tr JOIN Tournament t ON t.Id=tr.TournamentId
		  WHERE tr.PlayerId=? AND tr.RoundReached=0
		  ORDER BY t.Category ASC, tr.Year DESC
		`).all(tmId);

		// SF et QF aussi
		const sf = s.prepare(`
		  SELECT t.Name, t.Category, tr.Year, tr.RoundReached
		  FROM TournamentResult tr JOIN Tournament t ON t.Id=tr.TournamentId
		  WHERE tr.PlayerId=? AND tr.RoundReached=1
		  ORDER BY t.Category ASC, tr.Year DESC
		`).all(tmId);

		// Grouper les titres par catégorie
		const byCategory = {};
		for (const r of titles) {
		  const cat = r.Category ?? 3;
		  if (!byCategory[cat]) byCategory[cat] = [];
		  byCategory[cat].push(r);
		}

		return { titles, finals, sf, byCategory };
	  } catch (e) { console.error('Palmares error:', e.message); return null; }
	  finally { s.close(); }
	}

	// Top classement mondial TM
	function getTmClassement(limit = 20) {
	  const s = openSaveDb();
	  if (!s) return [];
	  try {
		return s.prepare(`
		  SELECT tp.Id, tp.Firstname, tp.Lastname, tp.Country,
		    r.Rank, r.Points
		  FROM TennisPlayer tp
		  JOIN Ranking r ON r.PlayerId = tp.Id
		  WHERE tp.Retired=0 AND r.Circuit=0
		    AND r.Date = (SELECT MAX(Date) FROM Ranking WHERE PlayerId=tp.Id AND Circuit=0)
		  ORDER BY r.Rank ASC LIMIT ?
		`).all(limit);
	  } catch (e) { console.error('Classement error:', e.message); return []; }
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
		.setDescription(`${player.ingame_name ? `Profil : **${player.ingame_name}** | ` : ''}Potentiel : **${(p.Potential ?? 0).toFixed(1)}/20**`)
		.setFooter({ text: 'Tennis Manager 2026 — Attributs' })
		.setTimestamp();

	  if (avatarUrl) embed.setThumbnail(avatarUrl);

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
		  `${t.amount > 0 ? '📈' : '📉'} \`${t.amount > 0 ? '+' : ''}${t.amount}\` — ${t.reason} *(${t.created_at.split('T')[0]})*`
		).join('\n');
		embed.addFields({ name: '📋 Dernières transactions', value: lines });
	  }
	  return embed;
	}

	function buildPublicStatsEmbed(tm) {
	  const { p, rank, race, stats, surfStats, titles, finals, lastResults, totalMoney, injuries } = tm;
	  const name = `${p.Firstname} ${p.Lastname}`;
	  const embed = new EmbedBuilder()
		.setColor(COLOR.tennis)
		.setTitle(`🎾 ${name} (${p.Country ?? '??'})`)
		.setDescription(
		  `${HAND_LABEL[p.Hand] ?? ''} — ${BH_LABEL[p.Backhand] ?? ''} | Age : **${age(p.Birthdate)}** ans\n` +
		  `Classement : **#${rank.Rank ?? '?'}** (${(rank.Points ?? 0).toLocaleString()} pts) | Race : **#${race.RaceRank ?? '?'}**`
		)
		.setFooter({ text: 'Tennis Manager 2026 — Stats publiques' })
		.setTimestamp();

	  embed.addFields(
		{ name: '🏆 Titres', value: `**${titles}**`, inline: true },
		{ name: '🥈 Finales', value: `**${finals}**`, inline: true },
		{ name: '📊 Bilan', value: stats.played ? `**${stats.won}V** / ${stats.played - stats.won}D (${pct(stats.won, stats.played)})` : '—', inline: true },
	  );

	  if (stats.played) {
		embed.addFields(
		  { name: '🎾 Aces', value: `${stats.aces ?? 0}`, inline: true },
		  { name: '💥 1er service', value: pct(stats.fs1w, stats.fs1p), inline: true },
		  { name: '⚡ BP convertis', value: pct(stats.bpConv, stats.bpOpp), inline: true },
		);
	  }

	  if (surfStats.length) {
		const lines = surfStats.map(s =>
		  `${SURFACE_LABEL[s.Surface] ?? `Surface ${s.Surface}`} : **${s.w}V/${s.p - s.w}D** (${pct(s.w, s.p)})`
		).join('\n');
		embed.addFields({ name: '🌍 Bilan par surface', value: lines });
	  }

	  if (lastResults.length) {
		const lines = lastResults.map(r =>
		  `${ROUND_LABEL[String(r.RoundReached)] ?? `R${r.RoundReached}`} — **${r.Name}** (${r.Year})`
		).join('\n');
		embed.addFields({ name: '📋 Derniers résultats', value: lines });
	  }

	  if (injuries.length) {
		embed.addFields({ name: '🩹 Blessures', value: injuries.map(i => `• Zone ${i.Zone} (Type ${i.Type})`).join('\n') });
	  }

	  embed.addFields({ name: '💵 Gains carrière', value: moneyFmt(totalMoney), inline: true });
	  return embed;
	}

	function buildH2HEmbed(p1, p2, h2h) {
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

	  // Derniers matchs
	  if (h2h.meetings.length) {
		const lines = h2h.meetings.map(m => {
		  const winner = m.WinnerId === p1.Id ? name1 : name2;
		  const catLabel = TOURN_CAT_EMOJI[m.Category] ?? '🎾';
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

	  const totalTitles = palmares.titles.length;
	  const totalFinals = palmares.finals.length;
	  embed.setDescription(`**${totalTitles}** titre${totalTitles > 1 ? 's' : ''} — **${totalFinals}** finale${totalFinals > 1 ? 's' : ''}`);

	  // Titres par catégorie
	  for (const [cat, results] of Object.entries(palmares.byCategory).sort((a, b) => a[0] - b[0])) {
		const label = `${TOURN_CAT_EMOJI[cat] ?? '🎾'} ${TOURN_CAT[cat] ?? `Cat. ${cat}`}`;
		const lines = results.map(r => `• **${r.Name}** (${r.Year})`).join('\n');
		embed.addFields({ name: `${label} — ${results.length} titre${results.length > 1 ? 's' : ''}`, value: lines.slice(0, 1024) });
	  }

	  if (totalTitles === 0) {
		embed.addFields({ name: 'Titres', value: '*Aucun titre remporté.*' });
	  }

	  // Finales perdues (top 5 par catégorie importante)
	  const importantFinals = palmares.finals.filter(f => (f.Category ?? 3) <= 1).slice(0, 5);
	  if (importantFinals.length) {
		const lines = importantFinals.map(r =>
		  `• ${TOURN_CAT_EMOJI[r.Category] ?? '🎾'} **${r.Name}** (${r.Year})`
		).join('\n');
		embed.addFields({ name: '🥈 Finales perdues (GC/M1000)', value: lines });
	  }

	  return embed;
	}

	function buildClassementEmbed(rows) {
	  const embed = new EmbedBuilder()
		.setColor(COLOR.tennis)
		.setTitle('🌍 Classement ATP — Top 20')
		.setFooter({ text: 'Tennis Manager 2026 — Classement' })
		.setTimestamp();

	  if (!rows.length) {
		embed.setDescription('*Classement non disponible.*');
		return embed;
	  }

	  const medals = ['🥇', '🥈', '🥉'];
	  const lines = rows.map((r, i) => {
		const prefix = medals[i] ?? `**${r.Rank}.**`;
		return `${prefix} ${r.Firstname} ${r.Lastname} (${r.Country ?? '??'}) — ${(r.Points ?? 0).toLocaleString()} pts`;
	  }).join('\n');

	  embed.setDescription(lines);
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
		.setName('classement')
		.setDescription('Classement ATP mondial du save.db (Top 20)'),

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
		await interaction.deferReply({ ephemeral: true });
		if (await db.exists(interaction.user.id))
		  return interaction.editReply({ embeds: [err('Tu as déjà un joueur ! Utilise `/profil`.')] });

		const ingameName  = interaction.options.getString('nom').trim();
		const nationality = interaction.options.getString('nationalite').trim();
		const playstyle   = interaction.options.getString('style');

		if (ingameName.length < 2 || ingameName.length > 32)
		  return interaction.editReply({ embeds: [err('Le nom doit faire entre 2 et 32 caractères.')] });
		if (await db.nameTaken(ingameName))
		  return interaction.editReply({ embeds: [err(`Le nom **${ingameName}** est déjà pris.`)] });

		await db.create({ discordId: interaction.user.id, username: interaction.user.username, ingameName, nationality, playstyle });
		return interaction.editReply({ embeds: [ok('Joueur créé !',
		  `Bienvenue **${ingameName}** 🎾\n\n` +
		  `🌍 **${nationality}** — ${PLAYSTYLE_EMOJI[playstyle] ?? ''} ${playstyle}\n` +
		  `💰 Solde de départ : **500 🪙**\n\n` +
		  `Utilise \`/link <nom>\` pour associer ton joueur TM2026 et afficher tes vraies stats !`
		)]});
	  }

	  // ── /link ─────────────────────────────────────────────────────────────────────
	  if (cmd === 'link') {
		await interaction.deferReply({ ephemeral: true });
		const player = await db.get(interaction.user.id);
		if (!player)
		  return interaction.editReply({ embeds: [err('Crée d\'abord ton profil avec `/inscription`.')] });

		if (!seasonDbReady)
		  return interaction.editReply({ embeds: [err('Save.db non disponible. Vérifie la configuration Supabase.')] });

		const query   = interaction.options.getString('nom').trim();
		const results = searchTmPlayers(query);

		if (!results.length)
		  return interaction.editReply({ embeds: [err(`Aucun joueur trouvé pour **"${query}"** dans le save.db.`)] });

		if (results.length === 1) {
		  const tm = results[0];
		  await db.linkTm(interaction.user.id, tm.Id);
		  return interaction.editReply({ embeds: [ok('Joueur lié !',
			`**${player.ingame_name}** est maintenant lié à **${tm.Firstname} ${tm.Lastname}** (${tm.Country}).\n\nUtilise \`/profil\` pour voir tes stats complets !`
		  )]});
		}

		const lines = results.map((tm, i) =>
		  `\`${i + 1}.\` **${tm.Firstname} ${tm.Lastname}** (${tm.Country}) — ID \`${tm.Id}\``
		).join('\n');
		return interaction.editReply({ embeds: [
		  new EmbedBuilder().setColor(COLOR.blue)
			.setTitle('🔍 Plusieurs joueurs trouvés')
			.setDescription(`${lines}\n\nRefais \`/link\` avec le prénom + nom complet pour préciser.`)
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
			  `\`${i + 1}.\` **${r.Firstname} ${r.Lastname}** (${r.Country})`
			).join('\n');
			return interaction.editReply({ embeds: [
			  new EmbedBuilder().setColor(COLOR.blue)
				.setTitle('🔍 Plusieurs joueurs trouvés')
				.setDescription(`${lines}\n\nPrécise le prénom + nom complet.`)
			] });
		  }
		  const tm = getTmPlayerData(results[0].Id);
		  if (!tm) return interaction.editReply({ embeds: [err('Impossible de lire les stats de ce joueur.')] });
		  // Embed sans profil Discord
		  const p = tm.p;
		  const embedTm = new EmbedBuilder()
			.setColor(COLOR.tennis)
			.setTitle(`🎾 ${p.Firstname} ${p.Lastname} (${p.Country ?? '—'})`)
			.setDescription(`${HAND_LABEL[p.Handedness] ?? '—'} — ${BH_LABEL[p.BackhandStyle] ?? '—'}`)
			.setFooter({ text: 'Tennis Manager 2026 — Profil TM' })
			.setTimestamp();
		  embedTm.addFields(
			{ name: '📈 Rang ATP',   value: tm.rank.Rank != null ? `**#${tm.rank.Rank}**` : '—', inline: true },
			{ name: '🔢 Points',     value: tm.rank.Points != null ? `${tm.rank.Points}` : '—',  inline: true },
			{ name: '🏆 Titres',     value: `**${tm.titles}**`,                                   inline: true },
			{ name: '🥈 Finales',    value: `**${tm.finals}**`,                                   inline: true },
			{ name: '📊 Bilan',      value: tm.stats.played ? `**${tm.stats.won}V** / ${tm.stats.played - tm.stats.won}D (${pct(tm.stats.won, tm.stats.played)})` : '—', inline: true },
			{ name: '💵 Prize money',value: moneyFmt(tm.totalMoney),                              inline: true },
			{ name: '⭐ Potentiel',  value: `${(p.Potential ?? 0).toFixed(1)}/20`,               inline: true },
			{ name: '💪 Condition',  value: `${p.PhysicalCondition ?? '—'}/100`,                 inline: true },
			{ name: '❤️ Moral',      value: `${p.Morale ?? '—'}/100`,                            inline: true },
		  );
		  if (tm.surfStats.length) {
			const lines = tm.surfStats.map(s =>
			  `${SURFACE_LABEL[s.Surface] ?? `Surface ${s.Surface}`} : **${s.w}V/${s.p - s.w}D** (${pct(s.w, s.p)})`
			).join('\n');
			embedTm.addFields({ name: '🌍 Bilan par surface', value: lines });
		  }
		  if (tm.lastResults.length) {
			const lines = tm.lastResults.map(r =>
			  `${ROUND_LABEL[String(r.RoundReached)] ?? `R${r.RoundReached}`} — **${r.Name}** (${r.Year})`
			).join('\n');
			embedTm.addFields({ name: '📋 Derniers résultats', value: lines });
		  }
		  return interaction.editReply({ embeds: [embedTm] });
		}

		// Mode Discord : joueur mentionné ou soi-même
		const target = interaction.options.getUser('joueur') ?? interaction.user;
		const player = await db.get(target.id);

		if (!player) {
		  return interaction.editReply({ embeds: [err(
			target.id === interaction.user.id
			  ? 'Pas encore de joueur. Utilise `/inscription` !'
			  : `**${target.username}** n'a pas de joueur.`
		  )] });
		}

		const tmData = player.tm_player_id ? getTmPlayerData(player.tm_player_id) : null;
		return interaction.editReply({
		  embeds: [buildProfileEmbed(player, tmData, target.displayAvatarURL({ dynamic: true }))]
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
			  `\`${i + 1}.\` **${r.Firstname} ${r.Lastname}** (${r.Country})`
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
		  return interaction.editReply({ embeds: [err(target.id === interaction.user.id ? 'Pas encore de joueur. Utilise `/inscription` !' : `**${target.username}** n'a pas de joueur.`)] });

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

		return interaction.editReply({
		  embeds: [buildAttributesEmbed(player, p, target.displayAvatarURL({ dynamic: true }))]
		});
	  }

	  // ── /coins ────────────────────────────────────────────────────────────────────
	  if (cmd === 'coins') {
		await interaction.deferReply({ ephemeral: true });
		const player = await db.get(interaction.user.id);
		if (!player)
		  return interaction.editReply({ embeds: [err('Pas encore de joueur. Utilise `/inscription` !')] });
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
			`\`${i + 1}.\` **${r.Firstname} ${r.Lastname}** (${r.Country})`
		  ).join('\n');
		  return interaction.editReply({ embeds: [
			new EmbedBuilder().setColor(COLOR.blue)
			  .setTitle('🔍 Plusieurs joueurs trouvés')
			  .setDescription(`${lines}\n\nPrécise le prénom + nom complet.`)
		  ] });
		}

		const tm = getTmPlayerData(results[0].Id);
		if (!tm) return interaction.editReply({ embeds: [err('Impossible de lire les stats de ce joueur.')] });

		return interaction.editReply({ embeds: [buildPublicStatsEmbed(tm)] });
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

		return interaction.editReply({ embeds: [buildH2HEmbed(p1, p2, h2h)] });
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
			`\`${i + 1}.\` **${r.Firstname} ${r.Lastname}** (${r.Country})`
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

	  // ── /classement ──────────────────────────────────────────────────────────────
	  if (cmd === 'classement') {
		await interaction.deferReply();
		if (!seasonDbReady)
		  return interaction.editReply({ embeds: [err('Save.db non disponible.')] });

		const rows = getTmClassement(20);
		return interaction.editReply({ embeds: [buildClassementEmbed(rows)] });
	  }

	  // ── /admin ────────────────────────────────────────────────────────────────────
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

	// ── Démarrage du client Discord ──────────────────────────────────────────────
	// Si --deploy est passé en argument, on déploie les commandes PUIS on démarre
	// le bot (comportement Render : la Start Command est toujours "node index.js").
	// Pour un deploy one-shot depuis ta machine : node index.js --deploy --exit
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
	  });

	  client.on('disconnect', () => console.warn('[Discord] ⚠️  Déconnecté !'));
	  client.on('error',      (e) => console.error('[Discord] Erreur client :', e));
	  client.on('warn',       (w) => console.warn('[Discord] Avertissement :', w));

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

	  console.log('[Discord] Connexion en cours...');
	  client.login(process.env.DISCORD_TOKEN).catch((e) => {
		console.error('[Discord] ❌ Échec du login :', e.message);
		process.exit(1);
	  });
	}

	startBot();
