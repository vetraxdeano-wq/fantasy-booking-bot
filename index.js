require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ComponentType,
  PermissionFlagsBits,
} = require('discord.js');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// ================================================================
// MONGODB — SCHEMAS & MODELS
// ================================================================

const PlayerSchema = new mongoose.Schema({
  discordId:       { type: String, required: true, unique: true },
  discordUsername: String,
  // Identité du rookie
  name:        { type: String, required: true },
  age:         { type: Number, default: 16 },
  role:        { type: String, enum: ['Top', 'Jungle', 'Mid', 'ADC', 'Support'] },
  nationality: String,
  mainChampion:  String,
  championPool:  [String], // [phare, champ2, champ3]
  // Contrat
  teamId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
  teamName:  { type: String, default: null },
  region:    { type: String, default: null },
  salary:    { type: Number, default: 10000 },
  // Progression
  reputation:  { type: Number, default: 50 },
  experience:  { type: Number, default: 0 },
  level:       { type: Number, default: 1 },
  // Stats globales (cumulées sur la saison)
  stats: {
    kills:   { type: Number, default: 0 },
    deaths:  { type: Number, default: 0 },
    assists: { type: Number, default: 0 },
    wins:    { type: Number, default: 0 },
    losses:  { type: Number, default: 0 },
    mvps:    { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 },
  },
  // Flags
  isReady:    { type: Boolean, default: false }, // a choisi son équipe
  createdAt:  { type: Date, default: Date.now },
});

const TeamSchema = new mongoose.Schema({
  name:       { type: String, required: true, unique: true },
  shortName:  String,
  region:     String,
  prestige:   { type: Number, default: 50 },  // 0–100, influence les matchs
  budget:     { type: Number, default: 1000000 },
  // Roster : mix NPC + joueurs Discord
  players:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
  npcRoster:  [mongoose.Schema.Types.Mixed], // joueurs NPC venant du JSON
  // Stats du split en cours
  wins:       { type: Number, default: 0 },
  losses:     { type: Number, default: 0 },
  points:     { type: Number, default: 0 },
  // Flag
  hasDiscordPlayer: { type: Boolean, default: false },
});

const SeasonSchema = new mongoose.Schema({
  number: { type: Number, default: 1 },
  year:   { type: Number, default: new Date().getFullYear() },
  currentPhase: {
    type: String,
    enum: ['REGISTRATION', 'WINTER', 'FIRST_STAND', 'SPRING', 'MSI', 'SUMMER', 'WORLDS', 'OFFSEASON'],
    default: 'REGISTRATION',
  },
  currentWeek: { type: Number, default: 0 },
  isActive:    { type: Boolean, default: true },
  // Archive des résultats par phase
  phaseResults: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt:   { type: Date, default: Date.now },
});

const MatchSchema = new mongoose.Schema({
  seasonId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Season' },
  phase:     String,
  week:      Number,
  region:    String,
  isInternational: { type: Boolean, default: false },
  team1:     { name: String, id: mongoose.Schema.Types.ObjectId },
  team2:     { name: String, id: mongoose.Schema.Types.ObjectId },
  winner:    { name: String, id: mongoose.Schema.Types.ObjectId },
  loser:     { name: String, id: mongoose.Schema.Types.ObjectId },
  score:     String,   // "2-0" / "2-1" / "1-2" / "0-2"
  playerPerformances: [mongoose.Schema.Types.Mixed],
  date:      { type: Date, default: Date.now },
});

const Player  = mongoose.model('Player',  PlayerSchema);
const Team    = mongoose.model('Team',    TeamSchema);
const Season  = mongoose.model('Season',  SeasonSchema);
const Match   = mongoose.model('Match',   MatchSchema);

// ================================================================
// CONSTANTES DU JEU
// ================================================================

const ROLE_EMOJI = {
  Top: '🗡️', Jungle: '🌿', Mid: '⚡', ADC: '🏹', Support: '🛡️',
};

const REGIONS = {
  LEC: { name: 'LEC', full: 'EMEA Championship',       emoji: '🇪🇺', slots: 10, intlSeeds: 3 },
  LCS: { name: 'LCS', full: 'Championship Series NA',  emoji: '🇺🇸', slots: 10, intlSeeds: 2 },
  LCK: { name: 'LCK', full: 'League Champions Korea',  emoji: '🇰🇷', slots: 10, intlSeeds: 3 },
  LPL: { name: 'LPL', full: 'Pro League China',        emoji: '🇨🇳', slots: 18, intlSeeds: 4 },
  LFL: { name: 'LFL', full: 'La Ligue Française',      emoji: '🇫🇷', slots: 8,  intlSeeds: 1 },
};

// Structure des phases : ordre, semaines, description
const PHASES = {
  REGISTRATION: {
    label: '📋 Inscriptions',
    weeks: 0,
    next:  'WINTER',
    description: 'Les rookies créent leurs personnages et choisissent leurs équipes.',
  },
  WINTER: {
    label: '❄️ Winter Split',
    weeks: 5,
    next:  'FIRST_STAND',
    description: 'Phase régulière hivernale dans chaque région. Round-robin.',
  },
  FIRST_STAND: {
    label: '🏆 First Stand',
    weeks: 2,
    next:  'SPRING',
    description: 'Tournoi international précoce entre les meilleures équipes d\'hiver.',
    isInternational: true,
    seedsPerRegion: { LEC: 2, LCS: 2, LCK: 2, LPL: 3, LFL: 1 },
  },
  SPRING: {
    label: '🌸 Spring Split',
    weeks: 5,
    next:  'MSI',
    description: 'Phase régulière printanière. Les points s\'accumulent.',
  },
  MSI: {
    label: '🌍 Mid-Season Invitational',
    weeks: 2,
    next:  'SUMMER',
    description: 'Le grand rendez-vous du milieu de saison — top équipes de chaque région.',
    isInternational: true,
    seedsPerRegion: { LEC: 1, LCS: 1, LCK: 1, LPL: 1, LFL: 1 },
  },
  SUMMER: {
    label: '☀️ Summer Split',
    weeks: 5,
    next:  'WORLDS',
    description: 'Dernier split régional. Les Worlds se profilent.',
  },
  WORLDS: {
    label: '🌏 World Championship',
    weeks: 3,
    next:  'OFFSEASON',
    description: 'Le grand Mondial. Group Stage, Quarts, Demies, Finale.',
    isInternational: true,
    seedsPerRegion: { LEC: 3, LCS: 2, LCK: 3, LPL: 4, LFL: 1 },
  },
  OFFSEASON: {
    label: '💤 Intersaison',
    weeks: 0,
    next:  null,
    description: 'Transferts, négociations, préparation de la prochaine saison.',
  },
};

// XP nécessaire pour chaque niveau
const XP_TABLE = [0, 200, 500, 1000, 2000, 3500, 5500, 8000, 11000, 15000, 20000];

// ================================================================
// MOTEUR DE JEU — SIMULATION
// ================================================================

/**
 * Force d'une équipe en tenant compte du prestige + hasard + joueur réel
 */
function teamStrength(team) {
  const base = team.prestige || 50;
  const playerBonus = team.hasDiscordPlayer ? 5 : 0;
  const noise = (Math.random() * 30) - 15;  // ±15 de variance
  return Math.max(5, base + playerBonus + noise);
}

/**
 * Simule un Bo3 entre deux équipes. Retourne le résultat complet.
 */
function simulateBo3(t1, t2) {
  const str1 = teamStrength(t1);
  const str2 = teamStrength(t2);
  const winProb1 = str1 / (str1 + str2);

  let s1 = 0, s2 = 0;
  const games = [];

  while (s1 < 2 && s2 < 2) {
    const gameDuration = Math.floor(Math.random() * 18 + 22); // 22–40 min
    if (Math.random() < winProb1) {
      s1++;
      games.push({ winner: t1.name, duration: gameDuration });
    } else {
      s2++;
      games.push({ winner: t2.name, duration: gameDuration });
    }
  }

  const winner = s1 > s2 ? t1 : t2;
  const loser  = s1 > s2 ? t2 : t1;

  return {
    winner, loser,
    score: `${s1}-${s2}`,
    winnerScore: s1 > s2 ? s1 : s2,
    loserScore:  s1 > s2 ? s2 : s1,
    games,
  };
}

/**
 * Génère les performances d'un joueur Discord pour un match
 */
function generatePerformance(player, won) {
  const roleBase = {
    Top:     { k: 3,  d: 3, a: 4  },
    Jungle:  { k: 4,  d: 3, a: 8  },
    Mid:     { k: 5,  d: 3, a: 5  },
    ADC:     { k: 5,  d: 3, a: 4  },
    Support: { k: 1,  d: 3, a: 12 },
  };
  const base = roleBase[player.role] || { k: 3, d: 3, a: 5 };
  const v    = () => Math.floor(Math.random() * 5) - 2;
  const wb   = won ? 1 : -1;

  const kills   = Math.max(0, base.k + v() + wb);
  const deaths  = Math.max(0, base.d + v() - wb);
  const assists = Math.max(0, base.a + v() + wb);
  const kda     = deaths === 0
    ? (kills + assists).toFixed(1)
    : ((kills + assists) / deaths).toFixed(2);
  const rating  = Math.min(10, Math.max(1,
    parseFloat(kda) * 1.5 + (won ? 0.5 : -0.5) + (Math.random() - 0.5)
  )).toFixed(1);
  const isMvp   = won && parseFloat(rating) >= 8.5;
  const champion = player.championPool?.[Math.floor(Math.random() * player.championPool.length)]
    || player.mainChampion || '?';

  return { kills, deaths, assists, kda, rating: parseFloat(rating), champion, isMvp };
}

/**
 * Calcul du niveau selon l'XP
 */
function computeLevel(xp) {
  for (let i = XP_TABLE.length - 1; i >= 0; i--) {
    if (xp >= XP_TABLE[i]) return i + 1;
  }
  return 1;
}

/**
 * Simule tous les matchs d'une semaine pour une région donnée
 */
async function simulateRegionWeek(season, regionKey, teams) {
  const results = [];
  // Round-robin : chaque équipe joue une fois par semaine (appairages aléatoires)
  const shuffled = [...teams].sort(() => Math.random() - 0.5);

  for (let i = 0; i + 1 < shuffled.length; i += 2) {
    const t1 = shuffled[i];
    const t2 = shuffled[i + 1];

    const result = simulateBo3(t1, t2);

    // Mise à jour des stats équipes en BDD
    await Team.updateOne({ _id: t1._id }, {
      $inc: {
        wins:   result.winner._id.equals(t1._id) ? 1 : 0,
        losses: result.loser._id.equals(t1._id)  ? 1 : 0,
        points: result.winner._id.equals(t1._id) ? 3 : 0,
      },
    });
    await Team.updateOne({ _id: t2._id }, {
      $inc: {
        wins:   result.winner._id.equals(t2._id) ? 1 : 0,
        losses: result.loser._id.equals(t2._id)  ? 1 : 0,
        points: result.winner._id.equals(t2._id) ? 3 : 0,
      },
    });

    // Mise à jour des joueurs Discord impliqués
    for (const team of [t1, t2]) {
      const discordPlayer = await Player.findOne({ teamId: team._id });
      if (!discordPlayer) continue;

      const won  = result.winner._id.equals(team._id);
      const perf = generatePerformance(discordPlayer, won);
      const xpGain  = won ? 150 : 60;
      const repGain = won ? 2  : -1;
      const newXp   = discordPlayer.experience + xpGain;
      const newLvl  = computeLevel(newXp);

      await Player.updateOne({ _id: discordPlayer._id }, {
        $inc: {
          'stats.kills':       perf.kills,
          'stats.deaths':      perf.deaths,
          'stats.assists':     perf.assists,
          'stats.wins':        won ? 1 : 0,
          'stats.losses':      won ? 0 : 1,
          'stats.mvps':        perf.isMvp ? 1 : 0,
          'stats.gamesPlayed': 1,
          experience:          xpGain,
          reputation:          repGain,
        },
        $set: { level: newLvl },
      });

      results.push({
        region:   regionKey,
        team1:    t1, team2: t2,
        winner:   result.winner, loser: result.loser,
        score:    result.score,
        discordPlayer: { ...discordPlayer.toObject(), perf },
      });
    }

    if (!results.find(r => r.team1._id.equals(t1._id) && r.team2._id.equals(t2._id))) {
      results.push({
        region:  regionKey,
        team1:   t1, team2: t2,
        winner:  result.winner, loser: result.loser,
        score:   result.score,
      });
    }

    // Sauvegarde du match en BDD
    await Match.create({
      seasonId: season._id,
      phase:    season.currentPhase,
      week:     season.currentWeek + 1,
      region:   regionKey,
      team1:    { name: t1.name, id: t1._id },
      team2:    { name: t2.name, id: t2._id },
      winner:   { name: result.winner.name, id: result.winner._id },
      loser:    { name: result.loser.name,  id: result.loser._id  },
      score:    result.score,
    });
  }

  return results;
}

/**
 * Simule un tournoi international (First Stand / MSI / Worlds)
 * Retourne les résultats de la semaine du tournoi
 */
async function simulateInternational(season, phaseKey, week) {
  const phaseInfo = PHASES[phaseKey];
  const seeds = phaseInfo.seedsPerRegion || {};
  const participants = [];

  // Sélection des meilleures équipes de chaque région
  for (const [region, n] of Object.entries(seeds)) {
    const topTeams = await Team.find({ region }).sort({ points: -1 }).limit(n);
    participants.push(...topTeams);
  }

  if (participants.length < 4) {
    return [{ region: 'INTERNATIONAL', error: 'Pas assez d\'équipes qualifiées.' }];
  }

  const results = [];
  const shuffled = participants.sort(() => Math.random() - 0.5);

  for (let i = 0; i + 1 < shuffled.length; i += 2) {
    const t1 = shuffled[i];
    const t2 = shuffled[i + 1];
    const result = simulateBo3(t1, t2);

    // Bonus de réputation pour les joueurs dans les internationaux
    for (const team of [t1, t2]) {
      const dp = await Player.findOne({ teamId: team._id });
      if (!dp) continue;
      const won = result.winner._id.equals(team._id);
      const perf = generatePerformance(dp, won);
      const xpGain  = won ? 300 : 120;
      const repGain = won ? 5   : 1;
      await Player.updateOne({ _id: dp._id }, {
        $inc: {
          'stats.kills': perf.kills, 'stats.deaths': perf.deaths,
          'stats.assists': perf.assists, 'stats.wins': won ? 1 : 0,
          'stats.losses': won ? 0 : 1, 'stats.gamesPlayed': 1,
          experience: xpGain, reputation: repGain,
        },
        $set: { level: computeLevel(dp.experience + xpGain) },
      });
    }

    await Match.create({
      seasonId: season._id, phase: phaseKey, week,
      region: 'INTERNATIONAL', isInternational: true,
      team1: { name: t1.name, id: t1._id }, team2: { name: t2.name, id: t2._id },
      winner: { name: result.winner.name, id: result.winner._id },
      loser:  { name: result.loser.name,  id: result.loser._id  },
      score:  result.score,
    });

    results.push({
      region: 'INTERNATIONAL', isInternational: true,
      team1: t1, team2: t2,
      winner: result.winner, loser: result.loser,
      score: result.score,
    });
  }

  return results;
}

// ================================================================
// BUILDERS D'EMBEDS
// ================================================================

function embedProfil(player) {
  const { kills: k, deaths: d, assists: a, wins, losses, mvps, gamesPlayed: gp } = player.stats;
  const kda  = d === 0 ? `${(k + a).toFixed(1)} (Perfect)` : ((k + a) / d).toFixed(2);
  const wr   = gp === 0 ? '—' : `${Math.round((wins / gp) * 100)}%`;
  const xpNext = XP_TABLE[player.level] || '∞';

  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`${ROLE_EMOJI[player.role] || '🎮'} ${player.name}`)
    .setDescription(`*${player.nationality} · ${player.role} · ${player.age} ans*`)
    .addFields(
      {
        name: '🏟️ Équipe',
        value: player.teamName
          ? `**${player.teamName}** (${player.region})\n💰 Salaire : ${player.salary.toLocaleString('fr-FR')} €/mois`
          : '*— Agent libre —*',
        inline: false,
      },
      { name: '🏆 Champion phare', value: player.mainChampion || '—', inline: true },
      { name: '📚 Pool',           value: player.championPool?.join(' · ') || '—', inline: true },
      { name: '✨ Niveau',          value: `**${player.level}** (${player.experience} / ${xpNext} XP)`, inline: true },
      { name: '⭐ Réputation',      value: `${player.reputation}/100`, inline: true },
      { name: '🎖️ MVPs',           value: `${mvps}`, inline: true },
      { name: '📊 Stats saison',
        value: `\`\`\`${k}/${d}/${a}  ·  KDA ${kda}  ·  WR ${wr}  (${wins}V ${losses}D)\`\`\`` },
    )
    .setFooter({ text: 'LoL Manager · Saison en cours' })
    .setTimestamp();
}

function embedResults(allMatches, phase, week) {
  const phaseLabel = PHASES[phase]?.label || phase;
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle(`📅 Résultats — ${phaseLabel} · Semaine ${week}`)
    .setTimestamp();

  // Grouper par région
  const byRegion = {};
  for (const m of allMatches) {
    const key = m.region || 'INTERNATIONAL';
    if (!byRegion[key]) byRegion[key] = [];
    byRegion[key].push(m);
  }

  for (const [region, matches] of Object.entries(byRegion)) {
    const regionInfo = REGIONS[region];
    const emoji = regionInfo?.emoji || '🌐';
    const label = regionInfo ? `${emoji} ${region}` : `🌐 International`;
    const lines = matches
      .filter(m => m.winner && m.loser)
      .map(m => `${m.winner.name} **${m.score}** ${m.loser.name}`)
      .join('\n');

    if (lines) embed.addFields({ name: label, value: lines });
  }

  // Performances notables des joueurs Discord
  const playerPerfs = allMatches.filter(m => m.discordPlayer);
  if (playerPerfs.length > 0) {
    const perfLines = playerPerfs.map(m => {
      const { name, perf } = m.discordPlayer;
      const mvpTag = perf.isMvp ? ' 🌟 **MVP**' : '';
      return `· **${name}** (${m.discordPlayer.role}) — ${perf.kills}/${perf.deaths}/${perf.assists} sur ${perf.champion}${mvpTag}`;
    }).join('\n');
    embed.addFields({ name: '🎮 Performances des pros', value: perfLines });
  }

  return embed;
}

function embedStandings(teams, region) {
  const regionInfo = REGIONS[region];
  const sorted = [...teams].sort((a, b) => b.points - a.points || b.wins - a.wins);
  const lines  = sorted.map((t, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const disc  = t.hasDiscordPlayer ? ' 🎮' : '';
    return `${medal} **${t.name}**${disc} — ${t.wins}V ${t.losses}D (${t.points} pts)`;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle(`${regionInfo?.emoji || '🌐'} Classement ${region}`)
    .setDescription(lines || '*Aucun match joué*')
    .setFooter({ text: '🎮 = équipe avec un joueur Discord' })
    .setTimestamp();
}

// ================================================================
// SLASH COMMANDS — DÉFINITIONS
// ================================================================

const commands = [
  // ── Joueur ────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('create')
    .setDescription('🌟 Crée ton rookie de 16 ans dans la scène pro')
    .addStringOption(o => o.setName('nom').setDescription('Ton pseudo in-game').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('Ton rôle principal').setRequired(true)
      .addChoices(
        { name: '🗡️ Top',     value: 'Top'     },
        { name: '🌿 Jungle',  value: 'Jungle'  },
        { name: '⚡ Mid',     value: 'Mid'     },
        { name: '🏹 ADC',     value: 'ADC'     },
        { name: '🛡️ Support', value: 'Support' },
      ))
    .addStringOption(o => o.setName('nationalite').setDescription('Ta nationalité (ex: Français, Coréen…)').setRequired(true))
    .addStringOption(o => o.setName('champion_phare').setDescription('Ton champion signature').setRequired(true))
    .addStringOption(o => o.setName('champion2').setDescription('2e champion de ton pool').setRequired(true))
    .addStringOption(o => o.setName('champion3').setDescription('3e champion de ton pool').setRequired(true)),

  new SlashCommandBuilder()
    .setName('teams')
    .setDescription('🏟️ Voir les offres d\'équipes et signer ton contrat'),

  new SlashCommandBuilder()
    .setName('profil')
    .setDescription('📋 Voir ta fiche joueur')
    .addUserOption(o => o.setName('joueur').setDescription('Voir le profil d\'un autre joueur')),

  new SlashCommandBuilder()
    .setName('classement')
    .setDescription('🏆 Classement des équipes d\'une région')
    .addStringOption(o => o.setName('region').setDescription('Région à afficher').setRequired(true)
      .addChoices(
        { name: '🇪🇺 LEC', value: 'LEC' }, { name: '🇺🇸 LCS', value: 'LCS' },
        { name: '🇰🇷 LCK', value: 'LCK' }, { name: '🇨🇳 LPL', value: 'LPL' },
        { name: '🇫🇷 LFL', value: 'LFL' },
      )),

  new SlashCommandBuilder()
    .setName('top-players')
    .setDescription('🌟 Top 10 des rookies Discord du serveur'),

  new SlashCommandBuilder()
    .setName('saison')
    .setDescription('📅 État de la saison en cours'),

  // ── Admin ─────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('start-season')
    .setDescription('[ADMIN] Lancer la saison ou passer à la prochaine phase')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('simulate-week')
    .setDescription('[ADMIN] Simuler la semaine suivante')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('import-data')
    .setDescription('[ADMIN] Importer les JSON champions/teams/players dans MongoDB')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('[ADMIN] ⚠️ Reset complet du jeu (irréversible)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// ================================================================
// HANDLERS — COMMANDES JOUEUR
// ================================================================

async function handleCreate(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const existing = await Player.findOne({ discordId: interaction.user.id });
  if (existing) {
    return interaction.editReply('❌ Tu as déjà un rookie ! Utilise `/profil` pour le voir.');
  }

  const season = await Season.findOne({ isActive: true });
  if (season && season.currentPhase !== 'REGISTRATION') {
    return interaction.editReply('❌ La saison est déjà lancée, les inscriptions sont fermées pour ce cycle.');
  }

  const nom      = interaction.options.getString('nom');
  const role     = interaction.options.getString('role');
  const nat      = interaction.options.getString('nationalite');
  const champ1   = interaction.options.getString('champion_phare');
  const champ2   = interaction.options.getString('champion2');
  const champ3   = interaction.options.getString('champion3');

  await Player.create({
    discordId:      interaction.user.id,
    discordUsername: interaction.user.username,
    name:           nom,
    role, nationality: nat,
    mainChampion:   champ1,
    championPool:   [champ1, champ2, champ3],
  });

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('🌟 Rookie créé !')
    .setDescription(`Bienvenue dans la scène pro, **${nom}** !`)
    .addFields(
      { name: `${ROLE_EMOJI[role]} Rôle`,    value: role,  inline: true },
      { name: '🌍 Nationalité',               value: nat,   inline: true },
      { name: '🏆 Champion phare',            value: champ1, inline: true },
      { name: '📚 Pool complet',              value: [champ1, champ2, champ3].join(' · ') },
      { name: '📋 Prochaine étape',           value: 'Utilise `/teams` pour choisir ton équipe !' },
    )
    .setFooter({ text: 'Âge : 16 ans · Réputation : 50/100' });

  return interaction.editReply({ embeds: [embed] });
}

async function handleTeams(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const player = await Player.findOne({ discordId: interaction.user.id });
  if (!player) {
    return interaction.editReply('❌ Tu n\'as pas encore créé ton rookie ! Utilise `/create`.');
  }
  if (player.teamName) {
    return interaction.editReply(`✅ Tu joues déjà pour **${player.teamName}** (${player.region}) !`);
  }

  const season = await Season.findOne({ isActive: true });
  if (season && season.currentPhase !== 'REGISTRATION') {
    return interaction.editReply('❌ La phase d\'inscription est terminée.');
  }

  // Récupérer 3 équipes sans joueur Discord, de régions variées si possible
  const usedRegions = new Set();
  const allAvail = await Team.find({ hasDiscordPlayer: false }).sort({ prestige: -1 });
  const picks = [];

  for (const t of allAvail) {
    if (picks.length >= 3) break;
    if (!usedRegions.has(t.region) || picks.length < 3) {
      picks.push(t);
      usedRegions.add(t.region);
    }
  }

  if (picks.length === 0) {
    return interaction.editReply('❌ Aucune équipe disponible. Utilise `/import-data` pour charger les équipes.');
  }

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🏟️ 3 équipes t\'ont fait une offre !')
    .setDescription('Tu as **60 secondes** pour choisir. Ce choix est définitif pour la saison.')
    .setFooter({ text: 'Chaque joueur Discord rejoint une équipe différente' });

  for (const t of picks) {
    const regionInfo = REGIONS[t.region];
    embed.addFields({
      name: `${regionInfo?.emoji || '🌐'} ${t.name} (${t.region})`,
      value: `⭐ Prestige : **${t.prestige}/100** · 💰 Budget : **${(t.budget / 1_000_000).toFixed(1)}M€**\n💸 Salaire estimé : ~**${Math.floor(t.prestige * 500 + 10000).toLocaleString('fr-FR')} €/mois**`,
    });
  }

  const row = new ActionRowBuilder().addComponents(
    picks.map((t, i) =>
      new ButtonBuilder()
        .setCustomId(`join_${t._id}`)
        .setLabel(t.name)
        .setStyle([ButtonStyle.Primary, ButtonStyle.Success, ButtonStyle.Secondary][i] || ButtonStyle.Secondary)
    )
  );

  const msg = await interaction.editReply({ embeds: [embed], components: [row] });

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
    filter: i => i.user.id === interaction.user.id,
  });

  collector.on('collect', async (btn) => {
    const teamId = btn.customId.replace('join_', '');
    const team   = await Team.findById(teamId);
    if (!team || team.hasDiscordPlayer) {
      return btn.reply({ content: '❌ Cette équipe n\'est plus disponible.', ephemeral: true });
    }

    const salary = Math.floor(team.prestige * 500 + 10_000);
    await Player.updateOne({ discordId: interaction.user.id }, {
      teamId: team._id, teamName: team.name, region: team.region,
      salary, isReady: true,
    });
    await Team.updateOne({ _id: team._id }, {
      hasDiscordPlayer: true,
      $push: { players: player._id },
    });

    const successEmbed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Contrat signé !')
      .setDescription(`Tu rejoins **${team.name}** (${team.region}) !\n💸 Salaire : **${salary.toLocaleString('fr-FR')} €/mois**`)
      .setFooter({ text: 'Bonne chance pour la saison ! 🍀' });

    await btn.update({ embeds: [successEmbed], components: [] });
    collector.stop();
  });

  collector.on('end', async (col) => {
    if (col.size === 0) {
      const expired = new ActionRowBuilder().addComponents(
        picks.map(t =>
          new ButtonBuilder()
            .setCustomId(`exp_${t._id}`)
            .setLabel(t.name)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        )
      );
      await interaction.editReply({ components: [expired] }).catch(() => {});
    }
  });
}

async function handleProfil(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser('joueur') || interaction.user;
  const player = await Player.findOne({ discordId: target.id });
  if (!player) {
    return interaction.editReply(`❌ **${target.username}** n'a pas encore créé son rookie.`);
  }
  return interaction.editReply({ embeds: [embedProfil(player)] });
}

async function handleClassement(interaction) {
  await interaction.deferReply();
  const region = interaction.options.getString('region');
  const teams  = await Team.find({ region }).sort({ points: -1 });
  if (teams.length === 0) {
    return interaction.editReply(`❌ Aucune équipe en ${region}. Utilise \`/import-data\`.`);
  }
  return interaction.editReply({ embeds: [embedStandings(teams, region)] });
}

async function handleTopPlayers(interaction) {
  await interaction.deferReply();
  const players = await Player.find({ isReady: true })
    .sort({ reputation: -1, 'stats.wins': -1 })
    .limit(10);

  if (players.length === 0) {
    return interaction.editReply('❌ Aucun rookie inscrit pour le moment.');
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = players.map((p, i) => {
    const gp = p.stats.wins + p.stats.losses;
    const wr = gp === 0 ? '—' : `${Math.round((p.stats.wins / gp) * 100)}%`;
    const kda = p.stats.deaths === 0
      ? '∞'
      : ((p.stats.kills + p.stats.assists) / p.stats.deaths).toFixed(2);
    return `${medals[i] || `**${i + 1}.**`} **${p.name}** (${ROLE_EMOJI[p.role]}${p.role} · ${p.teamName || 'Libre'})\n⭐ ${p.reputation} rep · KDA ${kda} · WR ${wr} · Lv.${p.level}`;
  }).join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle('🌟 Top 10 — Rookies LoL Manager')
    .setDescription(lines)
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function handleSaison(interaction) {
  await interaction.deferReply();
  const season = await Season.findOne({ isActive: true });
  if (!season) {
    return interaction.editReply('❌ Aucune saison active. Un admin doit lancer `/start-season`.');
  }

  const total   = await Player.countDocuments();
  const ready   = await Player.countDocuments({ isReady: true });
  const phaseInfo = PHASES[season.currentPhase];

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`📅 Saison ${season.number} — ${season.year}`)
    .addFields(
      { name: '📍 Phase actuelle', value: phaseInfo?.label || season.currentPhase, inline: true },
      { name: '📆 Semaine',        value: `${season.currentWeek}${phaseInfo?.weeks ? ` / ${phaseInfo.weeks}` : ''}`, inline: true },
      { name: '👥 Rookies',        value: `${ready}/${total} ont rejoint une équipe`, inline: true },
      { name: '📖 Description',    value: phaseInfo?.description || '—' },
      { name: '🗺️ Régions',
        value: Object.values(REGIONS).map(r => `${r.emoji} ${r.name}`).join(' · '),
      },
    )
    .setFooter({ text: phaseInfo?.next ? `Prochaine phase : ${PHASES[phaseInfo.next]?.label || phaseInfo.next}` : 'Fin de saison' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// ================================================================
// HANDLERS — COMMANDES ADMIN
// ================================================================

async function handleStartSeason(interaction) {
  await interaction.deferReply({ ephemeral: true });

  let season = await Season.findOne({ isActive: true });

  // Première fois → créer la saison
  if (!season) {
    season = await Season.create({ number: 1, year: new Date().getFullYear() });
    return interaction.editReply(
      '✅ **Saison 1 créée !**\nLes joueurs peuvent maintenant utiliser `/create` puis `/teams`.\nUne fois tout le monde prêt, relance `/start-season` pour passer à l\'hiver !'
    );
  }

  const currentPhase = season.currentPhase;
  const phaseInfo    = PHASES[currentPhase];

  // Vérifier si la phase actuelle est terminée
  if (phaseInfo.weeks > 0 && season.currentWeek < phaseInfo.weeks) {
    return interaction.editReply(
      `⚠️ La phase **${phaseInfo.label}** est à la semaine ${season.currentWeek}/${phaseInfo.weeks}.\nUtilise \`/simulate-week\` pour avancer.`
    );
  }

  const nextPhase = phaseInfo.next;
  if (!nextPhase) {
    return interaction.editReply('❌ La saison est terminée. Utilise `/reset` pour repartir.');
  }

  // Reset des stats d'équipes à chaque nouveau split régional
  if (['WINTER', 'SPRING', 'SUMMER'].includes(nextPhase)) {
    await Team.updateMany({}, { $set: { wins: 0, losses: 0, points: 0 } });
  }

  await Season.updateOne({ _id: season._id }, { currentPhase: nextPhase, currentWeek: 0 });

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🚀 ${PHASES[nextPhase].label} — Ça commence !`)
    .setDescription(PHASES[nextPhase].description)
    .setFooter({ text: 'Utilise /simulate-week pour jouer semaine par semaine' });

  await interaction.editReply({ embeds: [embed] });
  // Annonce publique
  await interaction.channel?.send({ embeds: [embed] }).catch(() => {});
}

async function handleSimulateWeek(interaction) {
  await interaction.deferReply();

  const season = await Season.findOne({ isActive: true });
  if (!season) {
    return interaction.editReply('❌ Aucune saison active. Lance `/start-season`.');
  }

  const { currentPhase, currentWeek } = season;
  const phaseInfo = PHASES[currentPhase];

  if (['REGISTRATION', 'OFFSEASON'].includes(currentPhase)) {
    return interaction.editReply('❌ Impossible de simuler pendant la phase d\'inscription ou l\'intersaison.');
  }

  if (currentWeek >= (phaseInfo.weeks || 0)) {
    return interaction.editReply(
      `✅ La phase **${phaseInfo.label}** est terminée !\nLance \`/start-season\` pour passer à : **${PHASES[phaseInfo.next]?.label || 'Fin de saison'}**`
    );
  }

  const newWeek = currentWeek + 1;
  await Season.updateOne({ _id: season._id }, { currentWeek: newWeek });

  let allMatches = [];

  if (phaseInfo.isInternational) {
    // Tournois internationaux
    allMatches = await simulateInternational(season, currentPhase, newWeek);
  } else {
    // Splits régionaux : simuler chaque région
    for (const regionKey of Object.keys(REGIONS)) {
      const teams = await Team.find({ region: regionKey });
      if (teams.length < 2) continue;
      const regionResults = await simulateRegionWeek(season, regionKey, teams);
      allMatches.push(...regionResults);
    }
  }

  const embed = embedResults(allMatches, currentPhase, newWeek);

  // Vérifier les level-ups
  const players = await Player.find({ isReady: true });
  const levelUps = [];
  for (const p of players) {
    const expectedLevel = computeLevel(p.experience);
    if (expectedLevel > p.level) {
      await Player.updateOne({ _id: p._id }, { level: expectedLevel });
      levelUps.push({ name: p.name, level: expectedLevel });
    }
  }
  if (levelUps.length > 0) {
    embed.addFields({
      name: '🆙 Level-ups cette semaine !',
      value: levelUps.map(l => `**${l.name}** → Niveau ${l.level}`).join('\n'),
    });
  }

  return interaction.editReply({ embeds: [embed] });
}

async function handleImportData(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    return interaction.editReply(
      '❌ Dossier `./data/` introuvable.\n\nCrée-le et place tes fichiers :\n• `data/teams.json`\n• `data/champions.json`\n• `data/players.json` (optionnel)'
    );
  }

  const report = { teams: 0, skipped: 0, errors: [] };

  // ── Import teams.json ──────────────────────────────────────────
  // Structure attendue : tableau d'objets ou { teams: [...] }
  // Champs reconnus : name, shortName, region/league, prestige/strength, budget
  const teamsFile = path.join(dataDir, 'teams.json');
  if (fs.existsSync(teamsFile)) {
    try {
      const raw  = JSON.parse(fs.readFileSync(teamsFile, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw.teams || raw.data?.teams || Object.values(raw));

      for (const t of list) {
        const name = t.name || t.teamName;
        if (!name) continue;
        const exists = await Team.findOne({ name });
        if (!exists) {
          await Team.create({
            name,
            shortName: t.shortName || t.abbr || name.substring(0, 3).toUpperCase(),
            region:    t.region || t.league || 'LEC',
            prestige:  t.prestige ?? t.strength ?? t.rating ?? (t.tier != null ? (5 - t.tier) * 15 + 50 : Math.floor(Math.random() * 30 + 50)),
            budget:    t.budget ?? t.transferBudget ?? t.salaryBudget ?? 1_000_000,
          });
          report.teams++;
        } else {
          report.skipped++;
        }
      }
    } catch (e) {
      report.errors.push(`teams.json : ${e.message}`);
    }
  }

  // ── Résumé ─────────────────────────────────────────────────────
  const lines = [
    `✅ **Import terminé**`,
    `• Équipes importées : **${report.teams}**`,
    `• Équipes ignorées (déjà existantes) : **${report.skipped}**`,
  ];
  if (report.errors.length) {
    lines.push(`\n⚠️ Erreurs :\n${report.errors.map(e => `\`${e}\``).join('\n')}`);
  }
  lines.push('\n💡 Adapte `handleImportData` si ta structure JSON est différente.');

  return interaction.editReply(lines.join('\n'));
}

async function handleReset(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('reset_yes').setLabel('⚠️ Confirmer le reset').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('reset_no').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
  );

  const msg = await interaction.editReply({
    content: '⚠️ **RESET TOTAL** — Suppression de tous les joueurs, saisons et matchs.\nLes équipes seront conservées mais réinitialisées.\n\nConfirmer ?',
    components: [row],
  });

  const col = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 15_000 });
  col.on('collect', async (btn) => {
    if (btn.customId === 'reset_yes') {
      await Player.deleteMany({});
      await Season.deleteMany({});
      await Match.deleteMany({});
      await Team.updateMany({}, {
        $set: { wins: 0, losses: 0, points: 0, hasDiscordPlayer: false, players: [] },
      });
      await btn.update({ content: '✅ Reset effectué. Le jeu est vierge. Lance `/start-season` pour recommencer.', components: [] });
    } else {
      await btn.update({ content: '❌ Reset annulé.', components: [] });
    }
    col.stop();
  });
  col.on('end', async (c) => {
    if (c.size === 0) await interaction.editReply({ content: '⌛ Délai expiré.', components: [] }).catch(() => {});
  });
}

// ================================================================
// DISCORD — ÉVÉNEMENTS
// ================================================================

client.once('ready', () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  console.log(`📡 Présent sur ${client.guilds.cache.size} serveur(s)`);
  client.user.setActivity('LoL Manager 🎮', { type: 0 });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'create':          return await handleCreate(interaction);
      case 'teams':           return await handleTeams(interaction);
      case 'profil':          return await handleProfil(interaction);
      case 'classement':      return await handleClassement(interaction);
      case 'top-players':     return await handleTopPlayers(interaction);
      case 'saison':          return await handleSaison(interaction);
      case 'start-season':    return await handleStartSeason(interaction);
      case 'simulate-week':   return await handleSimulateWeek(interaction);
      case 'import-data':     return await handleImportData(interaction);
      case 'reset':           return await handleReset(interaction);
      default:
        return interaction.reply({ content: '❓ Commande inconnue.', ephemeral: true });
    }
  } catch (err) {
    console.error(`[/${interaction.commandName}]`, err);
    const msg = { content: `❌ Erreur : \`${err.message}\``, ephemeral: true };
    interaction.deferred ? await interaction.editReply(msg) : await interaction.reply(msg).catch(() => {});
  }
});

// ================================================================
// DÉMARRAGE
// ================================================================

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands.map(c => c.toJSON()) }
  );
  console.log('✅ Slash commands enregistrées sur le serveur');
}

async function main() {
  if (!process.env.DISCORD_TOKEN || !process.env.MONGODB_URI || !process.env.CLIENT_ID || !process.env.GUILD_ID) {
    console.error('❌ Variables d\'environnement manquantes. Vérifie ton fichier .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB connecté');

  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
}

main().catch(err => {
  console.error('❌ Erreur fatale au démarrage :', err);
  process.exit(1);
});
