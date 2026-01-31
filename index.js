require('dotenv').config({
  path: require('path').join(__dirname, '.env')
});

const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const mongoose = require('mongoose');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION CLIENT DISCORD
// ============================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ============================================================================
// GESTION DES ERREURS GLOBALES
// ============================================================================

// Gérer les erreurs non capturées du client Discord
client.on('error', error => {
  console.error('❌ Erreur Discord Client:', error);
});

// Gérer les rejets de promesses non gérés
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Promise Rejection:', error);
});

// Gérer les exceptions non capturées
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

// ============================================================================
// CONNEXION MONGODB
// ============================================================================

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connecté à MongoDB'))
  .catch(err => console.error('❌ Erreur MongoDB:', err));

// ============================================================================
// KEEP-ALIVE POUR RENDER
// ============================================================================

function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  
  setInterval(() => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      console.log(`✅ Keep-alive ping: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('❌ Keep-alive error:', err.message);
    });
  }, 5 * 60 * 1000);
}

// ============================================================================
// SCHÉMAS MONGOOSE
// ============================================================================

const wrestlerSchema = new mongoose.Schema({
  name: String,
  isDrafted: { type: Boolean, default: false },
  ownerId: { type: String, default: null },
  ownerFedName: { type: String, default: null },
  guildId: String,
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  isShared: { type: Boolean, default: false },
  sharedWith: [{ 
    userId: String, 
    fedName: String, 
    sharedAt: { type: Date, default: Date.now } 
  }],
matchHistory: [{
  opponent: String,
  result: String,
  federationName: String,
  showNumber: Number,
  pleName: String, // ⭐ NOUVEAU : Nom du PLE
  eventType: String, // ⭐ NOUVEAU : 'show' ou 'ple'
  date: { type: Date, default: Date.now }
}],
  titleHistory: [{
    beltName: String,
    federationName: String,
    wonAt: { type: Date, default: Date.now },
    lostAt: { type: Date, default: null }
  }],
  // ⭐ NOUVEAU : Historique des fédérations
  federationHistory: [{
    federationName: String,
    userId: String,
    action: String, // 'picked', 'released', 'traded_to', 'traded_from', 'shared'
    date: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

const Wrestler = mongoose.model('Wrestler', wrestlerSchema);

const federationSchema = new mongoose.Schema({
  userId: String,
  guildId: String,
  name: String,
  logoUrl: String,
  color: { type: String, default: '#9B59B6' }, // Couleur par défaut
  roster: [{ 
    wrestlerName: String,
    signedDate: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

const Federation = mongoose.model('Federation', federationSchema);

const showSchema = new mongoose.Schema({
  showNumber: Number,
  userId: String,
  guildId: String,
  federationName: String,
  messageId: String,
  ratings: [{ userId: String, stars: Number }],
  averageRating: { type: Number, default: 0 },
  isFinalized: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Show = mongoose.model('Show', showSchema);

const pleSchema = new mongoose.Schema({
  pleName: String,
  userId: String,
  guildId: String,
  federationName: String,
  messageId: String,
  ratings: [{ userId: String, stars: Number }],
  averageRating: { type: Number, default: 0 },
  isFinalized: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const PLE = mongoose.model('PLE', pleSchema);

const beltSchema = new mongoose.Schema({
  userId: String,
  guildId: String,
  federationName: String,
  beltName: String,
  logoUrl: { type: String, default: null },
  currentChampion: { type: String, default: null },
  championshipHistory: [{
    champion: String,
    wonAt: { type: Date, default: Date.now },
    lostAt: { type: Date, default: null },
    defenses: { type: Number, default: 0 }
  }],
  createdAt: { type: Date, default: Date.now }
});

const Belt = mongoose.model('Belt', beltSchema);

// ============================================================================
// CONFIGURATION DES ÉTOILES
// ============================================================================

const STAR_VALUES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
const EMOJI_NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// Palette de couleurs pour les fédérations
const FEDERATION_COLORS = [
  '#E74C3C', // Rouge
  '#3498DB', // Bleu
  '#2ECC71', // Vert
  '#F39C12', // Orange
  '#9B59B6', // Violet
  '#1ABC9C', // Turquoise
  '#E67E22', // Orange foncé
  '#34495E', // Gris bleu
  '#16A085', // Vert océan
  '#D35400', // Citrouille
  '#8E44AD', // Violet foncé
  '#27AE60', // Vert émeraude
  '#2980B9', // Bleu foncé
  '#C0392B', // Rouge foncé
  '#F1C40F', // Jaune
];

function getRandomColor() {
  return FEDERATION_COLORS[Math.floor(Math.random() * FEDERATION_COLORS.length)];
}

// ============================================================================
// FONCTIONS UTILITAIRES
// ============================================================================

function getStarDisplay(rating) {
  const fullStars = Math.floor(rating);
  const hasHalfStar = (rating % 1) >= 0.5;
  return '⭐'.repeat(fullStars) + (hasHalfStar ? '✨' : '');
}


// ============================================================================
// SYSTÈME TV RATINGS PERMANENT
// À ajouter APRÈS les schémas mongoose et AVANT la section client.on('messageCreate')
// ============================================================================

/**
 * Fonction pour calculer le TV Rating d'une fédération
 * @param {string} userId - ID de l'utilisateur propriétaire
 * @param {string} guildId - ID du serveur Discord
 * @returns {Promise<number>} - Rating entre 0 et 10
 */
async function calculateTVRating(userId, guildId) {
  const federation = await Federation.findOne({ userId, guildId });
  if (!federation) return 0;
  console.log(`\n=== CALCUL TV RATING: ${federation.name} ===`);

// ========================================================================
// 1️⃣ QUALITÉ DES SHOWS ET PLEs (40%) - Max 4.0 points
// ========================================================================
const shows = await Show.find({
  userId,
  guildId,
  isFinalized: true
}).sort({ createdAt: -1 });

const ples = await PLE.find({
  userId,
  guildId,
  isFinalized: true
}).sort({ createdAt: -1 });

let showQualityScore = 0;

// Combiner shows et PLEs pour le calcul
const allEvents = [
  ...shows.map(s => ({ rating: s.averageRating, createdAt: s.createdAt, type: 'show' })),
  ...ples.map(p => ({ rating: p.averageRating, createdAt: p.createdAt, type: 'ple' }))
];

if (allEvents.length > 0) {
  // Qualité moyenne pure (PLEs comptent double)
  const totalWeightedRating = allEvents.reduce((sum, e) => {
    const weight = e.type === 'ple' ? 2 : 1;
    return sum + (e.rating * weight);
  }, 0);
  
  const totalWeight = allEvents.reduce((sum, e) => sum + (e.type === 'ple' ? 2 : 1), 0);
  const avgRating = totalWeightedRating / totalWeight;
  
  showQualityScore = (avgRating / 5) * 3.5; // Max 3.5 pour la qualité

  // Bonus régularité : au moins 4 events dans les 30 derniers jours
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentEvents = allEvents.filter(e => new Date(e.createdAt) >= thirtyDaysAgo);
  if (recentEvents.length >= 4) {
    showQualityScore += 0.3; // Bonus régularité
  }

  // Pénalité inactivité : pas d'event depuis 14 jours
  const sortedEvents = allEvents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const lastEvent = sortedEvents[0];
  const daysSinceLastEvent = Math.floor((Date.now() - new Date(lastEvent.createdAt)) / (1000 * 60 * 60 * 24));
  if (daysSinceLastEvent > 14) {
    const weeksPenalty = Math.floor(daysSinceLastEvent / 7) - 2;
    showQualityScore -= (weeksPenalty * 0.5);
  }
}

showQualityScore = Math.max(0, Math.min(4.0, showQualityScore));
console.log(`✅ Shows & PLEs Quality: ${showQualityScore.toFixed(2)}/4.0`);

  // ========================================================================
  // 2️⃣ ROSTER QUALITY (30%) - Max 3.0 points
  // ========================================================================
  let rosterQualityScore = 0;
  
  if (federation.roster.length > 0) {
    // Récupérer tous les lutteurs du roster
    const rosterWrestlers = await Promise.all(
      federation.roster.map(async (r) => {
        return await Wrestler.findOne({
          name: new RegExp(`^${r.wrestlerName}$`, 'i'),
          guildId
        });
      })
    );

    const validWrestlers = rosterWrestlers.filter(w => w && (w.wins + w.losses) > 0);
    
    if (validWrestlers.length > 0) {
      // Win Rate global du roster
      const totalWins = validWrestlers.reduce((sum, w) => sum + w.wins, 0);
      const totalMatches = validWrestlers.reduce((sum, w) => sum + w.wins + w.losses, 0);
      const rosterWinRate = totalMatches > 0 ? (totalWins / totalMatches) : 0;
      
      rosterQualityScore = rosterWinRate * 1.8; // Max 1.8 pour le win rate

      // Star Power : compter combien de mes lutteurs sont dans le Top 5 global
      const allWrestlers = await Wrestler.find({
        guildId,
        $or: [{ wins: { $gt: 0 } }, { losses: { $gt: 0 } }]
      });

      const wrestlerScores = allWrestlers.map(w => {
        const total = w.wins + w.losses;
        if (total === 0) return null;
        const winRate = (w.wins / total) * 100;
        const score = (winRate * 0.7) + (Math.min(total, 20) * 1.5);
        return { name: w.name, score };
      }).filter(Boolean);

      const topFive = wrestlerScores.sort((a, b) => b.score - a.score).slice(0, 5);
      const myTopFiveCount = topFive.filter(t => 
        validWrestlers.some(w => w.name.toLowerCase() === t.name.toLowerCase())
      ).length;

      rosterQualityScore += (myTopFiveCount * 0.24); // +0.24 par top 5 (max 1.2)

      // Pénalité roster déséquilibré
      if (federation.roster.length < 8) {
        rosterQualityScore *= 0.7; // -30% si trop petit
      } else if (federation.roster.length > 50) {
        rosterQualityScore *= 0.8; // -20% si trop gros
      }
    }
  }

  rosterQualityScore = Math.max(0, Math.min(3.0, rosterQualityScore));
  console.log(`✅ Roster Quality: ${rosterQualityScore.toFixed(2)}/3.0`);

  // ========================================================================
  // 3️⃣ CHAMPIONSHIP PRESTIGE (15%) - Max 1.5 points
  // ========================================================================
  let championshipScore = 0;
  
  const belts = await Belt.find({ userId, guildId });
  
  if (belts.length > 0) {
    let totalReignScore = 0;
    let validReigns = 0;

    for (const belt of belts) {
      if (belt.currentChampion && belt.championshipHistory && belt.championshipHistory.length > 0) {
        const currentReign = belt.championshipHistory[belt.championshipHistory.length - 1];
        
        if (!currentReign.lostAt) {
          validReigns++;
          
          // Longueur du règne
          const reignDays = Math.floor((Date.now() - new Date(currentReign.wonAt)) / (1000 * 60 * 60 * 24));
          
          let reignScore = 0;
          if (reignDays < 30) {
            reignScore = 0.3; // Règne court = mauvais booking
          } else if (reignDays < 90) {
            reignScore = 0.6; // Règne moyen
          } else {
            reignScore = 1.0; // Règne long = bon booking
          }

          // Bonus défenses
          const defenses = currentReign.defenses || 0;
          reignScore += Math.min(defenses * 0.1, 0.5); // Max +0.5

          // Bonus si champion dominant (70%+ winrate)
          const championName = belt.currentChampion.split(' & ')[0]; // Pour les tag teams
          const champion = await Wrestler.findOne({
            name: new RegExp(`^${championName}$`, 'i'),
            guildId
          });

          if (champion) {
            const totalMatches = champion.wins + champion.losses;
            if (totalMatches > 0) {
              const champWinRate = (champion.wins / totalMatches) * 100;
              if (champWinRate >= 70) {
                reignScore += 0.3; // Champion dominant
              }
            }
          }

          totalReignScore += reignScore;
        }
      }
    }

    if (validReigns > 0) {
      championshipScore = Math.min(totalReignScore / validReigns, 1.5);
    }

    // Pénalité titres vacants depuis > 14 jours
    const vacantBelts = belts.filter(b => !b.currentChampion);
    vacantBelts.forEach(b => {
      if (b.championshipHistory && b.championshipHistory.length > 0) {
        const lastReign = b.championshipHistory[b.championshipHistory.length - 1];
        if (lastReign.lostAt) {
          const vacantDays = Math.floor((Date.now() - new Date(lastReign.lostAt)) / (1000 * 60 * 60 * 24));
          if (vacantDays > 14) {
            championshipScore -= 0.3;
          }
        }
      }
    });
  }

  championshipScore = Math.max(0, Math.min(1.5, championshipScore));
  console.log(`✅ Championship: ${championshipScore.toFixed(2)}/1.5`);

  // ========================================================================
  // 4️⃣ MOMENTUM/TENDANCE (10%) - Max 1.0 points
  // ========================================================================
  let momentumScore = 0;
  
  if (shows.length >= 6) {
    const last3Shows = shows.slice(0, 3);
    const previous3Shows = shows.slice(3, 6);
    
    const last3Avg = last3Shows.reduce((sum, s) => sum + s.averageRating, 0) / 3;
    const prev3Avg = previous3Shows.reduce((sum, s) => sum + s.averageRating, 0) / 3;
    
    const improvement = last3Avg - prev3Avg;
    momentumScore = Math.max(-0.5, Math.min(0.5, improvement)); // -0.5 à +0.5
  }

  // Bonus activité récente (show dans les 7 derniers jours)
  if (shows.length > 0) {
    const lastShow = shows[0];
    const daysSinceLastShow = Math.floor((Date.now() - new Date(lastShow.createdAt)) / (1000 * 60 * 60 * 24));
    if (daysSinceLastShow <= 7) {
      momentumScore += 0.2;
    }
  }

  momentumScore = Math.max(0, Math.min(1.0, momentumScore));
  console.log(`✅ Momentum: ${momentumScore.toFixed(2)}/1.0`);

  // ========================================================================
  // 5️⃣ ENGAGEMENT (5%) - Max 0.5 points
  // ========================================================================
  let engagementScore = 0;
  
  if (shows.length > 0) {
    const totalVotes = shows.reduce((sum, s) => sum + (s.ratings ? s.ratings.length : 0), 0);
    const avgVotes = totalVotes / shows.length;
    
    // Seuil optimal : 5 votes par show
    engagementScore = Math.min(avgVotes / 5, 1.0) * 0.5;
  }

  engagementScore = Math.max(0, Math.min(0.5, engagementScore));
  console.log(`✅ Engagement: ${engagementScore.toFixed(2)}/0.5`);

  // ========================================================================
  // CALCUL TOTAL
  // ========================================================================
  const totalRating = showQualityScore + rosterQualityScore + championshipScore + momentumScore + engagementScore;
  console.log(`🎯 TOTAL: ${totalRating.toFixed(2)}/10.0 | Grade: ${getTVRatingGrade(totalRating)}`);
  console.log(`===================\n`);
  
  return Math.max(0, Math.min(10.0, totalRating));
}

/**
 * Fonction pour obtenir le grade textuel du TV Rating
 * @param {number} rating - Rating entre 0 et 10
 * @returns {string} - Grade textuel avec emoji
 */
function getTVRatingGrade(rating) {
  if (rating >= 9.0) return '🔥 Ratings en Feu';
  if (rating >= 7.5) return '⭐ Prime Time';
  if (rating >= 6.0) return '📺 Solide';
  if (rating >= 4.5) return '📉 En Difficulté';
  return '💀 En Crise';
}

// ============================================================================
// ÉVÉNEMENT: BOT PRÊT
// ============================================================================

client.on('ready', async () => {
  console.log('\n========================================');
  console.log('🤼 Bot Fantasy Booking connecté !');
  console.log('========================================');
  console.log(`👤 Nom: ${client.user.tag}`);
  console.log(`🆔 ID: ${client.user.id}`);
  console.log(`🏟️  Serveurs: ${client.guilds.cache.size}`);
  console.log(`👥 Utilisateurs: ${client.users.cache.size}`);
  console.log('========================================\n');
});

// ============================================================================
// ÉVÉNEMENT: MESSAGES
// ============================================================================

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ==========================================================================
  // COMMANDE: CRÉER UNE FÉDÉRATION
  // ==========================================================================
  
  if (command === 'createfed') {
    const name = args.join(' ');
    
    if (!name) {
      return message.reply('Usage: `!createfed Nom de ta Fédération`');
    }

    const existing = await Federation.findOne({ 
      userId: message.author.id, 
      guildId: message.guild.id 
    });

    if (existing) {
      return message.reply('Tu as déjà une fédération ! Utilise `!resetfed` pour la supprimer.');
    }

const federation = new Federation({
      userId: message.author.id,
      guildId: message.guild.id,
      name,
      logoUrl: null,
      color: getRandomColor()
    });

    await federation.save();

    const embed = new EmbedBuilder()
      .setTitle('🏆 Fédération Créée !')
      .setDescription(`**${name}**`)
      .addFields(
        { name: 'Roster', value: '0 lutteurs' },
        { name: 'Statut', value: '✅ Prêt à drafter' }
      )
      .setColor('#FFD700')
      .setFooter({ text: 'Utilisez !setlogo pour ajouter un logo' });

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: DÉFINIR LE LOGO (ADMIN)
  // ==========================================================================
  
if (command === 'setlogo') {
  const fedName = args.join(' ');
  
  if (!fedName) {
    return message.reply('Usage: `!setlogo Nom de la Fédération` (puis attache une image)');
  }

  if (!message.attachments.first()) {
    return message.reply('❌ Tu dois attacher une image (PNG ou JPG) à ton message !');
  }

  const federation = await Federation.findOne({
    guildId: message.guild.id,
    name: new RegExp(`^${fedName}$`, 'i')
  });

  if (!federation) {
    return message.reply('Fédération introuvable.');
  }

  // Vérifier si c'est le propriétaire OU un admin
  if (federation.userId !== message.author.id && !message.member.permissions.has('Administrator')) {
    return message.reply('❌ Seul le propriétaire de la fédération ou un administrateur peut modifier le logo.');
  }

    const attachment = message.attachments.first();
    const ext = path.extname(attachment.name);
    
    if (!['.png', '.jpg', '.jpeg'].includes(ext.toLowerCase())) {
      return message.reply('❌ Format non supporté. Utilise PNG ou JPG uniquement.');
    }

    // Créer le dossier logos s'il n'existe pas
    const logosDir = path.join(__dirname, 'logos');
    if (!fs.existsSync(logosDir)) {
      fs.mkdirSync(logosDir, { recursive: true });
    }

    const logoPath = path.join(logosDir, `${federation.userId}${ext}`);

    // Télécharger l'image
    const response = await fetch(attachment.url);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(logoPath, Buffer.from(buffer));

    federation.logoUrl = logoPath;
    await federation.save();

    const embed = new EmbedBuilder()
      .setTitle('✅ Logo Défini !')
      .setDescription(`Logo de **${federation.name}** mis à jour`)
      .setThumbnail(attachment.url)
      .setColor('#2ECC71');

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: DÉFINIR LE LOGO D'UN TITRE
  // ==========================================================================
  
  if (command === 'setbeltlogo') {
    const beltName = args.join(' ');
    
    if (!beltName) {
      return message.reply('Usage: `!setbeltlogo Nom du Titre` (puis attache une image)');
    }

    if (!message.attachments.first()) {
      return message.reply('❌ Tu dois attacher une image (PNG ou JPG) à ton message !');
    }

    const belt = await Belt.findOne({
      userId: message.author.id,
      guildId: message.guild.id,
      beltName: new RegExp(`^${beltName}$`, 'i')
    });

    if (!belt) {
      return message.reply(`❌ Tu n'as pas de titre nommé "${beltName}".`);
    }

    const attachment = message.attachments.first();
    const ext = path.extname(attachment.name);
    
    if (!['.png', '.jpg', '.jpeg'].includes(ext.toLowerCase())) {
      return message.reply('❌ Format non supporté. Utilise PNG ou JPG uniquement.');
    }

    // Créer le dossier belt_logos s'il n'existe pas
    const logosDir = path.join(__dirname, 'belt_logos');
    if (!fs.existsSync(logosDir)) {
      fs.mkdirSync(logosDir, { recursive: true });
    }

    const logoPath = path.join(logosDir, `${belt._id}${ext}`);

    // Télécharger l'image
    const response = await fetch(attachment.url);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(logoPath, Buffer.from(buffer));

    belt.logoUrl = logoPath;
    console.log(`[DEBUG setbeltlogo] Saved logo at: ${logoPath}`);
    console.log(`[DEBUG setbeltlogo] File exists after save: ${fs.existsSync(logoPath)}`);
    await belt.save();

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    const embed = new EmbedBuilder()
      .setTitle('✅ Logo de Titre Défini !')
      .setDescription(`Logo du **${belt.beltName}** mis à jour`)
      .setThumbnail(attachment.url)
      .setColor(federation.color);

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: MODIFIER LE NOM DE SA FÉDÉRATION
  // ==========================================================================
  
  if (command === 'editfed') {
    const newName = args.join(' ');
    
    if (!newName) {
      return message.reply('Usage: `!editfed Nouveau Nom de ta Fédération`');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('❌ Tu n\'as pas de fédération. Utilise `!createfed` d\'abord.');
    }

    const oldName = federation.name;
    federation.name = newName;
    await federation.save();

    // Mettre à jour les shows et belts avec le nouveau nom
    await Show.updateMany(
      { userId: message.author.id, guildId: message.guild.id },
      { federationName: newName }
    );

    await Belt.updateMany(
      { userId: message.author.id, guildId: message.guild.id },
      { federationName: newName }
    );

    const embed = new EmbedBuilder()
      .setTitle('✏️ Fédération Renommée !')
      .addFields(
        { name: 'Ancien Nom', value: oldName },
        { name: 'Nouveau Nom', value: newName }
      )
      .setColor(federation.color)
      .setFooter({ text: 'Tous vos shows et titres ont été mis à jour' });

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: CHANGER LA COULEUR DE SA FÉDÉRATION
  // ==========================================================================
  
  if (command === 'setcolor') {
    const colorInput = args[0];
    
    if (!colorInput) {
      const colorsDisplay = FEDERATION_COLORS.map((c, i) => `\`${i + 1}\` ${c}`).join(' • ');
      return message.reply(
        `Usage: \`!setcolor <numéro ou code hexa>\`\n\n` +
        `**Couleurs disponibles:**\n${colorsDisplay}\n\n` +
        `Exemples: \`!setcolor 1\` ou \`!setcolor #FF5733\``
      );
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('❌ Tu n\'as pas de fédération.');
    }

    let newColor;

    // Si c'est un numéro (1-15)
    if (!isNaN(colorInput)) {
      const index = parseInt(colorInput) - 1;
      if (index < 0 || index >= FEDERATION_COLORS.length) {
        return message.reply(`❌ Numéro invalide. Choisis entre 1 et ${FEDERATION_COLORS.length}.`);
      }
      newColor = FEDERATION_COLORS[index];
    } 
    // Si c'est un code hexa
    else if (/^#[0-9A-F]{6}$/i.test(colorInput)) {
      newColor = colorInput.toUpperCase();
    } 
    else {
      return message.reply('❌ Format invalide. Utilise un numéro (1-15) ou un code hexa (#FF5733).');
    }

    federation.color = newColor;
    await federation.save();

    const embed = new EmbedBuilder()
      .setTitle('🎨 Couleur Modifiée !')
      .setDescription(`**${federation.name}**`)
      .addFields({ name: 'Nouvelle Couleur', value: newColor })
      .setColor(newColor)
      .setFooter({ text: 'Cette couleur sera utilisée dans tous tes embeds' });

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: RESET FÉDÉRATION (ADMIN)
  // ==========================================================================
  
  if (command === 'resetfed') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('❌ Commande réservée aux administrateurs.');
    }

    const targetUser = message.mentions.users.first() || message.author;

    const federation = await Federation.findOne({
      userId: targetUser.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply(`${targetUser.username} n'a pas de fédération.`);
    }

    await Wrestler.updateMany(
      { ownerId: targetUser.id, guildId: message.guild.id },
      { isDrafted: false, ownerId: null, ownerFedName: null }
    );

    await Belt.deleteMany({
      userId: targetUser.id,
      guildId: message.guild.id
    });

    await Show.deleteMany({
      userId: targetUser.id,
      guildId: message.guild.id
    });

    await Federation.deleteOne({ _id: federation._id });

    return message.reply(`✅ Fédération de ${targetUser.username} supprimée et lutteurs libérés.`);
  }

  // ==========================================================================
  // COMMANDE: RESET POWER RANKING (ADMIN)
  // ==========================================================================
  
  if (command === 'resetpr') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('❌ Commande réservée aux administrateurs.');
    }

    await Show.deleteMany({ guildId: message.guild.id });
    
    return message.reply('✅ Tous les shows ont été supprimés. Power Rankings réinitialisés.');
  }

  // ==========================================================================
  // COMMANDE: DRAFTER UN LUTTEUR
  // ==========================================================================
  
  if (command === 'pick') {
    const wrestlerName = args.join(' ');

    if (!wrestlerName) {
      return message.reply('Usage: `!pick Nom du Lutteur`');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('Tu dois d\'abord créer ta fédération avec `!createfed`');
    }

    let wrestler = await Wrestler.findOne({ 
      name: new RegExp(`^${wrestlerName}$`, 'i'),
      guildId: message.guild.id
    });

if (wrestler && wrestler.isDrafted && wrestler.ownerId !== message.author.id && !wrestler.isShared) {
  return message.reply(
    `❌ **${wrestler.name}** est déjà signé en exclusivité avec **${wrestler.ownerFedName}** !`
  );
}

if (!wrestler) {
  wrestler = new Wrestler({
    name: wrestlerName,
    guildId: message.guild.id
  });
  await wrestler.save();
}

    if (!wrestler.federationHistory) {
  wrestler.federationHistory = [];
}

wrestler.federationHistory.push({
  federationName: federation.name,
  userId: message.author.id,
  action: wrestler.isShared ? 'shared' : 'picked',
  date: new Date()
});

const alreadyInRoster = federation.roster.find(w => 
  w.wrestlerName.toLowerCase() === wrestler.name.toLowerCase()
);

if (alreadyInRoster) {
  return message.reply(`${wrestler.name} est déjà dans ton roster !`);
}

federation.roster.push({
  wrestlerName: wrestler.name
});

await federation.save();

// Si le lutteur est partagé, l'ajouter à sharedWith
if (wrestler.isShared && wrestler.ownerId !== message.author.id) {
  if (!wrestler.sharedWith) {
    wrestler.sharedWith = [];
  }
  
  const alreadyShared = wrestler.sharedWith.find(s => s.userId === message.author.id);
  if (!alreadyShared) {
    wrestler.sharedWith.push({
      userId: message.author.id,
      fedName: federation.name,
      sharedAt: new Date()
    });
  }
} else {
  // Lutteur non partagé, propriété exclusive
  wrestler.isDrafted = true;
  wrestler.ownerId = message.author.id;
  wrestler.ownerFedName = federation.name;
}

await wrestler.save();

const statusText = wrestler.isShared ? '🔀 Partagé' : '🔒 Exclusif';

const embed = new EmbedBuilder()
  .setTitle('✅ Lutteur Drafté !')
  .setDescription(`**${wrestler.name}** a rejoint **${federation.name}** !`)
  .addFields(
    { name: 'Lutteur', value: wrestler.name, inline: true },
    { name: 'Statut', value: statusText, inline: true },
    { name: 'Roster Total', value: `${federation.roster.length} lutteurs` }
  )
  .setColor(federation.color);

return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: SUPPRIMER UN LUTTEUR DU ROSTER
  // ==========================================================================
  
  if (command === 'delpick') {
    const wrestlerName = args.join(' ');
    
    if (!wrestlerName) {
      return message.reply('Usage: `!delpick Nom du Lutteur`');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('❌ Tu n\'as pas de fédération.');
    }

    const wrestlerIndex = federation.roster.findIndex(
      w => w.wrestlerName.toLowerCase() === wrestlerName.toLowerCase()
    );

    if (wrestlerIndex === -1) {
      return message.reply(`❌ ${wrestlerName} n'est pas dans ton roster.`);
    }

    // Retirer du roster
    federation.roster.splice(wrestlerIndex, 1);
    const wrestler = await Wrestler.findOne({
  name: new RegExp(`^${wrestlerName}$`, 'i'),
  guildId: message.guild.id
});

if (wrestler) {
  if (!wrestler.federationHistory) {
    wrestler.federationHistory = [];
  }
  
  wrestler.federationHistory.push({
    federationName: federation.name,
    userId: message.author.id,
    action: 'released',
    date: new Date()
  });
  
  await wrestler.save();
}
    await federation.save();

    // Libérer le lutteur dans la base
    await Wrestler.updateOne(
      { 
        name: new RegExp(`^${wrestlerName}$`, 'i'),
        guildId: message.guild.id
      },
      { 
        isDrafted: false,
        ownerId: null,
        ownerFedName: null
      }
    );

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Lutteur Libéré')
      .setDescription(`**${wrestlerName}** a été retiré du roster de ${federation.name}`)
      .addFields({ name: 'Nouveau Roster', value: `${federation.roster.length} lutteurs` })
      .setColor(federation.color)
      .setFooter({ text: 'Ce lutteur peut maintenant être drafté par d\'autres' });

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: ÉCHANGER UN LUTTEUR
  // ==========================================================================
  
  if (command === 'trade') {
    // Format: !trade @user [ton lutteur] pour [son lutteur]
    const targetUser = message.mentions.users.first();
    
    if (!targetUser) {
      return message.reply('Usage: `!trade @user [ton lutteur] pour [son lutteur]`\nExemple: !trade @John Roman Reigns pour Seth Rollins');
    }

    if (targetUser.id === message.author.id) {
      return message.reply('❌ Tu ne peux pas faire un trade avec toi-même !');
    }

    // Retirer la mention et parser les lutteurs
    const tradeText = args.slice(1).join(' ');
    const parts = tradeText.split(/\s+pour\s+/i);

    if (parts.length !== 2) {
      return message.reply('❌ Format invalide. Utilise: `!trade @user [ton lutteur] pour [son lutteur]`');
    }

    const yourWrestlerName = parts[0].trim();
    const theirWrestlerName = parts[1].trim();

    if (!yourWrestlerName || !theirWrestlerName) {
      return message.reply('❌ Les noms des lutteurs sont requis.');
    }

    // Vérifier les fédérations
    const yourFed = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    const theirFed = await Federation.findOne({
      userId: targetUser.id,
      guildId: message.guild.id
    });

    if (!yourFed) {
      return message.reply('❌ Tu n\'as pas de fédération.');
    }

    if (!theirFed) {
      return message.reply(`❌ ${targetUser.username} n'a pas de fédération.`);
    }

    // Vérifier que tu possèdes ton lutteur
    const yourWrestlerInRoster = yourFed.roster.find(w => 
      w.wrestlerName.toLowerCase() === yourWrestlerName.toLowerCase()
    );

    if (!yourWrestlerInRoster) {
      return message.reply(`❌ ${yourWrestlerName} n'est pas dans ton roster.`);
    }

    // Vérifier que l'autre possède son lutteur
    const theirWrestlerInRoster = theirFed.roster.find(w => 
      w.wrestlerName.toLowerCase() === theirWrestlerName.toLowerCase()
    );

    if (!theirWrestlerInRoster) {
      return message.reply(`❌ ${theirWrestlerName} n'est pas dans le roster de ${targetUser.username}.`);
    }

    // Créer le message de confirmation
    const confirmEmbed = new EmbedBuilder()
      .setTitle('🔄 Proposition de Trade')
      .setDescription('Réagis avec ✅ pour accepter ou ❌ pour refuser')
      .addFields(
        { name: `${message.author.username} donne`, value: `🤼 **${yourWrestlerInRoster.wrestlerName}**`, inline: true },
        { name: '↔️', value: '\u200B', inline: true },
        { name: `${targetUser.username} donne`, value: `🤼 **${theirWrestlerInRoster.wrestlerName}**`, inline: true }
      )
      .setColor('#3498DB')
      .setFooter({ text: `${targetUser.username}, tu as 60 secondes pour répondre` });

    const confirmMsg = await message.reply({ 
      content: `${targetUser}`,
      embeds: [confirmEmbed] 
    });

    await confirmMsg.react('✅');
    await confirmMsg.react('❌');

    const filter = (reaction, user) => {
      return ['✅', '❌'].includes(reaction.emoji.name) && user.id === targetUser.id;
    };

    const collector = confirmMsg.createReactionCollector({ 
      filter, 
      time: 60000, 
      max: 1 
    });

    collector.on('collect', async (reaction) => {
      if (reaction.emoji.name === '❌') {
        const cancelEmbed = new EmbedBuilder()
          .setTitle('❌ Trade Refusé')
          .setDescription(`${targetUser.username} a refusé le trade.`)
          .setColor('#E74C3C');
        
        return confirmMsg.edit({ embeds: [cancelEmbed], content: null });
      }

      // Accepté : effectuer le trade
      // Retirer les lutteurs des rosters
      yourFed.roster = yourFed.roster.filter(w => 
        w.wrestlerName.toLowerCase() !== yourWrestlerName.toLowerCase()
      );
      theirFed.roster = theirFed.roster.filter(w => 
        w.wrestlerName.toLowerCase() !== theirWrestlerName.toLowerCase()
      );

      // Ajouter les lutteurs aux nouveaux rosters
      yourFed.roster.push({
        wrestlerName: theirWrestlerInRoster.wrestlerName,
        signedDate: new Date()
      });

      theirFed.roster.push({
        wrestlerName: yourWrestlerInRoster.wrestlerName,
        signedDate: new Date()
      });

      await yourFed.save();
      await theirFed.save();

      // Mettre à jour la base Wrestler
      await Wrestler.updateOne(
        { 
          name: new RegExp(`^${yourWrestlerName}$`, 'i'),
          guildId: message.guild.id
        },
        { 
          ownerId: targetUser.id,
          ownerFedName: theirFed.name
        }
      );

      await Wrestler.updateOne(
        { 
          name: new RegExp(`^${theirWrestlerName}$`, 'i'),
          guildId: message.guild.id
        },
        { 
          ownerId: message.author.id,
          ownerFedName: yourFed.name
        }
      );

      // Ajouter à l'historique des deux lutteurs
const wrestler1 = await Wrestler.findOne({
  name: new RegExp(`^${yourWrestlerName}$`, 'i'),
  guildId: message.guild.id
});

const wrestler2 = await Wrestler.findOne({
  name: new RegExp(`^${theirWrestlerName}$`, 'i'),
  guildId: message.guild.id
});

if (wrestler1) {
  if (!wrestler1.federationHistory) wrestler1.federationHistory = [];
  wrestler1.federationHistory.push({
    federationName: theirFed.name,
    userId: targetUser.id,
    action: 'traded_to',
    date: new Date()
  });
  await wrestler1.save();
}

if (wrestler2) {
  if (!wrestler2.federationHistory) wrestler2.federationHistory = [];
  wrestler2.federationHistory.push({
    federationName: yourFed.name,
    userId: message.author.id,
    action: 'traded_to',
    date: new Date()
  });
  await wrestler2.save();
}

      const successEmbed = new EmbedBuilder()
        .setTitle('✅ Trade Effectué !')
        .addFields(
          { name: yourFed.name, value: `➖ ${yourWrestlerInRoster.wrestlerName}\n➕ ${theirWrestlerInRoster.wrestlerName}` },
          { name: theirFed.name, value: `➖ ${theirWrestlerInRoster.wrestlerName}\n➕ ${yourWrestlerInRoster.wrestlerName}` }
        )
        .setColor('#2ECC71')
        .setFooter({ text: 'Les deux rosters ont été mis à jour' });

      return confirmMsg.edit({ embeds: [successEmbed], content: null });
    });

    collector.on('end', collected => {
      if (collected.size === 0) {
        const timeoutEmbed = new EmbedBuilder()
          .setTitle('⏱️ Trade Expiré')
          .setDescription(`${targetUser.username} n'a pas répondu à temps.`)
          .setColor('#95A5A6');
        
        confirmMsg.edit({ embeds: [timeoutEmbed], content: null }).catch(() => {});
      }
    });
  }

  // ==========================================================================
  // COMMANDE: AJOUTER UNE VICTOIRE
  // ==========================================================================
  
if (command === 'addwin') {
  const wrestlerName = args.join(' ');
  
  if (!wrestlerName) {
    return message.reply('Usage: `!addwin Nom du Lutteur`');
  }

  const federation = await Federation.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  });

  if (!federation) {
    return message.reply('❌ Tu n\'as pas de fédération.');
  }

  // Vérifier que le lutteur est dans ton roster
  const inRoster = federation.roster.find(w => 
    w.wrestlerName.toLowerCase() === wrestlerName.toLowerCase()
  );

  if (!inRoster) {
    return message.reply(`❌ ${wrestlerName} n'est pas dans ton roster.`);
  }

  const wrestler = await Wrestler.findOne({
    name: new RegExp(`^${wrestlerName}$`, 'i'),
    guildId: message.guild.id
  });

  if (!wrestler) {
    return message.reply(`❌ Lutteur introuvable dans la base de données.`);
  }

  // Déterminer le dernier event (Show ou PLE)
  const lastShow = await Show.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  }).sort({ createdAt: -1 });

  const lastPLE = await PLE.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  }).sort({ createdAt: -1 });

  let eventInfo = { type: 'show', name: 'N/A', number: 0 };

  if (!lastShow && !lastPLE) {
    return message.reply('❌ Tu dois d\'abord créer un show avec `!showend` ou un PLE avec `!pleend`.');
  }

  // Comparer les dates pour savoir quel est le plus récent
  if (lastPLE && (!lastShow || new Date(lastPLE.createdAt) > new Date(lastShow.createdAt))) {
    eventInfo = { type: 'ple', name: lastPLE.pleName, number: null };
  } else if (lastShow) {
    eventInfo = { type: 'show', name: `Show #${lastShow.showNumber}`, number: lastShow.showNumber };
  }

  wrestler.wins += 1;
  await wrestler.save();

  const record = `${wrestler.wins}-${wrestler.losses}`;
  const winRate = wrestler.wins + wrestler.losses > 0 
    ? ((wrestler.wins / (wrestler.wins + wrestler.losses)) * 100).toFixed(1)
    : 0;

  const eventIcon = eventInfo.type === 'ple' ? '🎭' : '📺';

  const embed = new EmbedBuilder()
    .setTitle('✅ Victoire Ajoutée !')
    .setDescription(`**${wrestler.name}**`)
    .addFields(
      { name: 'Record', value: record, inline: true },
      { name: 'Taux de Victoire', value: `${winRate}%`, inline: true },
      { name: 'Event', value: `${eventIcon} ${eventInfo.name}`, inline: true }
    )
    .setColor(federation.color)
    .setFooter({ text: `${federation.name}` });

  return message.reply({ embeds: [embed] });
}

  // ==========================================================================
  // COMMANDE: AJOUTER UNE DÉFAITE
  // ==========================================================================
  
if (command === 'addloss') {
  const wrestlerName = args.join(' ');
  
  if (!wrestlerName) {
    return message.reply('Usage: `!addloss Nom du Lutteur`');
  }

  const federation = await Federation.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  });

  if (!federation) {
    return message.reply('❌ Tu n\'as pas de fédération.');
  }

  const inRoster = federation.roster.find(w => 
    w.wrestlerName.toLowerCase() === wrestlerName.toLowerCase()
  );

  if (!inRoster) {
    return message.reply(`❌ ${wrestlerName} n'est pas dans ton roster.`);
  }

  const wrestler = await Wrestler.findOne({
    name: new RegExp(`^${wrestlerName}$`, 'i'),
    guildId: message.guild.id
  });

  if (!wrestler) {
    return message.reply(`❌ Lutteur introuvable dans la base de données.`);
  }

  // Déterminer le dernier event (Show ou PLE)
  const lastShow = await Show.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  }).sort({ createdAt: -1 });

  const lastPLE = await PLE.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  }).sort({ createdAt: -1 });

  let eventInfo = { type: 'show', name: 'N/A', number: 0 };

  if (!lastShow && !lastPLE) {
    return message.reply('❌ Tu dois d\'abord créer un show avec `!showend` ou un PLE avec `!pleend`.');
  }

  // Comparer les dates pour savoir quel est le plus récent
  if (lastPLE && (!lastShow || new Date(lastPLE.createdAt) > new Date(lastShow.createdAt))) {
    eventInfo = { type: 'ple', name: lastPLE.pleName, number: null };
  } else if (lastShow) {
    eventInfo = { type: 'show', name: `Show #${lastShow.showNumber}`, number: lastShow.showNumber };
  }

  wrestler.losses += 1;
  await wrestler.save();

  const record = `${wrestler.wins}-${wrestler.losses}`;
  const winRate = wrestler.wins + wrestler.losses > 0 
    ? ((wrestler.wins / (wrestler.wins + wrestler.losses)) * 100).toFixed(1)
    : 0;

  const eventIcon = eventInfo.type === 'ple' ? '🎭' : '📺';

  const embed = new EmbedBuilder()
    .setTitle('❌ Défaite Ajoutée')
    .setDescription(`**${wrestler.name}**`)
    .addFields(
      { name: 'Record', value: record, inline: true },
      { name: 'Taux de Victoire', value: `${winRate}%`, inline: true },
      { name: 'Event', value: `${eventIcon} ${eventInfo.name}`, inline: true }
    )
    .setColor(federation.color)
    .setFooter({ text: `${federation.name}` });

  return message.reply({ embeds: [embed] });
}

  // ==========================================================================
  // COMMANDE: RETIRER UNE VICTOIRE
  // ==========================================================================
  
  if (command === 'delwin') {
    const wrestlerName = args.join(' ');
    
    if (!wrestlerName) {
      return message.reply('Usage: `!delwin Nom du Lutteur`');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('❌ Tu n\'as pas de fédération.');
    }

    const inRoster = federation.roster.find(w => 
      w.wrestlerName.toLowerCase() === wrestlerName.toLowerCase()
    );

    if (!inRoster) {
      return message.reply(`❌ ${wrestlerName} n'est pas dans ton roster.`);
    }

    const wrestler = await Wrestler.findOne({
      name: new RegExp(`^${wrestlerName}$`, 'i'),
      guildId: message.guild.id
    });

    if (!wrestler) {
      return message.reply(`❌ Lutteur introuvable.`);
    }

    if (wrestler.wins === 0) {
      return message.reply(`❌ ${wrestler.name} n'a aucune victoire à retirer.`);
    }

    wrestler.wins -= 1;
    await wrestler.save();

    const record = `${wrestler.wins}-${wrestler.losses}`;

    const embed = new EmbedBuilder()
      .setTitle('➖ Victoire Retirée')
      .setDescription(`**${wrestler.name}**`)
      .addFields({ name: 'Nouveau Record', value: record })
      .setColor(federation.color);

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: RETIRER UNE DÉFAITE
  // ==========================================================================
  
  if (command === 'delloss') {
    const wrestlerName = args.join(' ');
    
    if (!wrestlerName) {
      return message.reply('Usage: `!delloss Nom du Lutteur`');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('❌ Tu n\'as pas de fédération.');
    }

    const inRoster = federation.roster.find(w => 
      w.wrestlerName.toLowerCase() === wrestlerName.toLowerCase()
    );

    if (!inRoster) {
      return message.reply(`❌ ${wrestlerName} n'est pas dans ton roster.`);
    }

    const wrestler = await Wrestler.findOne({
      name: new RegExp(`^${wrestlerName}$`, 'i'),
      guildId: message.guild.id
    });

    if (!wrestler) {
      return message.reply(`❌ Lutteur introuvable.`);
    }

    if (wrestler.losses === 0) {
      return message.reply(`❌ ${wrestler.name} n'a aucune défaite à retirer.`);
    }

    wrestler.losses -= 1;
    await wrestler.save();

    const record = `${wrestler.wins}-${wrestler.losses}`;

    const embed = new EmbedBuilder()
      .setTitle('➖ Défaite Retirée')
      .setDescription(`**${wrestler.name}**`)
      .addFields({ name: 'Nouveau Record', value: record })
      .setColor(federation.color);

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
// COMMANDE: ENREGISTRER UN MATCH
// ==========================================================================

// ============================================================================
// 2. COMMANDE !MATCH AMÉLIORÉE (Tag Team & Multi-Man)
// REMPLACE la commande !match existante
// ============================================================================

if (command === 'match') {
  const content = args.join(' ');
  
  // Détecter le type de match
  let matchType = 'singles'; // singles, tag, multi
  let teams = [];
  
  // Tag Team: "Team1 (A & B) vs Team2 (C & D)"
  const tagMatch = content.match(/(.+?)\s*\((.+?)\s*&\s*(.+?)\)\s*vs\s*(.+?)\s*\((.+?)\s*&\s*(.+?)\)/i);
  
  // Multi-Man: "A vs B vs C vs D"
  const multiMatch = content.split(/\s+vs\s+/i);
  
  if (tagMatch) {
    matchType = 'tag';
    teams = [
      {
        name: tagMatch[1].trim(),
        members: [tagMatch[2].trim(), tagMatch[3].trim()],
        isWinner: true
      },
      {
        name: tagMatch[4].trim(),
        members: [tagMatch[5].trim(), tagMatch[6].trim()],
        isWinner: false
      }
    ];
  } else if (multiMatch.length > 2) {
    matchType = 'multi';
    teams = multiMatch.map((name, i) => ({
      name: name.trim(),
      members: [name.trim()],
      isWinner: i === 0 // Le premier mentionné gagne
    }));
  } else if (multiMatch.length === 2) {
    matchType = 'singles';
    teams = [
      { name: multiMatch[0].trim(), members: [multiMatch[0].trim()], isWinner: true },
      { name: multiMatch[1].trim(), members: [multiMatch[1].trim()], isWinner: false }
    ];
  } else {
    return message.reply(
      '❌ Format invalide.\n\n**Formats acceptés:**\n' +
      '• Simple: `!match Winner vs Loser`\n' +
      '• Tag Team: `!match Team1 (A & B) vs Team2 (C & D)`\n' +
      '• Multi-Man: `!match Winner vs Loser1 vs Loser2 vs Loser3`\n\n' +
      '⚠️ Le premier lutteur/équipe mentionné(e) est le vainqueur'
    );
  }

  const federation = await Federation.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  });

  if (!federation) {
    return message.reply('❌ Tu n\'as pas de fédération.');
  }

const lastShow = await Show.findOne({
  userId: message.author.id,
  guildId: message.guild.id
}).sort({ createdAt: -1 });

const lastPLE = await PLE.findOne({
  userId: message.author.id,
  guildId: message.guild.id
}).sort({ createdAt: -1 });

if (!lastShow && !lastPLE) {
  return message.reply('❌ Tu dois d\'abord créer un show avec `!showend` ou un PLE avec `!pleend`.');
}

// Déterminer quel event est le plus récent
let eventInfo = { type: 'show', name: 'Show', number: 0 };

if (lastPLE && (!lastShow || new Date(lastPLE.createdAt) > new Date(lastShow.createdAt))) {
  eventInfo = { type: 'ple', name: lastPLE.pleName, number: null };
} else if (lastShow) {
  eventInfo = { type: 'show', name: federation.name, number: lastShow.showNumber };
}

  // Traiter chaque équipe/lutteur
  const processedWrestlers = [];
  
  for (const team of teams) {
    for (const memberName of team.members) {
      let wrestler = await Wrestler.findOne({
        name: new RegExp(`^${memberName}$`, 'i'),
        guildId: message.guild.id
      });

      if (!wrestler) {
        wrestler = new Wrestler({ name: memberName, guildId: message.guild.id });
        await wrestler.save();
      }

      // Mettre à jour stats
      if (team.isWinner) {
        wrestler.wins += 1;
      } else {
        wrestler.losses += 1;
      }

      // Ajouter à l'historique
      if (!wrestler.matchHistory) wrestler.matchHistory = [];
      
      const opponentNames = teams
        .filter(t => t !== team)
        .map(t => t.name)
        .join(' vs ');

wrestler.matchHistory.push({
  opponent: opponentNames,
  result: team.isWinner ? 'win' : 'loss',
  federationName: federation.name,
  showNumber: eventInfo.type === 'show' ? eventInfo.number : null,
  pleName: eventInfo.type === 'ple' ? eventInfo.name : null,
  eventType: eventInfo.type,
  date: new Date()
});
      await wrestler.save();
      processedWrestlers.push({ wrestler, isWinner: team.isWinner });
    }
  }

  // Créer l'embed de résultat
  const matchTypeText = {
    singles: '⚔️ Match Simple',
    tag: '👥 Match Tag Team',
    multi: '🔥 Match Multi-Man'
  }[matchType];

  const winnersText = teams.find(t => t.isWinner).members
    .map(name => {
      const w = processedWrestlers.find(p => p.wrestler.name.toLowerCase() === name.toLowerCase()).wrestler;
      return `${w.name} (${w.wins}-${w.losses})`;
    }).join(' & ');

  const losersText = teams.filter(t => !t.isWinner)
    .map(team => team.members
      .map(name => {
        const w = processedWrestlers.find(p => p.wrestler.name.toLowerCase() === name.toLowerCase()).wrestler;
        return `${w.name} (${w.wins}-${w.losses})`;
      }).join(' & ')
    ).join(' vs ');

const eventIcon = eventInfo.type === 'ple' ? '🎭' : '📺';
const eventText = eventInfo.type === 'ple' 
  ? eventInfo.name 
  : `Show #${eventInfo.number}`;

const embed = new EmbedBuilder()
  .setTitle(`${matchTypeText} Enregistré !`)
  .setDescription(`**${federation.name}** - ${eventIcon} ${eventText}`)
    .addFields(
      { name: '🏆 Vainqueur(s)', value: winnersText },
      { name: '❌ Perdant(s)', value: losersText }
    )
    .setColor(federation.color)
    .setFooter({ text: 'Les stats ont été mises à jour' });

  return message.reply({ embeds: [embed] });
}

  // ==========================================================================
// COMMANDE: HISTORIQUE DES MATCHS D'UN LUTTEUR
// ==========================================================================

if (command === 'matchs') {
  const wrestlerName = args.join(' ');
  
  if (!wrestlerName) {
    return message.reply('Usage: `!matchs Nom du Lutteur`\nExemple: !matchs John Cena');
  }

  const wrestler = await Wrestler.findOne({
    name: new RegExp(`^${wrestlerName}$`, 'i'),
    guildId: message.guild.id
  });

  if (!wrestler) {
    return message.reply(`❌ ${wrestlerName} n'existe pas dans cette ligue.`);
  }

  if (!wrestler.matchHistory || wrestler.matchHistory.length === 0) {
    return message.reply(`${wrestler.name} n'a aucun match enregistré.`);
  }

const matchesText = wrestler.matchHistory
  .sort((a, b) => new Date(b.date) - new Date(a.date))
  .map((match, i) => {
    const resultIcon = match.result === 'win' ? '✅' : '❌';
    const resultText = match.result === 'win' ? 'VICTOIRE' : 'DÉFAITE';
    const date = new Date(match.date).toLocaleDateString('fr-FR');
    
    // Déterminer le type d'event
    let eventText;
    if (match.eventType === 'ple' || match.pleName) {
      eventText = `🎭 ${match.pleName || 'PLE'}`;
    } else {
      eventText = `📺 ${match.federationName} - Show #${match.showNumber}`;
    }
    
    return `**${i + 1}.** ${resultIcon} ${resultText} vs **${match.opponent}**\n${eventText} (${date})`;
  }).join('\n\n');
  const record = `${wrestler.wins}-${wrestler.losses}`;
  const winRate = wrestler.wins + wrestler.losses > 0 
    ? ((wrestler.wins / (wrestler.wins + wrestler.losses)) * 100).toFixed(1)
    : 0;

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ Historique de Matchs - ${wrestler.name}`)
    .setDescription(`**Record:** ${record} (${winRate}% victoires)`)
    .addFields({ name: '📋 Matchs', value: matchesText })
    .setColor('#E67E22')
    .setFooter({ text: `${wrestler.matchHistory.length} match(s) total` })
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}

    // ==========================================================================
  // COMMANDE: SUPPRIMER LE DERNIER MATCH D'UN LUTTEUR
  // ==========================================================================
  
  if (command === 'dellast') {
    const wrestlerName = args.join(' ');
    
    if (!wrestlerName) {
      return message.reply('Usage: `!dellast Nom du Lutteur`\nExemple: !dellast John Cena');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('❌ Tu n\'as pas de fédération.');
    }

    const wrestler = await Wrestler.findOne({
      name: new RegExp(`^${wrestlerName}$`, 'i'),
      guildId: message.guild.id
    });

    if (!wrestler) {
      return message.reply(`❌ ${wrestlerName} n'existe pas dans cette ligue.`);
    }

    if (!wrestler.matchHistory || wrestler.matchHistory.length === 0) {
      return message.reply(`❌ ${wrestler.name} n'a aucun match enregistré.`);
    }

    // Récupérer le dernier match
    const sortedMatches = wrestler.matchHistory.sort((a, b) => new Date(b.date) - new Date(a.date));
    const lastMatch = sortedMatches[0];

    // Déterminer le type d'event du match à supprimer
    let eventText;
    if (lastMatch.eventType === 'ple' || lastMatch.pleName) {
      eventText = `🎭 ${lastMatch.pleName || 'PLE'}`;
    } else {
      eventText = `📺 Show #${lastMatch.showNumber}`;
    }

    const matchResult = lastMatch.result === 'win' ? 'Victoire' : 'Défaite';

    // Supprimer le match de l'historique
    wrestler.matchHistory = wrestler.matchHistory.filter(m => m !== lastMatch);

    // Ajuster les statistiques
    if (lastMatch.result === 'win') {
      wrestler.wins = Math.max(0, wrestler.wins - 1);
    } else {
      wrestler.losses = Math.max(0, wrestler.losses - 1);
    }

    await wrestler.save();

    const newRecord = `${wrestler.wins}-${wrestler.losses}`;
    const winRate = wrestler.wins + wrestler.losses > 0 
      ? ((wrestler.wins / (wrestler.wins + wrestler.losses)) * 100).toFixed(1)
      : 0;

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Dernier Match Supprimé')
      .setDescription(`**${wrestler.name}**`)
      .addFields(
        { name: 'Match Supprimé', value: `${matchResult} vs **${lastMatch.opponent}**\n${eventText}` },
        { name: 'Nouveau Record', value: newRecord, inline: true },
        { name: 'Win Rate', value: `${winRate}%`, inline: true }
      )
      .setColor(federation.color)
      .setFooter({ text: `${federation.name}` });

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: AJOUTER UNE DÉFENSE DE TITRE
  // ==========================================================================
  
  if (command === 'defense') {
    const wrestlerName = args.join(' ');
    
    if (!wrestlerName) {
      return message.reply('Usage: `!defense Nom du Lutteur`');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('❌ Tu n\'as pas de fédération.');
    }

    // Vérifier que le lutteur est dans ton roster
    const inRoster = federation.roster.find(w => 
      w.wrestlerName.toLowerCase() === wrestlerName.toLowerCase()
    );

    if (!inRoster) {
      return message.reply(`❌ ${wrestlerName} n'est pas dans ton roster.`);
    }

    // Trouver le titre que ce lutteur détient
    const belt = await Belt.findOne({
      userId: message.author.id,
      guildId: message.guild.id,
      currentChampion: new RegExp(`^${wrestlerName}$`, 'i')
    });

    if (!belt) {
      return message.reply(`❌ ${wrestlerName} ne détient aucun titre actuellement.`);
    }

    // Trouver le règne actuel dans l'historique
    const currentReign = belt.championshipHistory.find(reign => 
      reign.champion.toLowerCase() === wrestlerName.toLowerCase() && !reign.lostAt
    );

    if (!currentReign) {
      return message.reply(`❌ Erreur: règne actuel introuvable dans l'historique.`);
    }

    currentReign.defenses += 1;
    await belt.save();

    const daysHeld = Math.floor((Date.now() - new Date(currentReign.wonAt)) / (1000 * 60 * 60 * 24));

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Défense de Titre Réussie !')
      .setDescription(`**${belt.beltName}**`)
      .addFields(
        { name: 'Champion', value: belt.currentChampion, inline: true },
        { name: 'Défenses', value: `${currentReign.defenses}`, inline: true },
        { name: 'Règne', value: `${daysHeld} jours`, inline: true }
      )
      .setColor(federation.color)
      .setFooter({ text: `${federation.name}` });

    return message.reply({ embeds: [embed] });
  }
  

  // ==========================================================================
  // COMMANDE: VOIR SON ROSTER
  // ==========================================================================
  
if (command === 'roster') {
  const federation = await Federation.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  });

  if (!federation) {
    return message.reply('Tu n\'as pas encore de fédération.');
  }

  if (federation.roster.length === 0) {
    return message.reply('Ton roster est vide.');
  }

  // Récupérer les infos complètes de chaque lutteur
  const rosterWithStats = await Promise.all(
    federation.roster.map(async (r) => {
      const wrestler = await Wrestler.findOne({
        name: new RegExp(`^${r.wrestlerName}$`, 'i'),
        guildId: message.guild.id
      });
      
      return {
        name: r.wrestlerName,
        signedDate: r.signedDate,
        wrestler: wrestler,
        wins: wrestler?.wins || 0,
        losses: wrestler?.losses || 0,
        totalMatches: (wrestler?.wins || 0) + (wrestler?.losses || 0)
      };
    })
  );

  let currentSortMode = 'alpha'; // 'alpha' ou 'record'
  let currentPage = 0;

  const getSortedRoster = (sortMode) => {
    if (sortMode === 'record') {
      return [...rosterWithStats].sort((a, b) => {
        const winRateA = a.totalMatches > 0 ? (a.wins / a.totalMatches) : 0;
        const winRateB = b.totalMatches > 0 ? (b.wins / b.totalMatches) : 0;
        
        // Trier par winrate décroissant, puis par nombre de victoires
        if (winRateB !== winRateA) return winRateB - winRateA;
        return b.wins - a.wins;
      });
    } else {
      // Tri alphabétique par défaut
      return [...rosterWithStats].sort((a, b) => 
        a.name.localeCompare(b.name, 'fr')
      );
    }
  };

  const itemsPerPage = 7;

  const generateEmbed = async (sortMode, page) => {
    const sortedRoster = getSortedRoster(sortMode);
    const totalPages = Math.ceil(sortedRoster.length / itemsPerPage);
    
    const start = page * itemsPerPage;
    const end = start + itemsPerPage;
    const pageRoster = sortedRoster.slice(start, end);

    const rosterText = await Promise.all(pageRoster.map(async (entry, i) => {
      const w = entry.wrestler;
      const signedDate = new Date(entry.signedDate).toLocaleDateString('fr-FR');
      const record = `${entry.wins}-${entry.losses}`;
      
      // Vérifier si le lutteur est titré
      const hasTitles = w?.titleHistory && w.titleHistory.some(t => !t.lostAt);
      const crownIcon = hasTitles ? ' 👑' : '';
      
      // Déterminer le statut réel du lutteur
      let statusIcon = '🔒 Exclusif';
      if (w) {
        if (w.isShared) {
          const sharedCount = w.sharedWith ? w.sharedWith.length : 0;
          if (w.ownerId === message.author.id) {
            // Tu es le propriétaire et tu as partagé
            statusIcon = `🔓 Partagé (${sharedCount} autre${sharedCount > 1 ? 's' : ''})`;
          } else {
            // Tu as drafté un lutteur partagé par quelqu'un d'autre
            statusIcon = '🔀 Partagé';
          }
        } else if (w.ownerId === message.author.id) {
          statusIcon = '🔒 Exclusif';
        }
      }
      
      return `**${start + i + 1}.** ${entry.name}${crownIcon}\n📊 ${record} • ${statusIcon} (Signé le ${signedDate})`;
    }));

    const sortText = sortMode === 'record' ? '📊 Trié par record' : '🔤 Trié alphabétiquement';

    const embed = new EmbedBuilder()
      .setTitle(`🤼 Roster - ${federation.name}`)
      .setDescription(`${sortText}\n\n${rosterText.join('\n\n')}`)
      .addFields(
        { name: 'Total', value: `${federation.roster.length} lutteurs` }
      )
      .setColor(federation.color)
      .setFooter({ text: `Page ${page + 1}/${totalPages} • Utilisez les boutons pour trier et naviguer` });

    if (federation.logoUrl && fs.existsSync(federation.logoUrl)) {
      embed.setThumbnail(`attachment://logo.png`);
    }

    return { embed, totalPages };
  };

  const createButtons = (sortMode, page, totalPages) => {
    const navigationRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('previous')
          .setLabel('◀️ Précédent')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId('next')
          .setLabel('Suivant ▶️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page >= totalPages - 1)
      );

    const sortRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('sort_alpha')
          .setLabel('🔤 Alphabétique')
          .setStyle(sortMode === 'alpha' ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(sortMode === 'alpha'),
        new ButtonBuilder()
          .setCustomId('sort_record')
          .setLabel('📊 Par Record')
          .setStyle(sortMode === 'record' ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(sortMode === 'record')
      );

    return [navigationRow, sortRow];
  };

  const { embed: initialEmbed, totalPages } = await generateEmbed(currentSortMode, currentPage);

  const embedMessage = await message.reply({
    embeds: [initialEmbed],
    components: createButtons(currentSortMode, currentPage, totalPages),
    files: federation.logoUrl && fs.existsSync(federation.logoUrl) 
      ? [new AttachmentBuilder(federation.logoUrl, { name: 'logo.png' })] 
      : []
  });

  const collector = embedMessage.createMessageComponentCollector({
    time: 120000 // 2 minutes
  });

  collector.on('collect', async interaction => {
    if (interaction.user.id !== message.author.id) {
      return interaction.reply({ content: 'Ce n\'est pas ton roster !', ephemeral: true });
    }

    // Gestion de la navigation
    if (interaction.customId === 'previous') {
      currentPage = Math.max(0, currentPage - 1);
    } else if (interaction.customId === 'next') {
      const { totalPages } = await generateEmbed(currentSortMode, 0);
      currentPage = Math.min(totalPages - 1, currentPage + 1);
    }
    // Gestion du tri
    else if (interaction.customId === 'sort_alpha') {
      currentSortMode = 'alpha';
      currentPage = 0; // Retour à la page 1 lors du changement de tri
    } else if (interaction.customId === 'sort_record') {
      currentSortMode = 'record';
      currentPage = 0; // Retour à la page 1 lors du changement de tri
    }

    const { embed: updatedEmbed, totalPages } = await generateEmbed(currentSortMode, currentPage);

    await interaction.update({
      embeds: [updatedEmbed],
      components: createButtons(currentSortMode, currentPage, totalPages)
    });
  });

  collector.on('end', () => {
    embedMessage.edit({ components: [] }).catch(() => {});
  });
}
  
  // ==========================================================================
  // COMMANDE: ANNONCER LA FIN D'UN SHOW
  // ==========================================================================
  
  if (command === 'showend') {
    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('Tu n\'as pas de fédération.');
    }

    const lastShow = await Show.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    }).sort({ showNumber: -1 });

    const showNumber = lastShow ? lastShow.showNumber + 1 : 1;

    const show = new Show({
      showNumber,
      userId: message.author.id,
      guildId: message.guild.id,
      federationName: federation.name
    });

    await show.save();

    const embed = new EmbedBuilder()
      .setTitle(`🎬 Fin du Show #${showNumber}`)
      .setDescription(`**${federation.name}**\n\nRéagissez avec des étoiles pour noter le show !`)
      .addFields(
        { name: 'Statut', value: '⏳ En attente des votes...' }
      )
     .setColor(federation.color);

    const bookeurRole = message.guild.roles.cache.find(r => r.name === 'Bookeur');
    const mention = bookeurRole ? `${bookeurRole}` : '';

    const msg = await message.channel.send({ 
      content: mention ? `${mention} Nouveau show à noter !` : undefined,
      embeds: [embed] 
    });
    
    show.messageId = msg.id;
    await show.save();

    for (let i = 0; i < 10; i++) {
      await msg.react(EMOJI_NUMBERS[i]);
    }

    return message.channel.send('**Légende:** 1️⃣=0.5⭐ | 2️⃣=1⭐ | 3️⃣=1.5⭐ | 4️⃣=2⭐ | 5️⃣=2.5⭐ | 6️⃣=3⭐ | 7️⃣=3.5⭐ | 8️⃣=4⭐ | 9️⃣=4.5⭐ | 🔟=5⭐');
  }

  // ============================================================================
// COMMANDE: ANNONCER LA FIN D'UN PLE
// À ajouter après la commande !showend (vers ligne 1200)
// ============================================================================

if (command === 'pleend') {
  const pleName = args.join(' ');
  
  if (!pleName) {
    return message.reply(
      'Usage: `!pleend Nom du PLE`\n\n' +
      'Exemples:\n' +
      '• `!pleend WrestleMania 41`\n' +
      '• `!pleend Royal Rumble 2026`\n' +
      '• `!pleend SummerSlam`\n\n' +
      '💡 Le nom peut contenir plusieurs mots'
    );
  }

  const federation = await Federation.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  });

  if (!federation) {
    return message.reply('Tu n\'as pas de fédération.');
  }

  const ple = new PLE({
    pleName: pleName,
    userId: message.author.id,
    guildId: message.guild.id,
    federationName: federation.name
  });

  await ple.save();

  const embed = new EmbedBuilder()
    .setTitle(`🎭 ${pleName}`)
    .setDescription(`**${federation.name}**\n\nRéagissez avec des étoiles pour noter le PLE !`)
    .addFields(
      { name: 'Type', value: '🌟 Premium Live Event' },
      { name: 'Statut', value: '⏳ En attente des votes...' }
    )
    .setColor(federation.color);

  const bookeurRole = message.guild.roles.cache.find(r => r.name === 'Bookeur');
  const mention = bookeurRole ? `${bookeurRole}` : '';

  const msg = await message.channel.send({ 
    content: mention ? `${mention} Nouveau PLE à noter !` : undefined,
    embeds: [embed] 
  });
  
  ple.messageId = msg.id;
  await ple.save();

  for (let i = 0; i < 10; i++) {
    await msg.react(EMOJI_NUMBERS[i]);
  }

  return message.channel.send('**Légende:** 1️⃣=0.5⭐ | 2️⃣=1⭐ | 3️⃣=1.5⭐ | 4️⃣=2⭐ | 5️⃣=2.5⭐ | 6️⃣=3⭐ | 7️⃣=3.5⭐ | 8️⃣=4⭐ | 9️⃣=4.5⭐ | 🔟=5⭐');
}

// ============================================================================
// COMMANDE: FINALISER LES VOTES D'UN PLE
// À ajouter après !pleend
// ============================================================================

if (command === 'finalizeple' || command === 'fp') {
  const pleName = args.join(' ');

  if (!pleName) {
    return message.reply('Usage: `!finalizeple Nom du PLE`\nExemple: !finalizeple WrestleMania 41');
  }

  const ple = await PLE.findOne({
    pleName: new RegExp(`^${pleName}$`, 'i'),
    userId: message.author.id,
    guildId: message.guild.id
  });

  if (!ple) {
    return message.reply(`❌ PLE "${pleName}" introuvable.`);
  }

  if (ple.isFinalized) {
    return message.reply(`⚠️ Le PLE "${pleName}" a déjà été finalisé !`);
  }

  if (!ple.messageId) {
    return message.reply('❌ Impossible de retrouver le message du PLE.');
  }

  const federation = await Federation.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  });

  let msg;
  try {
    msg = await message.channel.messages.fetch(ple.messageId);
  } catch (error) {
    return message.reply('❌ Message du PLE introuvable. Il a peut-être été supprimé.');
  }
  
  const votes = [];

  await msg.fetch();

  for (let i = 0; i < 10; i++) {
    const reaction = msg.reactions.cache.find(r => r.emoji.name === EMOJI_NUMBERS[i]);
    
    if (reaction) {
      try {
        const users = await reaction.users.fetch({ limit: 100 });
        
        console.log(`Emoji ${EMOJI_NUMBERS[i]} (${STAR_VALUES[i]}⭐): ${users.size} utilisateurs`);
        
        users.forEach(user => {
          if (!user.bot && !votes.find(v => v.userId === user.id)) {
            votes.push({ 
              userId: user.id, 
              stars: STAR_VALUES[i] 
            });
            console.log(`✅ Vote ajouté: ${user.username} - ${STAR_VALUES[i]}⭐`);
          }
        });
      } catch (error) {
        console.error(`❌ Erreur lors de la récupération des réactions pour ${EMOJI_NUMBERS[i]}:`, error);
      }
    }
  }

  console.log(`📊 Total des votes récupérés: ${votes.length}`);

  if (votes.length === 0) {
    return message.reply('❌ Aucun vote enregistré pour ce PLE. Vérifie que des personnes (autres que le bot) ont bien réagi avec les émojis numérotés.');
  }

  const totalStars = votes.reduce((sum, v) => sum + v.stars, 0);
  const averageRating = totalStars / votes.length;

  ple.ratings = votes;
  ple.averageRating = averageRating;
  ple.isFinalized = true;

  await ple.save();

  const starsDisplay = getStarDisplay(averageRating);

  const votesBreakdown = STAR_VALUES.map((value, i) => {
    const count = votes.filter(v => v.stars === value).length;
    return count > 0 ? `${EMOJI_NUMBERS[i]} (${value}⭐) : ${count} vote${count > 1 ? 's' : ''}` : null;
  }).filter(Boolean).join('\n') || 'Aucun détail disponible';

  const embed = new EmbedBuilder()
    .setTitle(`📊 Résultats - ${ple.pleName}`)
    .setDescription(`**${federation.name}**\n\n✅ PLE finalisé avec succès !`)
    .addFields(
      { name: '⭐ Note Finale', value: `${starsDisplay} **${averageRating.toFixed(2)}/5**`, inline: true },
      { name: '🗳️ Votes', value: `${votes.length} personne${votes.length > 1 ? 's' : ''}`, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: '📈 Répartition des votes', value: votesBreakdown }
    )
    .setColor(federation.color)
    .setFooter({ text: `Finalisé par ${message.author.username}` })
    .setTimestamp();

  try {
    const originalEmbed = msg.embeds[0];
    const updatedEmbed = EmbedBuilder.from(originalEmbed)
      .setColor(federation.color)
      .setFields(
        { name: 'Type', value: '🌟 Premium Live Event' },
        { name: 'Statut', value: '✅ Finalisé !', inline: true },
        { name: 'Note Finale', value: `${starsDisplay} ${averageRating.toFixed(2)}/5`, inline: true },
        { name: 'Votes', value: `${votes.length} personne${votes.length > 1 ? 's' : ''}`, inline: true }
      );
    
    await msg.edit({ embeds: [updatedEmbed] });
  } catch (error) {
    console.error('Erreur lors de la mise à jour du message original:', error);
  }

  return message.reply({ embeds: [embed] });
}

// ============================================================================
// COMMANDE: LISTE DES PLEs D'UNE FÉDÉRATION
// À ajouter après !finalizeple
// ============================================================================

if (command === 'ples' || command === 'myples') {
  const federation = await Federation.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  });

  if (!federation) {
    return message.reply('Tu n\'as pas de fédération.');
  }

  const ples = await PLE.find({
    userId: message.author.id,
    guildId: message.guild.id,
    isFinalized: true
  }).sort({ createdAt: -1 });

  if (ples.length === 0) {
    return message.reply('Tu n\'as aucun PLE finalisé.');
  }

  const avgRating = ples.reduce((sum, p) => sum + p.averageRating, 0) / ples.length;

  const plesText = ples.slice(0, 10).map((p, i) => {
    const date = new Date(p.createdAt).toLocaleDateString('fr-FR');
    const stars = getStarDisplay(p.averageRating);
    return `**${i + 1}. ${p.pleName}**\n${stars} ${p.averageRating.toFixed(2)}/5 - ${date}`;
  }).join('\n\n');

  const embed = new EmbedBuilder()
    .setTitle(`🎭 PLEs de ${federation.name}`)
    .setDescription(plesText)
    .addFields(
      { name: '📊 Total PLEs', value: `${ples.length}`, inline: true },
      { name: '⭐ Moyenne', value: `${getStarDisplay(avgRating)} ${avgRating.toFixed(2)}/5`, inline: true }
    )
    .setColor(federation.color)
    .setFooter({ text: 'Affichage des 10 derniers PLEs' })
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}

// ============================================================================
// COMMANDE: COMPARER LES PLEs PAR NOM
// À ajouter après !ples
// ============================================================================

if (command === 'plecompare' || command === 'pc') {
  const pleName = args.join(' ');
  
  if (!pleName) {
    return message.reply('Usage: `!plecompare Nom du PLE`\nExemple: !plecompare WrestleMania 41');
  }

  const ples = await PLE.find({
    guildId: message.guild.id,
    pleName: new RegExp(`^${pleName}$`, 'i'),
    isFinalized: true
  }).sort({ averageRating: -1 });

  if (ples.length === 0) {
    return message.reply(`❌ Aucun PLE "${pleName}" finalisé trouvé.`);
  }

  const plesList = ples.map((p, i) => {
    const stars = getStarDisplay(p.averageRating);
    const date = new Date(p.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `**${i + 1}.** ${p.federationName}\n${stars} **${p.averageRating.toFixed(2)}/5** - ${date}`;
  }).join('\n\n');

  const embed = new EmbedBuilder()
    .setTitle(`📊 Comparaison - ${pleName}`)
    .setDescription(`${ples.length} fédération(s) ont réalisé ce PLE`)
    .addFields({ name: '⭐ Classement par Note', value: plesList })
    .setColor('#9B59B6')
    .setFooter({ text: 'Classement par note moyenne décroissante' })
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}

  // ==========================================================================
  // COMMANDE: FINALISER LES VOTES D'UN SHOW
  // ==========================================================================
  
 if (command === 'finalize') {
  const showNumber = parseInt(args[0]);

  if (!showNumber) {
    return message.reply('Usage: `!finalize <numéro>`\nExemple: !finalize 1');
  }

  const show = await Show.findOne({
    showNumber,
    userId: message.author.id,
    guildId: message.guild.id
  });

  if (!show) {
    return message.reply(`❌ Show #${showNumber} introuvable.`);
  }

  if (show.isFinalized) {
    return message.reply(`⚠️ Le Show #${showNumber} a déjà été finalisé !`);
  }

  if (!show.messageId) {
    return message.reply('❌ Impossible de retrouver le message du show.');
  }

  const federation = await Federation.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  });

  let msg;
  try {
    msg = await message.channel.messages.fetch(show.messageId);
  } catch (error) {
    return message.reply('❌ Message du show introuvable. Il a peut-être été supprimé.');
  }
  
const votes = [];

// Récupérer à nouveau le message avec toutes ses réactions
await msg.fetch();

// Parcourir tous les émojis numérotés
for (let i = 0; i < 10; i++) {
  const reaction = msg.reactions.cache.find(r => r.emoji.name === EMOJI_NUMBERS[i]);
  
  if (reaction) {
    try {
      // Important: fetch avec limit élevé pour récupérer tous les utilisateurs
      const users = await reaction.users.fetch({ limit: 100 });
      
      console.log(`Emoji ${EMOJI_NUMBERS[i]} (${STAR_VALUES[i]}⭐): ${users.size} utilisateurs`);
      
      users.forEach(user => {
        // Vérifier que l'utilisateur n'a pas déjà voté et que ce n'est pas un bot
        if (!user.bot && !votes.find(v => v.userId === user.id)) {
          votes.push({ 
            userId: user.id, 
            stars: STAR_VALUES[i] 
          });
          console.log(`✅ Vote ajouté: ${user.username} - ${STAR_VALUES[i]}⭐`);
        }
      });
    } catch (error) {
      console.error(`❌ Erreur lors de la récupération des réactions pour ${EMOJI_NUMBERS[i]}:`, error);
    }
  }
}

console.log(`📊 Total des votes récupérés: ${votes.length}`);

if (votes.length === 0) {
  return message.reply('❌ Aucun vote enregistré pour ce show. Vérifie que des personnes (autres que le bot) ont bien réagi avec les émojis numérotés.');
}

  // Calcul de la moyenne
  const totalStars = votes.reduce((sum, v) => sum + v.stars, 0);
  const averageRating = totalStars / votes.length;

  // Enregistrement dans la base de données
  show.ratings = votes;
  show.averageRating = averageRating;
  show.isFinalized = true;

  await show.save();

  const starsDisplay = getStarDisplay(averageRating);

  // Affichage détaillé des votes
  const votesBreakdown = STAR_VALUES.map((value, i) => {
    const count = votes.filter(v => v.stars === value).length;
    return count > 0 ? `${EMOJI_NUMBERS[i]} (${value}⭐) : ${count} vote${count > 1 ? 's' : ''}` : null;
  }).filter(Boolean).join('\n') || 'Aucun détail disponible';

  const embed = new EmbedBuilder()
    .setTitle(`📊 Résultats - Show #${showNumber}`)
    .setDescription(`**${federation.name}**\n\n✅ Show finalisé avec succès !`)
    .addFields(
      { name: '⭐ Note Finale', value: `${starsDisplay} **${averageRating.toFixed(2)}/5**`, inline: true },
      { name: '🗳️ Votes', value: `${votes.length} personne${votes.length > 1 ? 's' : ''}`, inline: true },
      { name: '\u200B', value: '\u200B', inline: true }, // Spacer
      { name: '📈 Répartition des votes', value: votesBreakdown }
    )
    .setColor(federation.color)
    .setFooter({ text: `Finalisé par ${message.author.username}` })
    .setTimestamp();

  // Mise à jour du message original du show
  try {
    const originalEmbed = msg.embeds[0];
    const updatedEmbed = EmbedBuilder.from(originalEmbed)
      .setColor(federation.color)
      .setFields(
        { name: 'Statut', value: '✅ Finalisé !', inline: true },
        { name: 'Note Finale', value: `${starsDisplay} ${averageRating.toFixed(2)}/5`, inline: true },
        { name: 'Votes', value: `${votes.length} personne${votes.length > 1 ? 's' : ''}`, inline: true }
      );
    
    await msg.edit({ embeds: [updatedEmbed] });
  } catch (error) {
    console.error('Erreur lors de la mise à jour du message original:', error);
  }

  return message.reply({ embeds: [embed] });
}
  // ==========================================================================
  // COMMANDE: CRÉER UN TITRE
  // ==========================================================================
  
  if (command === 'createbelt') {
    const beltName = args.join(' ');

    if (!beltName) {
      return message.reply('Usage: `!createbelt Nom du Titre`');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('Tu n\'as pas de fédération.');
    }

    const existing = await Belt.findOne({
      userId: message.author.id,
      guildId: message.guild.id,
      beltName: new RegExp(`^${beltName}$`, 'i')
    });

    if (existing) {
      return message.reply('Ce titre existe déjà dans ta fédération !');
    }

    const belt = new Belt({
      userId: message.author.id,
      guildId: message.guild.id,
      federationName: federation.name,
      beltName: beltName
    });

    await belt.save();

    const embed = new EmbedBuilder()
      .setTitle('🏆 Titre Créé !')
      .addFields(
        { name: 'Fédération', value: federation.name },
        { name: 'Titre', value: beltName },
        { name: 'Champion Actuel', value: 'Vacant' }
      )
      .setColor('#FFD700');

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: DÉFINIR UN CHAMPION
  // ==========================================================================
  
if (command === 'setchamp') {
  const content = args.join(' ');
  const match = content.match(/"([^"]+)"\s+(.+)/);
  
  if (!match) {
    return message.reply('Usage: `!setchamp "Nom du Titre" Nom du Lutteur`\nExemple: !setchamp "WWE Championship" John Cena\nPour un titre Tag/Team: !setchamp "Tag Team Championship" Lutteur 1 & Lutteur 2');
  }

  const beltName = match[1];
  const wrestlerName = match[2];

  const federation = await Federation.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  });

  if (!federation) {
    return message.reply('Tu n\'as pas de fédération.');
  }

  const belt = await Belt.findOne({
    userId: message.author.id,
    guildId: message.guild.id,
    beltName: new RegExp(`^${beltName}$`, 'i')
  });

  if (!belt) {
    return message.reply(`Le titre "${beltName}" n'existe pas. Crée-le avec \`!createbelt ${beltName}\``);
  }

  // Vérifier si c'est un titre Tag Team
  const isTagTitle = /tag|team/i.test(belt.beltName);
  
  let formattedWrestlerName;
  let wrestlers = [];

  if (isTagTitle) {
    // Séparer les deux lutteurs
    const parts = wrestlerName.split(/\s*&\s*/);
    
    if (parts.length !== 2) {
      return message.reply('❌ Pour un titre Tag Team, utilise le format: `Lutteur 1 & Lutteur 2`');
    }

    wrestlers = parts.map(name => 
      name.trim().split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
    );

    formattedWrestlerName = wrestlers.join(' & ');

    // Ajouter le titre à l'historique des deux lutteurs
    for (const wrestlerN of wrestlers) {
      const wrestlerDoc = await Wrestler.findOne({
        name: new RegExp(`^${wrestlerN}$`, 'i'),
        guildId: message.guild.id
      });

      if (wrestlerDoc) {
        if (!wrestlerDoc.titleHistory) {
          wrestlerDoc.titleHistory = [];
        }
        wrestlerDoc.titleHistory.push({
          beltName: belt.beltName,
          federationName: federation.name,
          wonAt: new Date(),
          lostAt: null
        });
        await wrestlerDoc.save();
      }
    }
  } else {
    // Titre simple
    formattedWrestlerName = wrestlerName.split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

    // Ajouter le titre à l'historique du lutteur
    const wrestlerDoc = await Wrestler.findOne({
      name: new RegExp(`^${formattedWrestlerName}$`, 'i'),
      guildId: message.guild.id
    });

    if (wrestlerDoc) {
      if (!wrestlerDoc.titleHistory) {
        wrestlerDoc.titleHistory = [];
      }
      wrestlerDoc.titleHistory.push({
        beltName: belt.beltName,
        federationName: federation.name,
        wonAt: new Date(),
        lostAt: null
      });
      await wrestlerDoc.save();
    }
  }

  // Si quelqu'un est déjà champion, terminer son règne
  if (belt.currentChampion && belt.championshipHistory) {
    const currentReign = belt.championshipHistory[belt.championshipHistory.length - 1];
    if (currentReign && !currentReign.lostAt) {
      currentReign.lostAt = new Date();
      
      // Terminer le règne dans l'historique des lutteurs concernés
      if (isTagTitle && currentReign.champion.includes('&')) {
        const oldChamps = currentReign.champion.split(' & ');
        for (const champ of oldChamps) {
          const wrestlerDoc = await Wrestler.findOne({
            name: new RegExp(`^${champ.trim()}$`, 'i'),
            guildId: message.guild.id
          });
          if (wrestlerDoc && wrestlerDoc.titleHistory) {
            const reign = wrestlerDoc.titleHistory.find(
              t => t.beltName === belt.beltName && !t.lostAt
            );
            if (reign) {
              reign.lostAt = new Date();
              await wrestlerDoc.save();
            }
          }
        }
      } else {
        const wrestlerDoc = await Wrestler.findOne({
          name: new RegExp(`^${currentReign.champion}$`, 'i'),
          guildId: message.guild.id
        });
        if (wrestlerDoc && wrestlerDoc.titleHistory) {
          const reign = wrestlerDoc.titleHistory.find(
            t => t.beltName === belt.beltName && !t.lostAt
          );
          if (reign) {
            reign.lostAt = new Date();
            await wrestlerDoc.save();
          }
        }
      }
    }
  }

  // Ajouter le nouveau règne à l'historique
  if (!belt.championshipHistory) {
    belt.championshipHistory = [];
  }

  belt.championshipHistory.push({
    champion: formattedWrestlerName,
    wonAt: new Date(),
    lostAt: null,
    defenses: 0
  });

  belt.currentChampion = formattedWrestlerName;
  await belt.save();

  const embed = new EmbedBuilder()
    .setTitle(isTagTitle ? '👑 Nouveaux Champions !' : '👑 Nouveau Champion !')
    .addFields(
      { name: 'Titre', value: belt.beltName },
      { name: isTagTitle ? 'Champions' : 'Champion', value: formattedWrestlerName },
      { name: 'Fédération', value: federation.name }
    )
    .setColor('#FFD700')
    .setFooter({ text: 'Règne enregistré dans l\'historique' });

  return message.reply({ embeds: [embed] });
}

  // ==========================================================================
  // COMMANDE: HISTORIQUE D'UN TITRE
  // ==========================================================================
  
  if (command === 'titlehistory' || command === 'th') {
    const beltName = args.join(' ');
    
    if (!beltName) {
      return message.reply('Usage: `!titlehistory Nom du Titre`\nExemple: !titlehistory World Championship');
    }

    const belt = await Belt.findOne({
      guildId: message.guild.id,
      beltName: new RegExp(`^${beltName}$`, 'i')
    });

    if (!belt) {
      return message.reply(`❌ Le titre "${beltName}" n'existe pas.`);
    }

    const federation = await Federation.findOne({
      userId: belt.userId,
      guildId: message.guild.id
    });

    if (!belt.championshipHistory || belt.championshipHistory.length === 0) {
      const currentChampText = belt.currentChampion 
        ? `Champion actuel: **${belt.currentChampion}** (depuis la création)`
        : 'Titre vacant - Aucun historique';

      const embed = new EmbedBuilder()
        .setTitle(`👑 ${belt.beltName}`)
        .setDescription(`**${federation.name}**\n\n${currentChampText}`)
        .setColor('#FFD700')
        .setFooter({ text: 'Aucun règne enregistré dans l\'historique' });

      // Ajouter le logo du titre si disponible
      if (belt.logoUrl && fs.existsSync(belt.logoUrl)) {
        embed.setImage(`attachment://belt_logo.png`);
        const attachment = new AttachmentBuilder(belt.logoUrl, { name: 'belt_logo.png' });
        return message.reply({ embeds: [embed], files: [attachment] });
      }

      return message.reply({ embeds: [embed] });
    }

    // Trier par date de victoire (plus récent en premier)
    const history = [...belt.championshipHistory]
      .sort((a, b) => new Date(b.wonAt) - new Date(a.wonAt));

    const historyText = history.map((reign, i) => {
      const wonDate = new Date(reign.wonAt).toLocaleDateString('fr-FR', { 
        day: '2-digit', 
        month: '2-digit', 
        year: 'numeric' 
      });
      
      let reignText = `**${i + 1}.** ${reign.champion}\n`;
      reignText += `📅 Couronné: ${wonDate}\n`;
      
      if (reign.lostAt) {
        const lostDate = new Date(reign.lostAt).toLocaleDateString('fr-FR', { 
          day: '2-digit', 
          month: '2-digit', 
          year: 'numeric' 
        });
        const daysHeld = Math.floor((new Date(reign.lostAt) - new Date(reign.wonAt)) / (1000 * 60 * 60 * 24));
        reignText += `📉 Perdu: ${lostDate} (${daysHeld} jours)\n`;
      } else {
        const daysHeld = Math.floor((Date.now() - new Date(reign.wonAt)) / (1000 * 60 * 60 * 24));
        reignText += `👑 **Règne actuel** (${daysHeld} jours)\n`;
      }
      
      reignText += `🛡️ Défenses: ${reign.defenses}`;
      
      return reignText;
    }).join('\n\n');

    // Statistiques
    const totalReigns = history.length;
    const longestReign = history.reduce((max, reign) => {
      const duration = reign.lostAt 
        ? new Date(reign.lostAt) - new Date(reign.wonAt)
        : Date.now() - new Date(reign.wonAt);
      return duration > max.duration ? { champion: reign.champion, duration } : max;
    }, { champion: '', duration: 0 });

    const longestDays = Math.floor(longestReign.duration / (1000 * 60 * 60 * 24));

const embed = new EmbedBuilder()
      .setTitle(`👑 ${belt.beltName}`)
      .setDescription(`**${federation.name}**`)
      .addFields(
        { name: '📊 Statistiques', value: `${totalReigns} règne(s)\n🏆 Plus long: **${longestReign.champion}** (${longestDays} jours)` },
        { name: '📜 Historique Complet', value: historyText }
      )
      .setColor(federation.color)
      .setFooter({ text: 'Champion actuel marqué par 👑' })
      .setTimestamp();

    // Ajouter le logo du titre si disponible
    console.log(`[DEBUG titlehistory] Belt: ${belt.beltName}, logoUrl: ${belt.logoUrl}`);
    console.log(`[DEBUG titlehistory] File exists: ${belt.logoUrl ? fs.existsSync(belt.logoUrl) : 'no logoUrl'}`);
    if (belt.logoUrl && fs.existsSync(belt.logoUrl)) {
      embed.setImage(`attachment://belt_logo.png`);
      const attachment = new AttachmentBuilder(belt.logoUrl, { name: 'belt_logo.png' });
      console.log(`[DEBUG titlehistory] Attaching logo: ${belt.logoUrl}`);
      return message.reply({ embeds: [embed], files: [attachment] });
    }

    return message.reply({ embeds: [embed] });
  }


  // ==========================================================================
  // COMMANDE: SUPPRIMER UN TITRE
  // ==========================================================================
  

  // ==========================================================================
  // COMMANDE: LIBÉRER UN TITRE (VACATE)
  // ==========================================================================
  
  if (command === 'vacate') {
    const beltName = args.join(' ');
    
    if (!beltName) {
      return message.reply('Usage: `!vacate Nom du Titre`\nExemple: !vacate World Championship');
    }

    const belt = await Belt.findOne({
      userId: message.author.id,
      guildId: message.guild.id,
      beltName: new RegExp(`^${beltName}$`, 'i')
    });

    if (!belt) {
      return message.reply(`❌ Tu n'as pas de titre nommé "${beltName}".`);
    }

    if (!belt.currentChampion) {
      return message.reply(`⚠️ Le titre **${belt.beltName}** est déjà vacant.`);
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    // Enregistrer la fin du règne dans l'historique
    if (belt.championshipHistory && belt.championshipHistory.length > 0) {
      const currentReign = belt.championshipHistory[belt.championshipHistory.length - 1];
      if (!currentReign.lostAt) {
        currentReign.lostAt = new Date();
      }
    }

    const formerChampion = belt.currentChampion;
    belt.currentChampion = null;
    await belt.save();

    const embed = new EmbedBuilder()
      .setTitle('🔓 Titre Libéré')
      .setDescription(`**${belt.beltName}** est maintenant vacant`)
      .addFields(
        { name: 'Ancien Champion', value: formerChampion },
        { name: 'Fédération', value: federation.name },
        { name: 'Statut', value: '⚠️ Vacant - En attente d\'un nouveau champion' }
      )
      .setColor(federation.color)
      .setFooter({ text: 'Utilisez !setchamp pour couronner un nouveau champion' });

    return message.reply({ embeds: [embed] });
  }
  if (command === 'delbelt') {
    const beltName = args.join(' ');
    
    if (!beltName) {
      return message.reply('Usage: `!delbelt Nom du Titre`\nExemple: !delbelt World Championship');
    }

    const belt = await Belt.findOne({
      userId: message.author.id,
      guildId: message.guild.id,
      beltName: new RegExp(`^${beltName}$`, 'i')
    });

    if (!belt) {
      return message.reply(`❌ Tu n'as pas de titre nommé "${beltName}".`);
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    // Supprimer le fichier logo s'il existe
    if (belt.logoUrl && fs.existsSync(belt.logoUrl)) {
      try {
        fs.unlinkSync(belt.logoUrl);
        console.log(`[DEBUG delbelt] Logo deleted: ${belt.logoUrl}`);
      } catch (err) {
        console.error(`[DEBUG delbelt] Error deleting logo: ${err.message}`);
      }
    }

    // Supprimer le titre de la base de données
    await Belt.deleteOne({ _id: belt._id });

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Titre Supprimé')
      .setDescription(`Le titre **${belt.beltName}** a été supprimé définitivement`)
      .addFields(
        { name: 'Fédération', value: federation.name },
        { name: 'Ancien Champion', value: belt.currentChampion || 'Vacant' },
        { name: 'Règnes Enregistrés', value: `${belt.championshipHistory ? belt.championshipHistory.length : 0}` }
      )
      .setColor('#E74C3C')
      .setFooter({ text: 'Cette action est irréversible' });

    return message.reply({ embeds: [embed] });
  }
  // ==========================================================================
  // COMMANDE: VOIR SA FÉDÉRATION (AMÉLIORÉE)
  // ==========================================================================
  
  if (command === 'fed') {
    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('Tu n\'as pas de fédération.');
    }

const shows = await Show.find({
  userId: message.author.id,
  guildId: message.guild.id,
  isFinalized: true
}).sort({ createdAt: -1 });

const ples = await PLE.find({
  userId: message.author.id,
  guildId: message.guild.id,
  isFinalized: true
}).sort({ createdAt: -1 });

// Combiner et trier par note
const allEvents = [
  ...shows.map(s => ({ name: `Show #${s.showNumber}`, rating: s.averageRating, createdAt: s.createdAt, type: 'show' })),
  ...ples.map(p => ({ name: p.pleName, rating: p.averageRating, createdAt: p.createdAt, type: 'ple' }))
].sort((a, b) => b.rating - a.rating);

const avgRating = allEvents.length > 0 
  ? allEvents.reduce((sum, e) => sum + e.rating, 0) / allEvents.length 
  : 0;

// Top 3 meilleurs events (tous types confondus)
const topEvents = allEvents.slice(0, 3);
const eventsText = topEvents.length > 0
  ? topEvents.map((e, i) => {
      const date = new Date(e.createdAt).toLocaleDateString('fr-FR');
      const stars = getStarDisplay(e.rating);
      const icon = e.type === 'ple' ? '🎭' : '📺';
      return `**${i + 1}. ${icon} ${e.name}** - ${date}\n${stars} ${e.rating.toFixed(2)}/5`;
    }).join('\n\n')
  : 'Aucun event finalisé';

// Champions avec logos
const belts = await Belt.find({
  userId: message.author.id,
  guildId: message.guild.id
});

const championsText = belts.length > 0
  ? belts.map(b => {
      const hasLogo = (b.logoUrl && fs.existsSync(b.logoUrl)) ? ' 🖼️' : '';
      return `🏆 **${b.beltName}**${hasLogo}: ${b.currentChampion || 'Vacant'}`;
    }).join('\n')
  : 'Aucun titre créé';

    const createdDate = new Date(federation.createdAt).toLocaleDateString('fr-FR');
    const avgStars = getStarDisplay(avgRating);
    const tvRating = await calculateTVRating(message.author.id, message.guild.id);
    const grade = getTVRatingGrade(tvRating);

    const embed = new EmbedBuilder()
      .setTitle(`${federation.name}`)
      .setDescription(`📅 Créée le ${createdDate}`)
      .addFields(
        { name: '🤼 Roster', value: `${federation.roster.length} lutteurs`, inline: true },
        { name: '📺 Shows', value: `${shows.length} complétés`, inline: true },
        { name: '⭐ Moyenne Globale', value: avgRating > 0 ? `${avgStars} ${avgRating.toFixed(2)}/5` : 'N/A', inline: true },
        { name: '📺 TV Rating', value: `${tvRating.toFixed(2)}/10.0 | ${grade}` },
        { name: '🏆 Top 3 Meilleurs Events', value: eventsText },
        { 
  name: '📊 Statistiques Events', 
  value: `📺 ${shows.length} shows | 🎭 ${ples.length} PLEs` 
},
        { name: '👑 Champions', value: championsText }
      )
      .setColor(federation.color)
      .setFooter({ text: `Propriétaire: ${message.author.username}` })
      .setTimestamp();

    if (federation.logoUrl && fs.existsSync(federation.logoUrl)) {
      embed.setThumbnail(`attachment://logo.png`);
      const attachment = new AttachmentBuilder(federation.logoUrl, { name: 'logo.png' });
      return message.reply({ embeds: [embed], files: [attachment] });
    }

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: POWER RANKING
  // ==========================================================================
  
if (command === 'power-ranking' || command === 'pr') {
  const period = args[0]?.toLowerCase() || '30';
  const eventType = args[1]?.toLowerCase(); // 'shows', 'ples', ou undefined (all)
  
  if (!['7', '30', 'all'].includes(period)) {
    return message.reply(
      'Usage: `!power-ranking [7|30|all] [shows|ples]`\n' +
      'Exemples:\n' +
      '• `!power-ranking 30` - Tous les events des 30 derniers jours\n' +
      '• `!power-ranking 7 shows` - Seulement les shows des 7 derniers jours\n' +
      '• `!power-ranking all ples` - Tous les PLEs depuis le début'
    );
  }

  let dateFilter = {};
  let periodText = '';

  if (period === '7') {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    dateFilter = { createdAt: { $gte: sevenDaysAgo } };
    periodText = '7 derniers jours';
  } else if (period === '30') {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    dateFilter = { createdAt: { $gte: thirtyDaysAgo } };
    periodText = '30 derniers jours';
  } else {
    periodText = 'Depuis le début';
  }

  let allEvents = [];

  // Charger les shows si demandé
  if (!eventType || eventType === 'shows') {
    const shows = await Show.find({
      guildId: message.guild.id,
      isFinalized: true,
      ...dateFilter
    });
    allEvents.push(...shows.map(s => ({
      name: `Show #${s.showNumber}`,
      federationName: s.federationName,
      userId: s.userId,
      rating: s.averageRating,
      createdAt: s.createdAt,
      type: 'show',
      votes: s.ratings?.length || 0
    })));
  }

  // Charger les PLEs si demandé
  if (!eventType || eventType === 'ples') {
    const ples = await PLE.find({
      guildId: message.guild.id,
      isFinalized: true,
      ...dateFilter
    });
    allEvents.push(...ples.map(p => ({
      name: p.pleName,
      federationName: p.federationName,
      userId: p.userId,
      rating: p.averageRating,
      createdAt: p.createdAt,
      type: 'ple',
      votes: p.ratings?.length || 0
    })));
  }

  // Trier par note décroissante
  allEvents.sort((a, b) => b.rating - a.rating);

  // Top 5 meilleurs events
  const topEvents = allEvents.slice(0, 5);
  const topEventsText = topEvents.length > 0
    ? topEvents.map((e, i) => {
        const stars = getStarDisplay(e.rating);
        const date = new Date(e.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
        const icon = e.type === 'ple' ? '🎭' : '📺';
        return `**${i + 1}.** ${icon} ${e.federationName} - ${e.name}\n${stars} ${e.rating.toFixed(2)}/5 (${date})`;
      }).join('\n\n')
    : 'Aucun event';

  // Top 3 fédérations (min 2 events)
  const fedStats = {};
  
  for (const event of allEvents) {
    if (!fedStats[event.federationName]) {
      fedStats[event.federationName] = {
        total: 0,
        count: 0,
        userId: event.userId,
        shows: 0,
        ples: 0
      };
    }
    fedStats[event.federationName].total += event.rating;
    fedStats[event.federationName].count += 1;
    if (event.type === 'show') {
      fedStats[event.federationName].shows += 1;
    } else {
      fedStats[event.federationName].ples += 1;
    }
  }

  const topFeds = Object.entries(fedStats)
    .filter(([_, stats]) => stats.count >= 2)
    .map(([name, stats]) => ({
      name,
      average: stats.total / stats.count,
      count: stats.count,
      shows: stats.shows,
      ples: stats.ples,
      userId: stats.userId
    }))
    .sort((a, b) => b.average - a.average)
    .slice(0, 3);

  const topFedsText = topFeds.length > 0
    ? topFeds.map((f, i) => {
        const stars = getStarDisplay(f.average);
        return `**${i + 1}.** ${f.name}\n${stars} ${f.average.toFixed(2)}/5 (${f.shows} shows, ${f.ples} PLEs)`;
      }).join('\n\n')
    : 'Aucune fédération (min 2 events)';

  // Stats globales
  const totalEvents = allEvents.length;
  const totalShows = allEvents.filter(e => e.type === 'show').length;
  const totalPLEs = allEvents.filter(e => e.type === 'ple').length;
  const uniqueFeds = new Set(allEvents.map(e => e.federationName)).size;

  const typeText = !eventType ? 'Tous les events' : eventType === 'shows' ? 'Shows uniquement' : 'PLEs uniquement';

  const embed = new EmbedBuilder()
    .setTitle('🏆 Power Rankings')
    .setDescription(`**Période:** ${periodText}\n**Type:** ${typeText}`)
    .addFields(
      { name: '📊 Stats Globales', value: `${totalEvents} events (${totalShows} shows, ${totalPLEs} PLEs) | ${uniqueFeds} fédérations actives` },
      { name: '⭐ Top 5 Meilleurs Events', value: topEventsText },
      { name: '🎖️ Top 3 Fédérations', value: topFedsText }
    )
    .setColor('#FFD700')
    .setFooter({ text: 'Utilisez !pr [7/30/all] [shows/ples]' })
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}

  // ============================================================================
// 1. POWER RANKING INDIVIDUEL DES LUTTEURS (TOP 5)
// À ajouter après la commande !power-ranking existante
// ============================================================================

// ============================================================================
// 1. POWER RANKING INDIVIDUEL DES LUTTEURS (TOP 5) - CORRIGÉ
// À ajouter après la commande !power-ranking existante
// ============================================================================

if (command === 'wrestler-ranking' || command === 'wr') {
  const period = args[0]?.toLowerCase() || 'all';
  
  if (!['7', '30', 'all'].includes(period)) {
    return message.reply('Usage: `!wrestler-ranking [7|30|all]`\nExemple: !wrestler-ranking 30');
  }

  let periodText = '';
  if (period === '7') {
    periodText = '7 derniers jours';
  } else if (period === '30') {
    periodText = '30 derniers jours';
  } else {
    periodText = 'Depuis le début';
  }

  // Récupérer tous les lutteurs avec au moins 1 match
  const wrestlers = await Wrestler.find({
    guildId: message.guild.id,
    $or: [
      { wins: { $gt: 0 } },
      { losses: { $gt: 0 } }
    ]
  });

  // Calculer le score de chaque lutteur en utilisant les vrais wins/losses
  const wrestlerStats = wrestlers.map(w => {
    // UTILISER DIRECTEMENT w.wins et w.losses (les vraies stats)
    const totalMatches = w.wins + w.losses;
    
    if (totalMatches === 0) return null;

    const winRate = (w.wins / totalMatches) * 100;
    
    // Score composite : (winRate * 0.7) + (totalMatches * 0.3)
    // Favorise les lutteurs avec bon winrate ET activité
    const score = (winRate * 0.7) + (Math.min(totalMatches, 20) * 1.5);

    return {
      name: w.name,
      wins: w.wins,
      losses: w.losses,
      totalMatches,
      winRate,
      score,
      federation: w.ownerFedName || 'Agent Libre',
      titleCount: w.titleHistory ? w.titleHistory.filter(t => !t.lostAt).length : 0
    };
  }).filter(Boolean);

  // Trier par score décroissant et prendre le top 5
  const topWrestlers = wrestlerStats
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (topWrestlers.length === 0) {
    return message.reply('❌ Aucun lutteur avec des matchs.');
  }

  const rankingText = topWrestlers.map((w, i) => {
    const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i];
    const titleIcon = w.titleCount > 0 ? ` 👑×${w.titleCount}` : '';
    return `${medal} **${w.name}**${titleIcon}\n📊 ${w.wins}-${w.losses} (${w.winRate.toFixed(1)}%) | 🏢 ${w.federation}\n⭐ Score: ${w.score.toFixed(1)}`;
  }).join('\n\n');

  const embed = new EmbedBuilder()
    .setTitle('🏆 Top 5 Lutteurs')
    .setDescription(`**Période:** ${periodText}\n\n${rankingText}`)
    .setColor('#F1C40F')
    .setFooter({ text: 'Score = (WinRate × 70%) + (Activité × 30%) • !wr 7/30/all' })
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}
  
  // ==========================================================================
  // COMMANDE: COMPARER LES SHOWS PAR NUMÉRO
  // ==========================================================================
  
  if (command === 'notes') {
    const showNumber = parseInt(args[0]);
    
    if (!showNumber || isNaN(showNumber)) {
      return message.reply('Usage: `!notes <numéro du show>`\nExemple: !notes 1');
    }

    const shows = await Show.find({
      guildId: message.guild.id,
      showNumber: showNumber,
      isFinalized: true
    }).sort({ averageRating: -1 });

    if (shows.length === 0) {
      return message.reply(`❌ Aucun show #${showNumber} finalisé trouvé.`);
    }

    const showsList = shows.map((s, i) => {
      const stars = getStarDisplay(s.averageRating);
      const date = new Date(s.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      return `**${i + 1}.** ${s.federationName}\n${stars} **${s.averageRating.toFixed(2)}/5** - ${date}`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
      .setTitle(`📊 Comparaison Show #${showNumber}`)
      .setDescription(`${shows.length} fédération(s) ont réalisé ce show`)
      .addFields({ name: '⭐ Classement par Note', value: showsList })
      .setColor('#E74C3C')
      .setFooter({ text: 'Classement par note moyenne décroissante' })
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: STATISTIQUES D'UN LUTTEUR
  // ==========================================================================
  
if (command === 'wrestler' || command === 'w') {
  const wrestlerName = args.join(' ');
  
  if (!wrestlerName) {
    return message.reply('Usage: `!wrestler Nom du Lutteur`\nExemple: !wrestler John Cena');
  }

  const wrestler = await Wrestler.findOne({
    name: new RegExp(`^${wrestlerName}$`, 'i'),
    guildId: message.guild.id
  });

  if (!wrestler) {
    return message.reply(`❌ ${wrestlerName} n'existe pas dans cette ligue.`);
  }

  // Fédération actuelle
  const federation = wrestler.isDrafted 
    ? await Federation.findOne({ userId: wrestler.ownerId, guildId: message.guild.id })
    : null;

  // Shows où il est présent
  const shows = federation 
    ? await Show.find({
        userId: federation.userId,
        guildId: message.guild.id,
        isFinalized: true
      }).sort({ createdAt: -1 })
    : [];

  const avgShowRating = shows.length > 0
    ? shows.reduce((sum, s) => sum + s.averageRating, 0) / shows.length
    : 0;

  // Titres gagnés
  const belts = await Belt.find({
    guildId: message.guild.id,
    'championshipHistory.champion': new RegExp(`^${wrestler.name}$`, 'i')
  });

  const titleReigns = [];
  belts.forEach(belt => {
    belt.championshipHistory.forEach(reign => {
      if (reign.champion.toLowerCase() === wrestler.name.toLowerCase()) {
        titleReigns.push({
          beltName: belt.beltName,
          wonAt: reign.wonAt,
          lostAt: reign.lostAt,
          defenses: reign.defenses,
          federationName: belt.federationName
        });
      }
    });
  });

  // Titre actuel
  const currentTitle = belts.find(b => 
    b.currentChampion && b.currentChampion.toLowerCase() === wrestler.name.toLowerCase()
  );

// Derniers matchs
  const recentMatches = wrestler.matchHistory && wrestler.matchHistory.length > 0
    ? wrestler.matchHistory
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 3)
        .map(match => {
          const icon = match.result === 'win' ? '✅' : '❌';
          return `${icon} vs **${match.opponent}**\n📺 ${match.federationName} - Show #${match.showNumber}`;
        }).join('\n\n')
    : 'Aucun match';

  // ⭐ HISTORIQUE DES FÉDÉRATIONS
  let federationHistoryText = '';
  if (wrestler.federationHistory && wrestler.federationHistory.length > 0) {
    const history = [...wrestler.federationHistory]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 5); // Max 5 derniers événements

    const actionEmojis = {
      'picked': '✅ Drafté',
      'released': '❌ Libéré',
      'traded_to': '🔄 Tradé vers',
      'traded_from': '🔄 Tradé depuis',
      'shared': '🔀 Partagé'
    };

    federationHistoryText = history.map(h => {
      const date = new Date(h.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
      const action = actionEmojis[h.action] || h.action;
      return `${action} **${h.federationName}** (${date})`;
    }).join('\n');
  } else {
    federationHistoryText = 'Aucun historique';
  }

  // Statut actuel
  const statusText = wrestler.isDrafted 
    ? `🏢 **${federation.name}**\n👤 Propriétaire: <@${wrestler.ownerId}>`
    : '🆓 Agent Libre';

  const showsText = shows.length > 0
    ? `${shows.length} show(s)\n⭐ Moyenne: ${getStarDisplay(avgShowRating)} ${avgShowRating.toFixed(2)}/5`
    : 'Aucun show';

  // Stats de combat
  const record = `${wrestler.wins}-${wrestler.losses}`;
  const totalMatches = wrestler.wins + wrestler.losses;
  const winRate = totalMatches > 0 
    ? ((wrestler.wins / totalMatches) * 100).toFixed(1)
    : 0;
  
  const combatStats = totalMatches > 0
    ? `**Record:** ${record}\n**Taux de victoire:** ${winRate}%\n**Total matchs:** ${totalMatches}`
    : 'Aucun match enregistré';

  const titlesText = titleReigns.length > 0
    ? titleReigns.map(reign => {
        const wonDate = new Date(reign.wonAt).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
        const current = !reign.lostAt ? ' 👑' : '';
        const defenses = reign.defenses > 0 ? ` (${reign.defenses} défense${reign.defenses > 1 ? 's' : ''})` : '';
        return `🏆 **${reign.beltName}**${current}\n${reign.federationName} - ${wonDate}${defenses}`;
      }).join('\n\n')
    : 'Aucun titre remporté';

  const signedDate = wrestler.isDrafted && federation
    ? federation.roster.find(w => w.wrestlerName.toLowerCase() === wrestler.name.toLowerCase())
    : null;
  
  const signedText = signedDate 
    ? new Date(signedDate.signedDate).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
    : 'N/A';

  const embedColor = wrestler.isDrafted && federation ? federation.color : '#95A5A6';

  const embed = new EmbedBuilder()
    .setTitle(`🤼 ${wrestler.name}`)
    .setDescription(wrestler.isShared ? '🔀 Lutteur Partagé' : statusText)
    .addFields(
      { name: '📊 Statut', value: statusText },
      { name: '📜 Historique des Fédérations', value: federationHistoryText },
      { name: '⚔️ Record de Combat', value: combatStats },
      { name: '📋 Derniers Matchs', value: recentMatches },
      { name: '📺 Statistiques Shows', value: showsText, inline: true },
      { name: '🏆 Palmarès', value: `${titleReigns.length} titre(s)`, inline: true },
      { name: '📅 Drafté le', value: wrestler.isDrafted ? signedText : 'Jamais drafté', inline: true },
      { name: '👑 Championnats', value: titlesText }
    )
    .setColor(embedColor)
    .setFooter({ text: currentTitle ? `Champion actuel: ${currentTitle.beltName}` : 'Aucun titre actuellement' })
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}

  if (command === 'tvratings' || command === 'ratings') {
  const loadingMsg = await message.reply('📊 Calcul des TV Ratings en cours...');

  try {
    // Récupérer toutes les fédérations du serveur
    const federations = await Federation.find({ guildId: message.guild.id });

    if (federations.length === 0) {
      return loadingMsg.edit('❌ Aucune fédération sur ce serveur.');
    }

    // Calculer le rating de chaque fédération
    const ratingsData = await Promise.all(
      federations.map(async (fed) => {
        const rating = await calculateTVRating(fed.userId, fed.guildId);
        return {
          name: fed.name,
          userId: fed.userId,
          rating,
          color: fed.color
        };
      })
    );

    // Trier par rating décroissant
    const sorted = ratingsData.sort((a, b) => b.rating - a.rating);

    // Top 5 (ou moins si moins de fédérations)
    const topFeds = sorted.slice(0, Math.min(5, sorted.length));

    const rankingText = topFeds.map((fed, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      const grade = getTVRatingGrade(fed.rating);
      const trend = i === 0 ? '👑' : '';
      
      return `${medal} **${fed.name}** ${trend}\n📺 ${fed.rating.toFixed(2)}/10.0 | ${grade}`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
      .setTitle('📺 TV RATINGS')
      .setDescription(rankingText)
      .setColor(topFeds[0].color)
      .setFooter({ text: 'Le rating est un mystère... Bookez bien pour grimper ! 🎯' })
      .setTimestamp();

    await loadingMsg.edit({ content: null, embeds: [embed] });

  } catch (error) {
    console.error('Erreur calcul TV ratings:', error);
    await loadingMsg.edit('❌ Erreur lors du calcul des ratings.');
  }
}

  // ==========================================================================
// COMMANDE: DÉBLOQUER UN LUTTEUR (LE RENDRE PARTAGÉ)
// ==========================================================================

if (command === 'unlock') {
  const wrestlerName = args.join(' ');
  
  if (!wrestlerName) {
    return message.reply('Usage: `!unlock Nom du Lutteur`');
  }

  const federation = await Federation.findOne({
    userId: message.author.id,
    guildId: message.guild.id
  });

  if (!federation) {
    return message.reply('❌ Tu n\'as pas de fédération.');
  }

  const inRoster = federation.roster.find(w => 
    w.wrestlerName.toLowerCase() === wrestlerName.toLowerCase()
  );

  if (!inRoster) {
    return message.reply(`❌ ${wrestlerName} n'est pas dans ton roster.`);
  }

  const wrestler = await Wrestler.findOne({
    name: new RegExp(`^${wrestlerName}$`, 'i'),
    guildId: message.guild.id
  });

  if (!wrestler) {
    return message.reply(`❌ Lutteur introuvable dans la base de données.`);
  }

  if (wrestler.isShared) {
    return message.reply(`⚠️ ${wrestler.name} est déjà partagé.`);
  }

  wrestler.isShared = true;
  await wrestler.save();

  const embed = new EmbedBuilder()
    .setTitle('🔓 Lutteur Débloqué !')
    .setDescription(`**${wrestler.name}** peut maintenant être drafté par d'autres fédérations`)
    .addFields(
      { name: 'Fédération d\'origine', value: federation.name },
      { name: 'Statut', value: '🔀 Partagé' }
    )
    .setColor(federation.color)
    .setFooter({ text: 'Le lutteur reste dans ton roster' });

  return message.reply({ embeds: [embed] });
}

  // ============================================================================
// COMMANDE: SYNCHRONISER LA WIKIPEDIA (à ajouter AVANT !wikipedia)
// Cette commande scanne tous les rosters et ajoute les lutteurs à la wikipedia
// ============================================================================

if (command === 'syncwiki' || command === 'syncwikipedia') {
  if (!message.member.permissions.has('Administrator')) {
    return message.reply('❌ Commande réservée aux administrateurs.');
  }

  const syncMsg = await message.reply('⏳ Synchronisation de la Wikipedia en cours...');

  try {
    // Récupérer toutes les fédérations du serveur
    const federations = await Federation.find({
      guildId: message.guild.id
    });

    let totalSynced = 0;
    let alreadyUpToDate = 0;
    const syncDetails = [];

    for (const federation of federations) {
      if (!federation.roster || federation.roster.length === 0) continue;

      for (const rosterEntry of federation.roster) {
        // Trouver ou créer le lutteur
        let wrestler = await Wrestler.findOne({
          name: new RegExp(`^${rosterEntry.wrestlerName}$`, 'i'),
          guildId: message.guild.id
        });

        if (!wrestler) {
          // Créer le lutteur s'il n'existe pas
          wrestler = new Wrestler({
            name: rosterEntry.wrestlerName,
            guildId: message.guild.id,
            isDrafted: true,
            ownerId: federation.userId,
            ownerFedName: federation.name,
            federationHistory: [{
              federationName: federation.name,
              userId: federation.userId,
              action: 'picked',
              date: rosterEntry.signedDate || new Date()
            }]
          });
          await wrestler.save();
          totalSynced++;
          syncDetails.push(`✅ Créé: **${wrestler.name}** → ${federation.name}`);
          continue;
        }

        // Vérifier si le lutteur a déjà un historique
        if (!wrestler.federationHistory) {
          wrestler.federationHistory = [];
        }

        // Vérifier si cette fédération est déjà dans l'historique
        const alreadyInHistory = wrestler.federationHistory.some(h => 
          h.federationName === federation.name && 
          h.userId === federation.userId &&
          h.action === 'picked'
        );

        if (!alreadyInHistory) {
          // Ajouter l'entrée dans l'historique
          wrestler.federationHistory.push({
            federationName: federation.name,
            userId: federation.userId,
            action: 'picked',
            date: rosterEntry.signedDate || new Date()
          });

          // Mettre à jour les infos si nécessaire
          if (!wrestler.isDrafted || wrestler.ownerId !== federation.userId) {
            wrestler.isDrafted = true;
            wrestler.ownerId = federation.userId;
            wrestler.ownerFedName = federation.name;
          }

          await wrestler.save();
          totalSynced++;
          syncDetails.push(`🔄 Synchronisé: **${wrestler.name}** → ${federation.name}`);
        } else {
          alreadyUpToDate++;
        }
      }
    }

    // Préparer le rapport
    const reportEmbed = new EmbedBuilder()
      .setTitle('✅ Synchronisation Wikipedia Terminée !')
      .addFields(
        { name: '📊 Statistiques', value: `**${totalSynced}** lutteur(s) synchronisé(s)\n**${alreadyUpToDate}** déjà à jour\n**${federations.length}** fédération(s) scannée(s)` }
      )
      .setColor('#2ECC71')
      .setTimestamp();

    // Ajouter les détails si pas trop long
    if (syncDetails.length > 0 && syncDetails.length <= 10) {
      reportEmbed.addFields({
        name: '📝 Détails',
        value: syncDetails.join('\n')
      });
    } else if (syncDetails.length > 10) {
      reportEmbed.addFields({
        name: '📝 Aperçu',
        value: syncDetails.slice(0, 10).join('\n') + `\n... et ${syncDetails.length - 10} autre(s)`
      });
    }

    reportEmbed.setFooter({ text: 'Utilisez !wikipedia pour voir tous les lutteurs' });

    await syncMsg.edit({ content: null, embeds: [reportEmbed] });

  } catch (error) {
    console.error('Erreur synchronisation wiki:', error);
    await syncMsg.edit('❌ Erreur lors de la synchronisation. Vérifiez les logs.');
  }
}


// ============================================================================
// MODIFICATION DE !wikipedia POUR INCLURE TOUS LES LUTTEURS
// REMPLACE ta commande !wikipedia actuelle par celle-ci
// ============================================================================

if (command === 'wikipedia' || command === 'wiki') {
  // Récupérer TOUS les lutteurs qui ont été draftés OU qui sont dans un roster
  const allWrestlers = await Wrestler.find({
    guildId: message.guild.id,
    $or: [
      { federationHistory: { $exists: true, $ne: [] } },
      { isDrafted: true }
    ]
  }).sort({ name: 1 }); // Tri alphabétique

  if (allWrestlers.length === 0) {
    return message.reply('📚 La Wikipedia est vide. Aucun lutteur n\'a encore été drafté.\n💡 Utilisez `!syncwiki` pour synchroniser les lutteurs existants.');
  }

  const itemsPerPage = 7;
  const totalPages = Math.ceil(allWrestlers.length / itemsPerPage);
  let currentPage = 0;

  const generateEmbed = async (page) => {
    const start = page * itemsPerPage;
    const end = start + itemsPerPage;
    const pageWrestlers = allWrestlers.slice(start, end);

    const wrestlersList = await Promise.all(
      pageWrestlers.map(async (w, i) => {
        const record = `${w.wins}-${w.losses}`;
        
        let statusText;
        if (w.isDrafted && w.ownerFedName) {
          if (w.isShared) {
            const sharedCount = w.sharedWith ? w.sharedWith.length : 0;
            statusText = `🔀 Partagé (${w.ownerFedName} + ${sharedCount} autre${sharedCount > 1 ? 's' : ''})`;
          } else {
            statusText = `🏢 ${w.ownerFedName}`;
          }
        } else {
          statusText = '🆓 Agent Libre';
        }

        // Ajouter une icône si le lutteur a des titres
        const hasTitles = w.titleHistory && w.titleHistory.some(t => !t.lostAt);
        const titleIcon = hasTitles ? ' 👑' : '';

        return `**${start + i + 1}.** ${w.name}${titleIcon}\n📊 Record: ${record} | ${statusText}`;
      })
    );

    const embed = new EmbedBuilder()
      .setTitle('📚 Wikipedia des Lutteurs')
      .setDescription(wrestlersList.join('\n\n'))
      .addFields(
        { name: 'Total', value: `${allWrestlers.length} lutteur${allWrestlers.length > 1 ? 's' : ''} répertorié${allWrestlers.length > 1 ? 's' : ''}` }
      )
      .setColor('#F39C12')
      .setFooter({ text: `Page ${page + 1}/${totalPages} • Utilisez !wrestler <nom> pour plus de détails` });

    return embed;
  };

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('previous')
        .setLabel('◀️ Précédent')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId('next')
        .setLabel('Suivant ▶️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(totalPages <= 1)
    );

  const embedMessage = await message.reply({
    embeds: [await generateEmbed(currentPage)],
    components: totalPages > 1 ? [row] : []
  });

  if (totalPages <= 1) return;

  const collector = embedMessage.createMessageComponentCollector({
    time: 120000
  });

  collector.on('collect', async interaction => {
    if (interaction.user.id !== message.author.id) {
      return interaction.reply({ content: 'Ce n\'est pas ta Wikipedia !', ephemeral: true });
    }

    if (interaction.customId === 'previous') {
      currentPage = Math.max(0, currentPage - 1);
    } else if (interaction.customId === 'next') {
      currentPage = Math.min(totalPages - 1, currentPage + 1);
    }

    const updatedRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('previous')
          .setLabel('◀️ Précédent')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(currentPage === 0),
        new ButtonBuilder()
          .setCustomId('next')
          .setLabel('Suivant ▶️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(currentPage === totalPages - 1)
      );

    await interaction.update({
      embeds: [await generateEmbed(currentPage)],
      components: [updatedRow]
    });
  });

  collector.on('end', () => {
    embedMessage.edit({ components: [] }).catch(() => {});
  });
}

// ============================================================================
// 6. NOUVELLE COMMANDE !delwikipedia (à ajouter APRÈS !wikipedia)
// ============================================================================

if (command === 'delwikipedia' || command === 'delwiki') {
  if (!message.member.permissions.has('Administrator')) {
    return message.reply('❌ Commande réservée aux administrateurs.');
  }

  const wrestlerName = args.join(' ');
  
  if (!wrestlerName) {
    return message.reply('Usage: `!delwikipedia Nom du Lutteur`\nExemple: !delwikipedia Test Wrestler');
  }

  const wrestler = await Wrestler.findOne({
    name: new RegExp(`^${wrestlerName}$`, 'i'),
    guildId: message.guild.id
  });

  if (!wrestler) {
    return message.reply(`❌ ${wrestlerName} n'existe pas dans la base de données.`);
  }

  // Vérifier s'il est encore drafté quelque part
  if (wrestler.isDrafted) {
    return message.reply(`❌ ${wrestler.name} est actuellement dans le roster de **${wrestler.ownerFedName}**. Utilise \`!delpick\` d'abord.`);
  }

  // Supprimer de la base de données
  await Wrestler.deleteOne({ _id: wrestler._id });

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Lutteur Supprimé de la Wikipedia')
    .setDescription(`**${wrestler.name}** a été définitivement supprimé`)
    .addFields(
      { name: 'Record Final', value: `${wrestler.wins}-${wrestler.losses}` },
      { name: 'Titres Remportés', value: `${wrestler.titleHistory?.length || 0}` },
      { name: 'Matchs Total', value: `${wrestler.matchHistory?.length || 0}` }
    )
    .setColor('#E74C3C')
    .setFooter({ text: 'Cette action est irréversible' });

  return message.reply({ embeds: [embed] });
}
  
// ==========================================================================
  // COMMANDE: AIDE
  // ==========================================================================
  
if (command === 'help2') {
  const embed = new EmbedBuilder()
    .setTitle('📖 Commandes Fantasy Booking')
    .setDescription('Liste complète des commandes disponibles')
    .addFields(
      { 
        name: '🏢 Gestion Fédération', 
        value: '`!createfed [nom]` - Créer une fédération\n`!editfed [nouveau nom]` - Renommer\n`!setcolor [numéro/hexa]` - Changer couleur\n`!setlogo [fédération]` + image - Définir logo (Admin)\n`!fed` - Voir stats\n`!resetfed [@user]` - Supprimer fédération (Admin)' 
      },
      { 
        name: '🤼 Roster & Lutteurs', 
        value: '`!roster` - Voir ton roster\n`!pick [nom]` - Drafter un lutteur\n`!delpick [nom]` - Retirer du roster\n`!unlock [nom]` - Débloquer (partageable)\n`!trade @user [lutteur1] pour [lutteur2]` - Échanger\n`!wrestler [nom]` ou `!w` - Stats détaillées\n`!wikipedia` ou `!wiki` - Liste tous les lutteurs\n`!delwikipedia [nom]` - Supprimer un lutteur (Admin)' 
      },
      { 
        name: '⚔️ Statistiques Combat', 
        value: '`!addwin [nom]` - Ajouter victoire\n`!addloss [nom]` - Ajouter défaite\n`!delwin [nom]` - Retirer victoire\n`!delloss [nom]` - Retirer défaite\n`!match [lutteur1] vs [lutteur2]` - Enregistrer match\n`!matchs [nom]` - Historique matchs' 
      },
      { 
        name: '📺 Shows', 
        value: '`!showend` - Terminer un show\n`!finalize [numéro]` - Finaliser votes\n`!notes [numéro]` - Comparer shows par numéro' 
      },
      { 
        name: '👑 Championnats', 
        value: '`!createbelt [nom]` - Créer un titre\n`!setchamp "[titre]" [lutteur]` - Définir champion\n`!defense [lutteur]` - Ajouter défense\n`!titlehistory [titre]` ou `!th` - Historique\n`!vacate [titre]` - Libérer le titre\n`!delbelt [titre]` - Supprimer titre\n`!setbeltlogo [titre]` + image - Logo du titre' 
      },
      { 
        name: '📊 Classements', 
        value: '`!power-ranking [7|30|all]` ou `!pr` - Power rankings' 
      },
      { 
        name: '⚙️ Admin', 
        value: '`!resetpr` - Reset power rankings (Admin)' 
      }
    )
    .setColor('#3498DB')
    .setFooter({ text: 'Utilisez les commandes sans [] • Exemples: !pick John Cena, !match John Cena vs Randy Orton' });

  return message.reply({ embeds: [embed] });
}
});

// ============================================================================
// SERVEUR HTTP POUR RENDER
// ============================================================================

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot Discord Fantasy Booking actif');
}).listen(PORT, () => {
  console.log(`🌐 Serveur HTTP sur le port ${PORT}`);
  keepAlive();
});

// Login Discord avec gestion d'erreur améliorée
console.log('🔐 Tentative de connexion à Discord...');
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN non défini dans les variables d\'environnement !');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('✅ Requête de login envoyée à Discord'))
  .catch(err => {
    console.error('❌ ERREUR CRITIQUE lors du login Discord:');
    console.error('Message:', err.message);
    console.error('Code:', err.code);
    console.error('\nVérifiez:');
    console.error('1. Que votre DISCORD_TOKEN est valide');
    console.error('2. Que les intents sont activés dans le Discord Developer Portal');
    console.error('3. Que le bot n\'a pas été supprimé');
    process.exit(1);
  });
