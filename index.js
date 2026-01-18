require('dotenv').config({
  path: require('path').join(__dirname, '.env')
});

const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
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

// Schéma Lutteur (dynamique - créé à la volée lors du pick)
const wrestlerSchema = new mongoose.Schema({
  name: String,
  isDrafted: { type: Boolean, default: false },
  ownerId: { type: String, default: null },
  ownerFedName: { type: String, default: null },
  guildId: String,
  createdAt: { type: Date, default: Date.now }
});

const Wrestler = mongoose.model('Wrestler', wrestlerSchema);

// Schéma Fédération
const federationSchema = new mongoose.Schema({
  userId: String,
  guildId: String,
  name: String,
  logoUrl: String,
  roster: [{ 
    wrestlerName: String,
    signedDate: { type: Date, default: Date.now }
  }],
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
  isFinalized: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Show = mongoose.model('Show', showSchema);

// Schéma Championship Belt
const beltSchema = new mongoose.Schema({
  userId: String,
  guildId: String,
  federationName: String,
  beltName: String,
  currentChampion: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

const Belt = mongoose.model('Belt', beltSchema);

// ============================================================================
// CONFIGURATION DES ÉTOILES
// ============================================================================

const STAR_VALUES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
const EMOJI_NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// ============================================================================
// ÉVÉNEMENT: BOT PRÊT
// ============================================================================

client.on('ready', async () => {
  console.log(`🤼 Bot Fantasy Booking connecté : ${client.user.tag}`);
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

    // Vérifier si un logo existe
    const logoPath = path.join(__dirname, 'logos', `${message.author.id}.png`);
    let logoUrl = null;
    
    if (fs.existsSync(logoPath)) {
      logoUrl = logoPath;
    }

    const federation = new Federation({
      userId: message.author.id,
      guildId: message.guild.id,
      name,
      logoUrl
    });

    await federation.save();

    const embed = new EmbedBuilder()
      .setTitle('🏆 Fédération Créée !')
      .setDescription(`**${name}**`)
      .addFields(
        { name: 'Roster', value: '0 lutteurs' },
        { name: 'Statut', value: '✅ Prêt à drafter' }
      )
      .setColor('#FFD700');

    if (logoUrl && fs.existsSync(logoUrl)) {
      embed.setThumbnail(`attachment://${message.author.id}.png`);
      const attachment = new AttachmentBuilder(logoUrl, { name: `${message.author.id}.png` });
      return message.reply({ embeds: [embed], files: [attachment] });
    }

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

    // Libérer tous les lutteurs
    await Wrestler.updateMany(
      { ownerId: targetUser.id, guildId: message.guild.id },
      { isDrafted: false, ownerId: null, ownerFedName: null }
    );

    // Supprimer les titres
    await Belt.deleteMany({
      userId: targetUser.id,
      guildId: message.guild.id
    });

    // Supprimer les shows
    await Show.deleteMany({
      userId: targetUser.id,
      guildId: message.guild.id
    });

    await Federation.deleteOne({ _id: federation._id });

    return message.reply(`✅ Fédération de ${targetUser.username} supprimée et lutteurs libérés.`);
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

    // Vérifier si le lutteur existe déjà (dans ce serveur)
    let wrestler = await Wrestler.findOne({ 
      name: new RegExp(`^${wrestlerName}$`, 'i'),
      guildId: message.guild.id
    });

    // Si le lutteur existe et est déjà drafté par quelqu'un d'autre
    if (wrestler && wrestler.isDrafted && wrestler.ownerId !== message.author.id) {
      return message.reply(
        `❌ **${wrestler.name}** est déjà signé en exclusivité avec **${wrestler.ownerFedName}** !`
      );
    }

    // Si le lutteur n'existe pas, le créer
    if (!wrestler) {
      wrestler = new Wrestler({
        name: wrestlerName,
        guildId: message.guild.id
      });
      await wrestler.save();
    }

    // Si le lutteur est déjà dans le roster
    const alreadyInRoster = federation.roster.find(w => 
      w.wrestlerName.toLowerCase() === wrestler.name.toLowerCase()
    );

    if (alreadyInRoster) {
      return message.reply(`${wrestler.name} est déjà dans ton roster !`);
    }

    // Ajouter au roster
    federation.roster.push({
      wrestlerName: wrestler.name
    });

    await federation.save();

    // Marquer comme drafté (exclusif)
    wrestler.isDrafted = true;
    wrestler.ownerId = message.author.id;
    wrestler.ownerFedName = federation.name;
    await wrestler.save();
    
    const embed = new EmbedBuilder()
      .setTitle('✅ Lutteur Drafté !')
      .setDescription(`**${wrestler.name}** a rejoint **${federation.name}** !`)
      .addFields(
        { name: 'Lutteur', value: wrestler.name, inline: true },
        { name: 'Statut', value: '🔒 Exclusif', inline: true },
        { name: 'Roster Total', value: `${federation.roster.length} lutteurs` }
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

    const rosterText = federation.roster.map((w, i) => {
      const signedDate = new Date(w.signedDate).toLocaleDateString('fr-FR');
      return `**${i + 1}.** ${w.wrestlerName} - 🔒 Exclusif (Signé le ${signedDate})`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`🤼 Roster - ${federation.name}`)
      .setDescription(rosterText)
      .addFields(
        { name: 'Total', value: `${federation.roster.length} lutteurs` }
      )
      .setColor('#3498DB');

    if (federation.logoUrl && fs.existsSync(federation.logoUrl)) {
      embed.setThumbnail(`attachment://${message.author.id}.png`);
      const attachment = new AttachmentBuilder(federation.logoUrl, { name: `${message.author.id}.png` });
      return message.reply({ embeds: [embed], files: [attachment] });
    }

    return message.reply({ embeds: [embed] });
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

    // Calculer automatiquement le numéro du prochain show
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
      .setColor('#E67E22');

    // Mentionner le rôle Bookeur s'il existe
    const bookeurRole = message.guild.roles.cache.find(r => r.name === 'Bookeur');
    const mention = bookeurRole ? `${bookeurRole}` : '';

    const msg = await message.reply({ 
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
    const averageRating = votes.reduce((sum, v) => sum + v.stars, 0) / votes.length;
    show.averageRating = averageRating;
    show.isFinalized = true;

    await show.save();

    const starsDisplay = '⭐'.repeat(Math.floor(averageRating)) + 
                        (averageRating % 1 >= 0.5 ? '✨' : '');

    const embed = new EmbedBuilder()
      .setTitle(`📊 Résultats - Show #${showNumber}`)
      .setDescription(`**${federation.name}**`)
      .addFields(
        { name: 'Note Finale', value: `${starsDisplay} **${averageRating.toFixed(2)}/5**`, inline: true },
        { name: 'Votes', value: `${votes.length} personnes`, inline: true }
      )
      .setColor('#9B59B6');

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
    const beltName = args[0];
    const wrestlerName = args.slice(1).join(' ');

    if (!beltName || !wrestlerName) {
      return message.reply('Usage: `!setchamp <nom_titre> Nom du Lutteur`\nExemple: !setchamp WWE_Championship John Cena');
    }

    const federation = await Federation.findOne({
      userId: message.author.id,
      guildId: message.guild.id
    });

    if (!federation) {
      return message.reply('Tu n\'as pas de fédération.');
    }

    // Vérifier que le lutteur est dans le roster
    const wrestlerInRoster = federation.roster.find(w => 
      w.wrestlerName.toLowerCase() === wrestlerName.toLowerCase()
    );

    if (!wrestlerInRoster) {
      return message.reply(`${wrestlerName} n'est pas dans ton roster !`);
    }

    // Trouver la ceinture
    const belt = await Belt.findOne({
      userId: message.author.id,
      guildId: message.guild.id,
      beltName: new RegExp(`^${beltName}$`, 'i')
    });

    if (!belt) {
      return message.reply(`Le titre "${beltName}" n'existe pas. Crée-le avec \`!createbelt ${beltName}\``);
    }

    belt.currentChampion = wrestlerInRoster.wrestlerName;
    await belt.save();

    const embed = new EmbedBuilder()
      .setTitle('👑 Nouveau Champion !')
      .addFields(
        { name: 'Titre', value: belt.beltName },
        { name: 'Champion', value: wrestlerInRoster.wrestlerName },
        { name: 'Fédération', value: federation.name }
      )
      .setColor('#FFD700');

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: VOIR SA FÉDÉRATION
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
    });

    const avgRating = shows.length > 0 
      ? shows.reduce((sum, s) => sum + s.averageRating, 0) / shows.length 
      : 0;

    // Récupérer les champions
    const belts = await Belt.find({
      userId: message.author.id,
      guildId: message.guild.id
    });

    const championsText = belts.length > 0
      ? belts.map(b => `🏆 **${b.beltName}**: ${b.currentChampion || 'Vacant'}`).join('\n')
      : 'Aucun titre créé';

    const createdDate = new Date(federation.createdAt).toLocaleDateString('fr-FR');

    const embed = new EmbedBuilder()
      .setTitle(`📈 ${federation.name}`)
      .setDescription('Statistiques de ta fédération')
      .addFields(
        { name: 'Roster', value: `${federation.roster.length} lutteurs`, inline: true },
        { name: 'Shows Complétés', value: shows.length.toString(), inline: true },
        { name: 'Note Moyenne', value: avgRating > 0 ? `⭐ ${avgRating.toFixed(2)}/5` : 'N/A', inline: true },
        { name: 'Créée le', value: createdDate, inline: true },
        { name: '👑 Champions', value: championsText }
      )
      .setColor('#9B59B6')
      .setFooter({ text: `Propriétaire: ${message.author.username}` });

    if (federation.logoUrl && fs.existsSync(federation.logoUrl)) {
      embed.setThumbnail(`attachment://${message.author.id}.png`);
      const attachment = new AttachmentBuilder(federation.logoUrl, { name: `${message.author.id}.png` });
      return message.reply({ embeds: [embed], files: [attachment] });
    }

    return message.reply({ embeds: [embed] });
  }

  // ==========================================================================
  // COMMANDE: AIDE
  // ==========================================================================
  
  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('📖 Commandes Fantasy Booking')
      .setDescription('Liste des commandes disponibles')
      .addFields(
        { name: '!createfed [nom]', value: 'Créer ta fédération' },
        { name: '!pick [nom du lutteur]', value: 'Drafter un lutteur (n\'importe quel nom, devient exclusif)' },
        { name: '!roster', value: 'Voir ton roster' },
        { name: '!fed', value: 'Voir les stats de ta fédération' },
        { name: '!showend', value: 'Annoncer la fin d\'un show (auto-numéroté)' },
        { name: '!finalize [numéro]', value: 'Finaliser les votes d\'un show' },
        { name: '!createbelt [nom]', value: 'Créer un titre de champion' },
        { name: '!setchamp [titre] [lutteur]', value: 'Définir un champion' },
        { name: '!resetfed [@user]', value: 'Supprimer une fédération (ADMIN)' }
      )
      .setColor('#3498DB')
      .setFooter({ text: 'Les lutteurs draftés sont exclusifs à ta fédération' });

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
  console.log(`🌐 Serveur sur le port ${PORT}`);
  keepAlive();
});

client.login(process.env.DISCORD_TOKEN);
