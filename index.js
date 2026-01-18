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
  createdAt: { type: Date, default: Date.now }
});

const Wrestler = mongoose.model('Wrestler', wrestlerSchema);

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
// FONCTIONS UTILITAIRES
// ============================================================================

function getStarDisplay(rating) {
  const fullStars = Math.floor(rating);
  const hasHalfStar = (rating % 1) >= 0.5;
  return '⭐'.repeat(fullStars) + (hasHalfStar ? '✨' : '');
}

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

    const federation = new Federation({
      userId: message.author.id,
      guildId: message.guild.id,
      name,
      logoUrl: null
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
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('❌ Commande réservée aux administrateurs.');
    }

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

    if (wrestler && wrestler.isDrafted && wrestler.ownerId !== message.author.id) {
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

  // Tri alphabétique
  const sortedRoster = [...federation.roster].sort((a, b) => 
    a.wrestlerName.localeCompare(b.wrestlerName, 'fr')
  );

  const itemsPerPage = 7;
  const totalPages = Math.ceil(sortedRoster.length / itemsPerPage);
  let currentPage = 0;

  const generateEmbed = (page) => {
    const start = page * itemsPerPage;
    const end = start + itemsPerPage;
    const pageRoster = sortedRoster.slice(start, end);

    const rosterText = pageRoster.map((w, i) => {
      const signedDate = new Date(w.signedDate).toLocaleDateString('fr-FR');
      return `**${start + i + 1}.** ${w.wrestlerName} - 🔒 Exclusif (Signé le ${signedDate})`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`🤼 Roster - ${federation.name}`)
      .setDescription(rosterText)
      .addFields(
        { name: 'Total', value: `${federation.roster.length} lutteurs` }
      )
      .setColor('#3498DB')
      .setFooter({ text: `Page ${page + 1}/${totalPages}` });

    if (federation.logoUrl && fs.existsSync(federation.logoUrl)) {
      embed.setThumbnail(`attachment://logo.png`);
    }

    return embed;
  };

  const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

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
    embeds: [generateEmbed(currentPage)],
    components: totalPages > 1 ? [row] : [],
    files: federation.logoUrl && fs.existsSync(federation.logoUrl) 
      ? [new AttachmentBuilder(federation.logoUrl, { name: 'logo.png' })] 
      : []
  });

  if (totalPages <= 1) return;

  const collector = embedMessage.createMessageComponentCollector({
    time: 120000 // 2 minutes
  });

  collector.on('collect', async interaction => {
    if (interaction.user.id !== message.author.id) {
      return interaction.reply({ content: 'Ce n\'est pas ton roster !', ephemeral: true });
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
      embeds: [generateEmbed(currentPage)],
      components: [updatedRow]
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
      .setColor('#E67E22');

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
    .setColor('#9B59B6')
    .setFooter({ text: `Finalisé par ${message.author.username}` })
    .setTimestamp();

  // Mise à jour du message original du show
  try {
    const originalEmbed = msg.embeds[0];
    const updatedEmbed = EmbedBuilder.from(originalEmbed)
      .setColor('#2ECC71')
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
    return message.reply('Usage: `!setchamp "Nom du Titre" Nom du Lutteur`\nExemple: !setchamp "WWE Championship" John Cena');
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

  belt.currentChampion = wrestlerName;
  await belt.save();

  const embed = new EmbedBuilder()
    .setTitle('👑 Nouveau Champion !')
    .addFields(
      { name: 'Titre', value: belt.beltName },
      { name: 'Champion', value: wrestlerName },
      { name: 'Fédération', value: federation.name }
    )
    .setColor('#FFD700');

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

    const avgRating = shows.length > 0 
      ? shows.reduce((sum, s) => sum + s.averageRating, 0) / shows.length 
      : 0;

    // 3 derniers shows
    const recentShows = shows.slice(0, 3);
    const showsText = recentShows.length > 0
      ? recentShows.map(s => {
          const date = new Date(s.createdAt).toLocaleDateString('fr-FR');
          const stars = getStarDisplay(s.averageRating);
          return `**Show #${s.showNumber}** - ${date}\n${stars} ${s.averageRating.toFixed(2)}/5`;
        }).join('\n\n')
      : 'Aucun show finalisé';

    // Champions
    const belts = await Belt.find({
      userId: message.author.id,
      guildId: message.guild.id
    });

    const championsText = belts.length > 0
      ? belts.map(b => `🏆 **${b.beltName}**: ${b.currentChampion || 'Vacant'}`).join('\n')
      : 'Aucun titre créé';

    const createdDate = new Date(federation.createdAt).toLocaleDateString('fr-FR');
    const avgStars = getStarDisplay(avgRating);

    const embed = new EmbedBuilder()
      .setTitle(`${federation.name}`)
      .setDescription(`📅 Créée le ${createdDate}`)
      .addFields(
        { name: '🤼 Roster', value: `${federation.roster.length} lutteurs`, inline: true },
        { name: '📺 Shows', value: `${shows.length} complétés`, inline: true },
        { name: '⭐ Moyenne Globale', value: avgRating > 0 ? `${avgStars} ${avgRating.toFixed(2)}/5` : 'N/A', inline: true },
        { name: '📊 Derniers Shows', value: showsText },
        { name: '👑 Champions', value: championsText }
      )
      .setColor('#9B59B6')
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
    
    if (!['7', '30', 'all'].includes(period)) {
      return message.reply('Usage: `!power-ranking [7|30|all]`\nExemple: !power-ranking 7');
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

    const shows = await Show.find({
      guildId: message.guild.id,
      isFinalized: true,
      ...dateFilter
    }).sort({ averageRating: -1 });

    // Top 5 meilleurs shows
    const topShows = shows.slice(0, 5);
    const topShowsText = topShows.length > 0
      ? topShows.map((s, i) => {
          const stars = getStarDisplay(s.averageRating);
          const date = new Date(s.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
          return `**${i + 1}.** ${s.federationName} - Show #${s.showNumber}\n${stars} ${s.averageRating.toFixed(2)}/5 (${date})`;
        }).join('\n\n')
      : 'Aucun show';

    // Top 3 fédérations (min 2 shows)
    const fedStats = {};
    
    for (const show of shows) {
      if (!fedStats[show.federationName]) {
        fedStats[show.federationName] = {
          total: 0,
          count: 0,
          userId: show.userId
        };
      }
      fedStats[show.federationName].total += show.averageRating;
      fedStats[show.federationName].count += 1;
    }

    const topFeds = Object.entries(fedStats)
      .filter(([_, stats]) => stats.count >= 2)
      .map(([name, stats]) => ({
        name,
        average: stats.total / stats.count,
        count: stats.count,
        userId: stats.userId
      }))
      .sort((a, b) => b.average - a.average)
      .slice(0, 3);

    const topFedsText = topFeds.length > 0
      ? topFeds.map((f, i) => {
          const stars = getStarDisplay(f.average);
          return `**${i + 1}.** ${f.name}\n${stars} ${f.average.toFixed(2)}/5 (${f.count} shows)`;
        }).join('\n\n')
      : 'Aucune fédération (min 2 shows)';

    // Stats globales
    const totalShows = shows.length;
    const uniqueFeds = new Set(shows.map(s => s.federationName)).size;

    const embed = new EmbedBuilder()
      .setTitle('🏆 Power Rankings')
      .setDescription(`**Période:** ${periodText}`)
      .addFields(
        { name: '📊 Stats Globales', value: `${totalShows} shows | ${uniqueFeds} fédérations actives` },
        { name: '⭐ Top 5 Meilleurs Shows', value: topShowsText },
        { name: '🎖️ Top 3 Fédérations', value: topFedsText }
      )
      .setColor('#FFD700')
      .setFooter({ text: 'Utilisez !pr 7, !pr 30 ou !pr all' })
      .setTimestamp();

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
        { name: '🏢 Gestion Fédération', value: '`!createfed [nom]` - Créer\n`!fed` - Voir stats\n`!roster` - Voir roster\n`!pick [nom]` - Drafter' },
        { name: '📺 Shows', value: '`!showend` - Terminer un show\n`!finalize [numéro]` - Finaliser votes' },
        { name: '👑 Championnats', value: '`!createbelt [nom]` - Créer titre\n`!setchamp [titre] [lutteur]` - Définir champion' },
        { name: '📊 Classements', value: '`!power-ranking [7|30|all]` - Voir rankings' },
        { name: '⚙️ Admin', value: '`!setlogo [fédération]` + image\n`!resetfed [@user]`\n`!resetpr`' }
      )
      .setColor('#3498DB')
      .setFooter({ text: 'Les lutteurs draftés sont exclusifs' });

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
