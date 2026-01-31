require('dotenv').config({
  path: require('path').join(__dirname, '.env')
});

const { Client, GatewayIntentBits } = require('discord.js');
const mongoose = require('mongoose');

console.log('🔍 Démarrage du test...');

// Test 1: MongoDB
console.log('\n1️⃣ Test MongoDB...');
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => {
    console.error('❌ Erreur MongoDB:', err.message);
    process.exit(1);
  });

// Test 2: Discord Client
console.log('\n2️⃣ Test Discord Client...');
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// Gestionnaires d'erreurs
client.on('error', error => {
  console.error('❌ Erreur Discord Client:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Promise Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

client.on('ready', () => {
  console.log('✅ Bot Discord connecté:', client.user.tag);
  console.log('✅ Serveurs:', client.guilds.cache.size);
  console.log('\n🎉 TOUS LES TESTS SONT PASSÉS !\n');
  
  // Garder le processus actif
  setInterval(() => {
    console.log('💓 Bot actif...');
  }, 30000);
});

console.log('\n3️⃣ Tentative de connexion à Discord...');
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('✅ Login initié'))
  .catch(err => {
    console.error('❌ Erreur lors du login:', err.message);
    process.exit(1);
  });

// Serveur HTTP pour Render
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Test Bot actif');
}).listen(PORT, () => {
  console.log(`🌐 Serveur HTTP sur le port ${PORT}`);
});
