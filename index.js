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
		});
	  },
	  delete: async (id) => {
		await supabase.from('transactions').delete().eq('discord_id', id);
		await supabase.from('players').delete().eq('discord_id', id);
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
		.setName('creer-joueur')
		.setDescription('Crée ton joueur dans la simulation TM2026 (un seul par compte Discord)'),

	  new SlashCommandBuilder()
		.setName('supprimer-joueur')
		.setDescription('(Admin) Supprimer le joueur d\'un utilisateur pour les tests')
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.addUserOption(o => o.setName('cible').setDescription('Utilisateur Discord dont supprimer le joueur').setRequired(true)),

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

	// ── /creer-joueur ─────────────────────────────────────────────────────────────
	//  Étape 1 : vérification existence → envoi du Modal (identité)
	if (cmd === 'creer-joueur') {
		if (await db.exists(interaction.user.id))
		  return interaction.reply({ embeds: [err('Tu as déjà un joueur ! Utilise `/profil`.')], ephemeral: true });

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
		return interaction.reply({ embeds: [ok('Joueur supprimé', `Le joueur de <@${target.id}> a été supprimé.\nIl peut relancer \`/creer-joueur\`.`)], ephemeral: true });
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

	  // ══════════════════════════════════════════════════════════════════════════════
	  //  SESSION STORE : données de création de joueur (évite les customId trop longs)
	  // ══════════════════════════════════════════════════════════════════════════════
	  const cjSessions = new Map(); // userId → { n, p, s, t1, t2 }

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
		  .setLabel('➡️ Renseigner les attributs (1/3)')
		  .setStyle(ButtonStyle.Primary);
		return interaction.reply({
		  embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('✅ Taille et poids enregistrés !\nClique sur le bouton ci-dessous pour saisir tes attributs techniques.')],
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
		  .setTitle('Attributs (1/3) — 180 pts, max 20/stat');
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
		const a1 = { puiss_serv: parseAttr('a_puiss_serv'), effet_serv: parseAttr('a_effet_serv'), reg_serv: parseAttr('a_reg_serv'), cd: parseAttr('a_cd'), reg_cd: parseAttr('a_reg_cd') };
		for (const [k, v] of Object.entries(a1)) {
		  if (v === null || v < 1 || v > 20)
			return interaction.reply({ embeds: [err(`Valeur invalide pour "${k}". Chaque stat doit être entre 1 et 20.`)], ephemeral: true });
		}
		cjSessions.set(interaction.user.id, { ...sess10, a1 });

		const btnAttr2 = new ButtonBuilder()
		  .setCustomId(`cj_open_attr2:${interaction.user.id}`)
		  .setLabel('➡️ Attributs techniques (2/3)')
		  .setStyle(ButtonStyle.Primary);
		return interaction.reply({
		  embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('✅ Attributs 1/3 enregistrés !')],
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
		  .setTitle('Attributs techniques (2/3)');
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
		const a2 = { revers: parseAttr('a_revers'), reg_rv: parseAttr('a_reg_rv'), retour: parseAttr('a_retour'), contre: parseAttr('a_contre'), volee: parseAttr('a_volee') };
		for (const [k, v] of Object.entries(a2)) {
		  if (v === null || v < 1 || v > 20)
			return interaction.reply({ embeds: [err(`Valeur invalide pour "${k}". Chaque stat doit être entre 1 et 20.`)], ephemeral: true });
		}
		cjSessions.set(interaction.user.id, { ...sess11, a2 });

		const btnAttr3 = new ButtonBuilder()
		  .setCustomId(`cj_open_attr3:${interaction.user.id}`)
		  .setLabel('➡️ Attributs techniques (3/3)')
		  .setStyle(ButtonStyle.Primary);
		return interaction.reply({
		  embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('✅ Attributs 2/3 enregistrés !')],
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
		  .setTitle('Attributs techniques (3/3)');
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
		const a3 = { lift: parseAttr('a_lift'), coupe: parseAttr('a_coupe'), amorti: parseAttr('a_amorti'), controle: parseAttr('a_controle'), timing: parseAttr('a_timing') };
		for (const [k, v] of Object.entries(a3)) {
		  if (v === null || v < 1 || v > 20)
			return interaction.reply({ embeds: [err(`Valeur invalide pour "${k}". Chaque stat doit être entre 1 et 20.`)], ephemeral: true });
		}

		const allAttrs = { ...prev.a1, ...prev.a2, ...a3 };
		const total = Object.values(allAttrs).reduce((s, v) => s + v, 0);
		if (total !== 180) {
		  return interaction.reply({
			embeds: [err(`Total des attributs = **${total}/180**. Tu dois répartir exactement 180 points. Relance \`/creer-joueur\`.`)],
			ephemeral: true,
		  });
		}

		cjSessions.set(interaction.user.id, { ...prev, a3 });

		const btnPhysAttr = new ButtonBuilder()
		  .setCustomId(`cj_open_physattr:${interaction.user.id}`)
		  .setLabel('➡️ Attributs physiques')
		  .setStyle(ButtonStyle.Primary);
		return interaction.reply({
		  embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('✅ Attributs 3/3 enregistrés ! Total technique : **180/180** ✅')],
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
		  .setTitle('Attributs physiques — 80 pts, max 20/stat');
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

		const physAttrs = {
		  acceleration:    parseAttr('p_accel'),
		  jeu_de_jambes:   parseAttr('p_jambes'),
		  equilibre:       parseAttr('p_equilibre'),
		  agilite:         parseAttr('p_agilite'),
		  capacite_physique: parseAttr('p_capa_phys'),
		};

		// Note: endurance est calculée automatiquement pour atteindre exactement 80 pts
		const sumFive = Object.values(physAttrs).reduce((s, v) => s + (v ?? 0), 0);
		for (const [k, v] of Object.entries(physAttrs)) {
		  if (v === null || v < 1 || v > 20)
			return interaction.reply({ embeds: [err(`Valeur invalide pour "${k}". Chaque stat doit être entre 1 et 20.`)], ephemeral: true });
		}
		const endurance = 80 - sumFive;
		if (endurance < 1 || endurance > 20) {
		  return interaction.reply({
			embeds: [err(`Total des 5 stats = **${sumFive}**. L'endurance calculée automatiquement serait **${endurance}** (doit être entre 1 et 20). Ajuste tes valeurs pour que le total des 5 stats soit entre 60 et 79. Relance \`/creer-joueur\`.`)],
			ephemeral: true,
		  });
		}
		physAttrs.endurance = endurance;

		const allAttrs = { ...prev.a1, ...prev.a2, ...prev.a3 };
		const totalTech = Object.values(allAttrs).reduce((s, v) => s + v, 0);

		cjSessions.delete(interaction.user.id);

		// Vérifications finales
		if (await db.exists(interaction.user.id))
		  return interaction.reply({ embeds: [err('Tu as déjà un joueur ! Utilise `/profil`.')], ephemeral: true });
		if (await db.nameTaken(prev.n))
		  return interaction.reply({ embeds: [err(`Le nom **${prev.n}** a été pris entre-temps. Relance \`/creer-joueur\`.`)], ephemeral: true });

		await db.create({
		  discordId:   interaction.user.id,
		  username:    interaction.user.username,
		  ingameName:  prev.n,
		  nationality: prev.p,
		  trait1:      prev.t1,
		  trait2:      prev.t2,
		  trait3:      prev.t3,
		  mainHand:    prev.main,
		  backhand:    prev.revers,
		  taille:      prev.taille,
		  poids:       prev.poids,
		  attrs:       allAttrs,
		  physAttrs:   physAttrs,
		});

		const traitsLine = `🧠 **${prev.t1}** · **${prev.t2}** · **${prev.t3}**`;
		const statsBlock =
		  `🎯 **Service** — Puissance: ${allAttrs.puiss_serv} · Effet: ${allAttrs.effet_serv} · Régularité: ${allAttrs.reg_serv}\n` +
		  `🏓 **Fond** — CD: ${allAttrs.cd} (rég. ${allAttrs.reg_cd}) · RV: ${allAttrs.revers} (rég. ${allAttrs.reg_rv})\n` +
		  `⚡ **Divers** — Retour: ${allAttrs.retour} · Contre: ${allAttrs.contre} · Volée: ${allAttrs.volee}\n` +
		  `🔄 **Effets** — Lift: ${allAttrs.lift} · Coupé: ${allAttrs.coupe} · Amorti: ${allAttrs.amorti}\n` +
		  `🎛️ **Précision** — Contrôle: ${allAttrs.controle} · Timing: ${allAttrs.timing}\n` +
		  `📊 **Total technique : ${totalTech}/180**\n\n` +
		  `🏃 **Physique** — Accél: ${physAttrs.acceleration} · Jambes: ${physAttrs.jeu_de_jambes} · Équilibre: ${physAttrs.equilibre} · Agilité: ${physAttrs.agilite} · Capa: ${physAttrs.capacite_physique} · Endurance: ${physAttrs.endurance}\n` +
		  `📊 **Total physique : 80/80**`;

		return interaction.reply({
		  ephemeral: true,
		  embeds: [ok('Joueur créé ! 🎾',
			`Bienvenue **${prev.n}** !\n\n` +
			`🌍 ${prev.p}  —  ${prev.main} · Revers ${prev.revers}  —  📏 ${prev.taille} cm / ⚖️ ${prev.poids} kg\n` +
			`${traitsLine}\n\n` +
			`${statsBlock}\n\n` +
			`💰 Solde de départ : **500 🪙**\n\n` +
			`Utilise \`/link <nom>\` pour associer ton joueur TM2026 !`
		  )],
		});
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

	  console.log('[Discord] Connexion en cours...');
	  client.login(process.env.DISCORD_TOKEN).catch((e) => {
		console.error('[Discord] ❌ Échec du login :', e.message);
		process.exit(1);
	  });
	}

	startBot();
