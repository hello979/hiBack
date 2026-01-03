require('dotenv').config(); // Loads .env from the current directory
const { decrypt } = require('./utils/crypto'); // Adjust path if needed

// Replace with your encrypted API key from MongoDB
const encryptedApiKey = 'K9YmqlLL/VANymXo:KTq7YWahA5xIaaJbb7/6rR/H9EWM3bFCZLjBqjSlQgczx8U4G8nkVBOKLiuBAQ==:+vlpY8nNOoJkazyn3flgJw==';

const apiKey = decrypt(encryptedApiKey);
console.log('Decrypted API Key:', apiKey);