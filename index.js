require('dotenv').config({
  path: require('path').join(__dirname, '.env')
});
console.log('ENV CHECK:', {
  TOKEN: process.env.DISCORD_TOKEN,
  MONGO: process.env.MONGO_URI
});

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const https = require('https');
const fs = require('fs');

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
  }, 5 * 60 * 1000); // Toutes les 5 minutes
}

// ============================================================================
// SCHÉMAS MONGOOSE
// ============================================================================

// Schéma Lutteur (catalogue global)
const wrestlerSchema = new mongoose.Schema({
  name: String,
  salaryPerShow: Number,
  salaryMonthly: Number,
  isDrafted: { type: Boolean, default: false },
  ownerId: { type: String, default: null },
  contractType: { type: String, default: null }
});

const Wrestler = mongoose.model('Wrestler', wrestlerSchema);

// Schéma Fédération
const federationSchema = new mongoose.Schema({
  userId: String,
  guildId: String,
  name: String,
  class: { type: String, enum: ['major', 'challenger', 'indy'] },
  balance: Number,
  roster: [{ 
    wrestlerId: mongoose.Schema.Types.ObjectId,
    wrestlerName: String,
    salary: Number,
    contractType: String,
    contractEndDate: Date,
    signedDate: { type: Date, default: Date.now }
  }],
  pendingEarnings: { type: Number, default: 0 },
  production: { type: Number, default: 1, min: 1, max: 5 },
  marketing: { type: Number, default: 1, min: 1, max: 5 },
  facilities: { type: Number, default: 1, min: 1, max: 5 },
  createdAt: { type: Date, default: Date.now }
});

const Federation = mongoose.model('Federation', federationSchema);

// Schéma Show
const showSchema = new mongoose.Schema({
  showNumber: Number,
  userId: String,
  guildId: String,
  federationName: String,
  messageId: String,
  ratings: [{ userId: String, stars: Number }],
  averageRating: { type: Number, default: 0 },
  earnings: { type: Number, default: 0 },
  showCost: { type: Number, default: 0 },
  isFinalized: { type: Boolean, default: false },
  isPaid: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Show = mongoose.model('Show', showSchema);

// ============================================================================
// CONFIGURATION DES CLASSES DE FÉDÉRATION
// ============================================================================

const CLASS_CONFIG = {
  major: {
    name: 'Major (Le Géant Mondial)',
    startingBalance: 500000,
    contractBonus: { monthly: 0.9, pershow: 1 },
    earningsMultiplier: 1.5
  },
  challenger: {
    name: 'Challenger (L\'Intermédiaire)',
    startingBalance: 250000,
    contractBonus: { pershow: 0.95, monthly: 1 },
    earningsMultiplier: 1.2
  },
  indy: {
    name: 'Indy (La Scène Locale / Culte)',
    startingBalance: 100000,
    contractBonus: { pershow: 0.85, monthly: 0.95 },
    earningsMultiplier: 1.0
  }
};

// ============================================================================
// CONFIGURATION DES FRAIS FIXES
// ============================================================================

const FIXED_COSTS = {
  production: {
    1: { monthly: 5000, perShow: 2000, bonus: 0 },
    2: { monthly: 10000, perShow: 4000, bonus: 0.05 },
    3: { monthly: 20000, perShow: 8000, bonus: 0.10 },
    4: { monthly: 35000, perShow: 14000, bonus: 0.15 },
    5: { monthly: 50000, perShow: 20000, bonus: 0.25 }
  },
  marketing: {
    1: { monthly: 3000, perShow: 1500, bonus: 0 },
    2: { monthly: 8000, perShow: 3500, bonus: 0.05 },
    3: { monthly: 15000, perShow: 7000, bonus: 0.10 },
    4: { monthly: 25000, perShow: 12000, bonus: 0.15 },
    5: { monthly: 40000, perShow: 18000, bonus: 0.20 }
  },
  facilities: {
    1: { monthly: 4000, perShow: 1000, bonus: 0 },
    2: { monthly: 9000, perShow: 2500, bonus: 0.03 },
    3: { monthly: 18000, perShow: 5000, bonus: 0.07 },
    4: { monthly: 30000, perShow: 10000, bonus: 0.12 },
    5: { monthly: 45000, perShow: 15000, bonus: 0.18 }
  }
};

// ============================================================================
// CONFIGURATION DES ÉTOILES
// ============================================================================

const STAR_VALUES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
const EMOJI_NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// ============================================================================
// FONCTIONS UTILITAIRES
// ============================================================================

// Calculer les gains selon la note
function calculateEarnings(rating) {
  if (rating < 1) return 0;
  if (rating < 2) return 5000;
  if (rating < 3) return 15000;
  if (rating < 4) return 30000;
  if (rating < 4.5) return 50000;
  return 75000;
}

// Calculer le bonus total de note
function calculateRatingBonus(production, marketing, facilities) {
  const prodBonus = FIXED_COSTS.production[production].bonus;
  const markBonus = FIXED_COSTS.marketing[marketing].bonus;
  const facBonus = FIXED_COSTS.facilities[facilities].bonus;
  return prodBonus + markBonus + facBonus;
}

// Calculer la similarité entre deux chaînes (Levenshtein)
function calculateSimilarity(str1, str2) {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  if (s1 === s2) return 100;
  if (s1.includes(s2) || s2.includes(s1)) return 90;
  
  const matrix = [];
  for (let i = 0; i <= s1.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= s2.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      if (s1.charAt(i - 1) === s2.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  const distance = matrix[s1.length][s2.length];
  const maxLength = Math.max(s1.length, s2.length);
  return Math.round((1 - distance / maxLength) * 100);
}

// Trouver les meilleurs matchs de lutteurs
async function findWrestlerMatches(searchTerm, limit = 5) {
  const allWrestlers = await Wrestler.find({ isDrafted: false });
  
  const matches = allWrestlers.map(w => ({
    wrestler: w,
    similarity: calculateSimilarity(searchTerm, w.name)
  }))
  .filter(m => m.similarity >= 60)
  .sort((a, b) => b.similarity - a.similarity)
  .slice(0, limit);
  
  return matches;
}

// Charger les lutteurs depuis wrestlers.json
async function loadWrestlers() {
  try {
    const data = fs.readFileSync('./wrestlers.json', 'utf8');
    const wrestlers = JSON.parse(data);
    
    for (const w of wrestlers) {
      const existing = await Wrestler.findOne({ name: w.name });
      if (!existing) {
        await Wrestler.create({
          name: w.name,
          salaryPerShow: w.salaryPerShow,
          salaryMonthly: w.salaryMonthly
        });
      }
    }
    console.log(`✅ ${wrestlers.length} lutteurs chargés`);
  } catch (err) {
    console.log('⚠️ Fichier wrestlers.json non trouvé:', err.message);
  }
}

// ============================================================================
// ÉVÉNEMENT: BOT PRÊT
// ============================================================================

client.on('ready', async () => {
  console.log(`🤼 Bot Fantasy Booking connecté : ${client.user.tag}`);
  await loadWrestlers();
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
    const classType = args[0]?.toLowerCase();
    const name = args.slice(1).join(' ');
    
    if (!classType || !['major', 'challenger', 'indy'].includes(classType) || !name) {
      const embed = new EmbedBuilder()
        .setTitle('❌ Usage Incorrect')
        .setDescription('`!createfed <classe> <nom>`')
        .addFields(
          { name: '🏆 Major', value: 'Budget: $500,000 | -10% contrats mensuels | +50% gains' },
          { name: '⚔️ Challenger', value: 'Budget: $250,000 | -5% contrats per show | +20% gains' },
          { name: '🎸 Indy', value: 'Budget: $100,000 | -15% pershow, -5% monthly' }
        )
        .setColor('#E74C3C')
        .setFooter({ text: 'Exemple: !createfed indy Ma Petite Fed' });
      return message.reply({ embeds: [embed] });
    }

    const existing = await Federation.findOne({ 
      userId: message.author.id, 
      guildId: message.guild.id 
    });

    if (existing) {
      return message.reply('Tu as déjà une fédération !');
    }

    const config = CLASS_CONFIG[classType];

    const federation = new Federation({
      userId: message.author.id,
      guildId: message.guild.id,
      name,
      class: classType,
      balance: config.startingBalance
    });

    await federation.save();

    const embed = new EmbedBuilder()
      .setTitle('🏆 Fédération Créée !')
      .setDescription(`**${name}**`)
      .addFields(
        { name: 'Classe', value: config.name },
        { name: 'Budget Initial', value: `$${config.startingBalance.toLocaleString()}`, inline: true },
        { name: 'Roster', value: '0 lutteurs', inline: true },
        { name: 'Frais Fixes', value: 'Production Lvl 1\nMarketing Lvl 1\nInstallations Lvl 1' }
      )
      .setColor('#FFD700');

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: DRAFTER UN LUTTEUR
  // ==========================================================================
  
  if (command === 'pick') {
    const contractType = args[0]?.toLowerCase();
    const wrestlerName = args.slice(1).join(' ');

    if (!contractType || !wrestlerName || !['pershow', 'monthly'].includes(contractType)) {
      return message.reply('Usage: `!pick pershow Nom du Lutteur` ou `!pick monthly Nom du Lutteur`');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('Tu dois d\'abord créer ta fédération avec `!createfed`');
    }

    // Recherche exacte
    let wrestler = await Wrestler.findOne({ 
      name: new RegExp(`^${wrestlerName}$`, 'i'),
      isDrafted: false 
    });

    // Si pas de match exact, recherche par similarité
    if (!wrestler) {
      const matches = await findWrestlerMatches(wrestlerName, 5);
      
      if (matches.length === 0) {
        return message.reply('❌ Aucun lutteur trouvé avec ce nom.');
      }

      if (matches.length === 1 && matches[0].similarity >= 85) {
        wrestler = matches[0].wrestler;
        message.channel.send(`✅ Lutteur trouvé: **${wrestler.name}** (similarité: ${matches[0].similarity}%)`);
      } else {
        const suggestions = matches.map((m, i) => 
          `**${i + 1}.** ${m.wrestler.name} (${m.similarity}% match)\n` +
          `   📺 $${m.wrestler.salaryPerShow.toLocaleString()} | 📅 $${m.wrestler.salaryMonthly.toLocaleString()}`
        ).join('\n');

        const embed = new EmbedBuilder()
          .setTitle('🔍 Plusieurs lutteurs correspondent')
          .setDescription(`Voici les résultats pour "${wrestlerName}":\n\n${suggestions}`)
          .setFooter({ text: 'Réessaye avec le nom exact du lutteur que tu veux.' })
          .setColor('#F39C12');

        return message.reply({ embeds: [embed] });
      }
    }

    // Appliquer les bonus de classe
    const classConfig = CLASS_CONFIG[federation.class];
    let salary = contractType === 'pershow' ? wrestler.salaryPerShow : wrestler.salaryMonthly;
    const originalSalary = salary;
    
    if (contractType === 'pershow' && classConfig.contractBonus.pershow !== 1) {
      salary = Math.floor(salary * classConfig.contractBonus.pershow);
    } else if (contractType === 'monthly' && classConfig.contractBonus.monthly !== 1) {
      salary = Math.floor(salary * classConfig.contractBonus.monthly);
    }

    if (federation.balance < salary && contractType === 'monthly') {
      return message.reply(`Budget insuffisant ! Il te reste $${federation.balance.toLocaleString()} mais ${wrestler.name} (monthly) coûte $${salary.toLocaleString()}`);
    }

    // Calculer la date de fin de contrat (12 jours pour monthly)
    const contractEndDate = contractType === 'monthly' 
      ? new Date(Date.now() + 12 * 24 * 60 * 60 * 1000)
      : null;

    // Ajouter au roster
    federation.roster.push({
      wrestlerId: wrestler._id,
      wrestlerName: wrestler.name,
      salary: salary,
      contractType: contractType,
      contractEndDate: contractEndDate
    });

    await federation.save();

    // Marquer comme drafté si contrat monthly
    if (contractType === 'monthly') {
      wrestler.isDrafted = true;
      wrestler.ownerId = message.author.id;
      wrestler.contractType = 'monthly';
      await wrestler.save();
    }

    const contractText = contractType === 'monthly' 
      ? `📅 Written Mensuel (Exclusif)\n⏰ Expire le: ${contractEndDate.toLocaleDateString('fr-FR')}` 
      : '📺 Per Show';
    const bonusText = salary !== originalSalary 
      ? `\n✨ Bonus de classe appliqué !` : '';
    
    const embed = new EmbedBuilder()
      .setTitle('✅ Lutteur Signé !')
      .addFields(
        { name: 'Lutteur', value: wrestler.name, inline: true },
        { name: 'Salaire', value: `$${salary.toLocaleString()}${bonusText}`, inline: true },
        { name: 'Contrat', value: contractText },
        { name: 'Budget Actuel', value: `$${federation.balance.toLocaleString()}` }
      )
      .setColor('#2ECC71');

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

    const now = new Date();
    const rosterText = federation.roster.map((w, i) => {
      const contractIcon = w.contractType === 'monthly' ? '📅' : '📺';
      let contractInfo = `$${w.salary.toLocaleString()} ${contractIcon}`;
      
      if (w.contractType === 'monthly' && w.contractEndDate) {
        const daysLeft = Math.ceil((new Date(w.contractEndDate) - now) / (1000 * 60 * 60 * 24));
        const status = daysLeft > 3 ? '🟢' : daysLeft > 1 ? '🟡' : '🔴';
        contractInfo += ` ${status} ${daysLeft}j restants`;
      }
      
      return `**${i + 1}.** ${w.wrestlerName} - ${contractInfo}`;
    }).join('\n');

    const monthlyCost = federation.roster
      .filter(w => w.contractType === 'monthly')
      .reduce((sum, w) => sum + w.salary, 0);

    const prodCost = FIXED_COSTS.production[federation.production].monthly;
    const markCost = FIXED_COSTS.marketing[federation.marketing].monthly;
    const facCost = FIXED_COSTS.facilities[federation.facilities].monthly;
    const totalFixedCost = prodCost + markCost + facCost;

    const embed = new EmbedBuilder()
      .setTitle(`🤼 Roster - ${federation.name}`)
      .setDescription(rosterText)
      .addFields(
        { name: 'Budget', value: `$${federation.balance.toLocaleString()}`, inline: true },
        { name: 'Salaires Mensuels', value: `$${monthlyCost.toLocaleString()}`, inline: true },
        { name: 'Frais Fixes/Mois', value: `$${totalFixedCost.toLocaleString()}`, inline: true },
        { name: 'Gains en Attente', value: `$${federation.pendingEarnings.toLocaleString()}` }
      )
      .setColor('#3498DB')
      .setFooter({ text: `${federation.roster.length} lutteurs | 🟢 >3j | 🟡 1-3j | 🔴 <1j` });

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: ANNONCER LA FIN D'UN SHOW
  // ==========================================================================
  
  if (command === 'showend') {
    const showNumber = parseInt(args[0]);

    if (!showNumber) {
      return message.reply('Usage: `!showend 1`');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('Tu n\'as pas de fédération.');
    }

    // Calculer le coût des contrats pershow
    const wrestlerCost = federation.roster
      .filter(w => w.contractType === 'pershow')
      .reduce((sum, w) => sum + w.salary, 0);

    // Calculer les frais fixes per show
    const prodCost = FIXED_COSTS.production[federation.production].perShow;
    const markCost = FIXED_COSTS.marketing[federation.marketing].perShow;
    const facCost = FIXED_COSTS.facilities[federation.facilities].perShow;
    const fixedCost = prodCost + markCost + facCost;

    const totalShowCost = wrestlerCost + fixedCost;

    if (federation.balance < totalShowCost) {
      return message.reply(
        `❌ Budget insuffisant !\n` +
        `Coût du show: $${totalShowCost.toLocaleString()}\n` +
        `- Lutteurs (pershow): $${wrestlerCost.toLocaleString()}\n` +
        `- Frais fixes: $${fixedCost.toLocaleString()}\n` +
        `Budget actuel: $${federation.balance.toLocaleString()}`
      );
    }

    // Déduire le coût
    federation.balance -= totalShowCost;
    await federation.save();

    const show = new Show({
      showNumber,
      userId: message.author.id,
      guildId: message.guild.id,
      federationName: federation.name,
      showCost: totalShowCost
    });

    await show.save();

    const embed = new EmbedBuilder()
      .setTitle(`🎬 Fin du Show #${showNumber}`)
      .setDescription(`**${federation.name}**\n\nRéagissez avec des étoiles pour noter le show !`)
      .addFields(
        { name: 'Lutteurs (Per Show)', value: `$${wrestlerCost.toLocaleString()}`, inline: true },
        { name: 'Frais Fixes', value: `$${fixedCost.toLocaleString()}`, inline: true },
        { name: 'Coût Total', value: `💸 $${totalShowCost.toLocaleString()}` },
        { name: 'Budget Restant', value: `$${federation.balance.toLocaleString()}`, inline: true },
        { name: 'Statut', value: '⏳ En attente des votes...', inline: true }
      )
      .setColor('#E67E22');

    const msg = await message.reply({ embeds: [embed] });
    
    show.messageId = msg.id;
    await show.save();

    for (let i = 0; i < 10; i++) {
      await msg.react(EMOJI_NUMBERS[i]);
    }

    return message.channel.send('**Légende:** 1️⃣=0.5⭐ | 2️⃣=1⭐ | 3️⃣=1.5⭐ | 4️⃣=2⭐ | 5️⃣=2.5⭐ | 6️⃣=3⭐ | 7️⃣=3.5⭐ | 8️⃣=4⭐ | 9️⃣=4.5⭐ | 🔟=5⭐');
  }

  // ==========================================================================
  // COMMANDE: FINALISER LES VOTES D'UN SHOW
  // ==========================================================================
  
  if (command === 'finalize') {
    const showNumber = parseInt(args[0]);

    if (!showNumber) {
      return message.reply('Usage: `!finalize 1`');
    }

    const show = await Show.findOne({
      showNumber,
      userId: message.author.id,
      guildId: message.guild.id,
      isFinalized: false
    });

    if (!show) {
      return message.reply('Show introuvable ou déjà finalisé.');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    const msg = await message.channel.messages.fetch(show.messageId);
    
    const votes = [];
    for (let i = 0; i < 10; i++) {
      const reaction = msg.reactions.cache.get(EMOJI_NUMBERS[i]);
      if (reaction) {
        const users = await reaction.users.fetch();
        users.forEach(user => {
          if (!user.bot && !votes.find(v => v.userId === user.id)) {
            votes.push({ userId: user.id, stars: STAR_VALUES[i] });
          }
        });
      }
    }

    if (votes.length === 0) {
      return message.reply('Aucun vote enregistré.');
    }

    show.ratings = votes;
    let baseRating = votes.reduce((sum, v) => sum + v.stars, 0) / votes.length;
    
    // Appliquer le bonus des frais fixes
    const ratingBonus = calculateRatingBonus(
      federation.production,
      federation.marketing,
      federation.facilities
    );
    const bonusedRating = Math.min(5, baseRating * (1 + ratingBonus));
    
    show.averageRating = bonusedRating;
    
    // Calculer les gains avec multiplicateur de classe
    const classConfig = CLASS_CONFIG[federation.class];
    const baseEarnings = calculateEarnings(bonusedRating);
    show.earnings = Math.floor(baseEarnings * classConfig.earningsMultiplier);
    show.isFinalized = true;

    federation.pendingEarnings += show.earnings;
    await federation.save();
    await show.save();

    const starsDisplay = '⭐'.repeat(Math.floor(bonusedRating)) + 
                        (bonusedRating % 1 >= 0.5 ? '✨' : '');

    const bonusInfo = ratingBonus > 0 
      ? `\n✨ Bonus frais fixes: +${(ratingBonus * 100).toFixed(0)}%`
      : '';

    const embed = new EmbedBuilder()
      .setTitle(`📊 Résultats - Show #${showNumber}`)
      .setDescription(`**${federation.name}**`)
      .addFields(
        { name: 'Note de Base', value: `${baseRating.toFixed(2)}/5`, inline: true },
        { name: 'Note Finale', value: `${starsDisplay} **${bonusedRating.toFixed(2)}/5**${bonusInfo}`, inline: true },
        { name: 'Votes', value: `${votes.length} personnes`, inline: true },
        { name: 'Gains Générés', value: `💰 $${show.earnings.toLocaleString()}`, inline: true },
        { name: 'Multiplicateur', value: `x${classConfig.earningsMultiplier}`, inline: true },
        { name: 'Statut', value: '⏳ En attente du jour de paye' }
      )
      .setColor('#9B59B6');

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: JOUR DE PAYE (ADMIN)
  // ==========================================================================
  
 if (command === 'payday') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('❌ Commande réservée aux administrateurs.');
    }

    const federations = await Federation.find({ guildId: message.guild.id });
    const results = [];

    for (const fed of federations) {
      // Calculer le coût mensuel des lutteurs
      const wrestlerMonthlyCost = fed.roster
        .filter(w => w.contractType === 'monthly')
        .reduce((sum, w) => sum + w.salary, 0);

      // Calculer les frais fixes mensuels
      const prodCost = FIXED_COSTS.production[fed.production].monthly;
      const markCost = FIXED_COSTS.marketing[fed.marketing].monthly;
      const facCost = FIXED_COSTS.facilities[fed.facilities].monthly;
      const fixedMonthlyCost = prodCost + markCost + facCost;

      const totalMonthlyCost = wrestlerMonthlyCost + fixedMonthlyCost;

      // Ajouter les gains en attente
      const totalEarnings = fed.pendingEarnings;
      
      // Calculer le nouveau solde
      const netChange = totalEarnings - totalMonthlyCost;
      fed.balance += netChange;
      fed.pendingEarnings = 0;

      await fed.save();

      // Marquer tous les shows non payés comme payés
      await Show.updateMany(
        { userId: fed.userId, guildId: fed.guildId, isPaid: false },
        { isPaid: true }
      );

      results.push({
        name: fed.name,
        earnings: totalEarnings,
        wrestlerCost: wrestlerMonthlyCost,
        fixedCost: fixedMonthlyCost,
        totalCost: totalMonthlyCost,
        netChange,
        newBalance: fed.balance
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('💰 Jour de Paye - Résultats')
      .setDescription(results.map(r => {
        const changeIcon = r.netChange >= 0 ? '📈' : '📉';
        return `**${r.name}**\n` +
               `💵 Gains shows: +${r.earnings.toLocaleString()}\n` +
               `👥 Salaires mensuels: -${r.wrestlerCost.toLocaleString()}\n` +
               `🏢 Frais fixes: -${r.fixedCost.toLocaleString()}\n` +
               `📊 Total dépenses: -${r.totalCost.toLocaleString()}\n` +
               `${changeIcon} **Net: ${r.netChange >= 0 ? '+' : ''}${r.netChange.toLocaleString()}**\n` +
               `💼 Nouveau solde: **${r.newBalance.toLocaleString()}**`;
      }).join('\n\n'))
      .setColor('#2ECC71')
      .setTimestamp();

    message.reply({ embeds: [embed] });
  }
  
   // Commande: Stats de sa fédération
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
    });

    const avgRating = shows.length > 0 
      ? shows.reduce((sum, s) => sum + s.averageRating, 0) / shows.length 
      : 0;

    const totalShowCosts = shows.reduce((sum, s) => sum + s.showCost, 0);

    const embed = new EmbedBuilder()
      .setTitle(`📈 ${federation.name}`)
      .addFields(
        { name: 'Budget Actuel', value: `$${federation.balance.toLocaleString()}`, inline: true },
        { name: 'Gains en Attente', value: `$${federation.pendingEarnings.toLocaleString()}`, inline: true },
        { name: 'Roster', value: `${federation.roster.length} lutteurs`, inline: true },
        { name: 'Shows Complétés', value: shows.length.toString(), inline: true },
        { name: 'Note Moyenne', value: avgRating > 0 ? `⭐ ${avgRating.toFixed(2)}/5` : 'N/A', inline: true },
        { name: 'Dépenses Shows', value: `$${totalShowCosts.toLocaleString()}`, inline: true }
      )
      .setColor('#9B59B6');

    message.reply({ embeds: [embed] });
  }

  // Commande: Renouveler un contrat mensuel
  if (command === 'renew') {
    const wrestlerName = args.join(' ');

    if (!wrestlerName) {
      return message.reply('Usage: `!renew Nom du Lutteur`');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('Tu n\'as pas de fédération.');
    }

    const wrestlerInRoster = federation.roster.find(w => 
      w.wrestlerName.toLowerCase() === wrestlerName.toLowerCase() && 
      w.contractType === 'monthly'
    );

    if (!wrestlerInRoster) {
      return message.reply('Lutteur introuvable dans ton roster ou pas en contrat mensuel.');
    }

    const classConfig = CLASS_CONFIG[federation.class];
    const wrestler = await Wrestler.findById(wrestlerInRoster.wrestlerId);
    let salary = wrestler.salaryMonthly;
    
    if (classConfig.contractBonus.monthly) {
      salary = Math.floor(salary * classConfig.contractBonus.monthly);
    }

    if (federation.balance < salary) {
      return message.reply(`Budget insuffisant pour renouveler ! Coût: ${salary.toLocaleString()}`);
    }

    // Prolonger le contrat de 12 jours
    wrestlerInRoster.contractEndDate = new Date(
      new Date(wrestlerInRoster.contractEndDate).getTime() + 12 * 24 * 60 * 60 * 1000
    );

    await federation.save();

    const embed = new EmbedBuilder()
      .setTitle('✅ Contrat Renouvelé !')
      .addFields(
        { name: 'Lutteur', value: wrestlerInRoster.wrestlerName },
        { name: 'Nouveau salaire', value: `${salary.toLocaleString()}` },
        { name: 'Nouvelle expiration', value: new Date(wrestlerInRoster.contractEndDate).toLocaleDateString('fr-FR') }
      )
      .setColor('#2ECC71');

    message.reply({ embeds: [embed] });
  }
  if (command === 'upgrade') {
    const category = args[0]?.toLowerCase();
    
    if (!category || !['production', 'marketing', 'facilities'].includes(category)) {
      return message.reply('Usage: `!upgrade production` ou `!upgrade marketing` ou `!upgrade facilities`');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('Tu n\'as pas de fédération.');
    }

    const currentLevel = federation[category];
    
    if (currentLevel >= 5) {
      return message.reply('Cette catégorie est déjà au niveau maximum (5) !');
    }

    const nextLevel = currentLevel + 1;
    const upgradeCost = FIXED_COSTS[category][nextLevel].monthly * 3; // Coût = 3x le coût mensuel du prochain niveau

    if (federation.balance < upgradeCost) {
      return message.reply(`Budget insuffisant ! Upgrade vers niveau ${nextLevel} coûte ${upgradeCost.toLocaleString()}`);
    }

    federation.balance -= upgradeCost;
    federation[category] = nextLevel;
    await federation.save();

    const categoryNames = {
      production: '🎬 Production',
      marketing: '📢 Marketing',
      facilities: '🏢 Installations'
    };

    const newCosts = FIXED_COSTS[category][nextLevel];
    const embed = new EmbedBuilder()
      .setTitle('✅ Upgrade Réussi !')
      .setDescription(`${categoryNames[category]} → Niveau ${nextLevel}`)
      .addFields(
        { name: 'Coût de l\'upgrade', value: `${upgradeCost.toLocaleString()}` },
        { name: 'Nouveaux coûts', value: `Mensuel: ${newCosts.monthly.toLocaleString()}\nPar show: ${newCosts.perShow.toLocaleString()}`, inline: true },
        { name: 'Bonus note', value: `+${(newCosts.bonus * 100).toFixed(0)}%`, inline: true },
        { name: 'Budget restant', value: `${federation.balance.toLocaleString()}` }
      )
      .setColor('#3498DB');

    message.reply({ embeds: [embed] });
  }

  // Commande: Voir les frais fixes
  if (command === 'facilities' || command === 'fixedcosts') {
    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('Tu n\'as pas de fédération.');
    }

    const prodInfo = FIXED_COSTS.production[federation.production];
    const markInfo = FIXED_COSTS.marketing[federation.marketing];
    const facInfo = FIXED_COSTS.facilities[federation.facilities];

    const totalBonus = calculateRatingBonus(
      federation.production,
      federation.marketing,
      federation.facilities
    );

    const embed = new EmbedBuilder()
      .setTitle(`🏢 Frais Fixes - ${federation.name}`)
      .addFields(
        { 
          name: `🎬 Production - Niveau ${federation.production}/5`, 
          value: `Mensuel: ${prodInfo.monthly.toLocaleString()} | Show: ${prodInfo.perShow.toLocaleString()}\nBonus: +${(prodInfo.bonus * 100).toFixed(0)}%`
        },
        { 
          name: `📢 Marketing - Niveau ${federation.marketing}/5`, 
          value: `Mensuel: ${markInfo.monthly.toLocaleString()} | Show: ${markInfo.perShow.toLocaleString()}\nBonus: +${(markInfo.bonus * 100).toFixed(0)}%`
        },
        { 
          name: `🏢 Installations - Niveau ${federation.facilities}/5`, 
          value: `Mensuel: ${facInfo.monthly.toLocaleString()} | Show: ${facInfo.perShow.toLocaleString()}\nBonus: +${(facInfo.bonus * 100).toFixed(0)}%`
        },
        {
          name: '📊 Bonus Total de Note',
          value: `**+${(totalBonus * 100).toFixed(0)}%**`
        }
      )
      .setColor('#9B59B6')
      .setFooter({ text: 'Utilisez !upgrade <catégorie> pour améliorer' });

    message.reply({ embeds: [embed] });
  }
  if (command === 'available') {
    const page = parseInt(args[0]) || 1;
    const perPage = 15;
    
    const wrestlers = await Wrestler.find({ isDrafted: false })
      .skip((page - 1) * perPage)
      .limit(perPage);

    const total = await Wrestler.countDocuments({ isDrafted: false });

    if (wrestlers.length === 0) {
      return message.reply('Aucun lutteur disponible sur cette page.');
    }

    const list = wrestlers.map((w, i) => {
      return `**${((page - 1) * perPage) + i + 1}.** ${w.name}\n   📺 $${w.salaryPerShow.toLocaleString()} | 📅 $${w.salaryMonthly.toLocaleString()}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setTitle('📋 Lutteurs Disponibles')
      .setDescription(list)
      .setFooter({ text: `Page ${page}/${Math.ceil(total / perPage)} | 📺 = Per Show | 📅 = Mensuel` })
      .setColor('#3498DB');

    message.reply({ embeds: [embed] });
  }
});

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot Discord actif');
}).listen(PORT, () => {
  console.log(`🌐 Serveur sur le port ${PORT}`);
  keepAlive(); // Démarre le keep-alive après le démarrage du serveur
});

client.login(process.env.DISCORD_TOKEN);
