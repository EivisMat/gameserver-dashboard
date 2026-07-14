// One-time setup script: initialize database and create admin user
// Usage: node setup.js <username> <password>

const db = require('./auth/db');
const crypto = require('crypto');

const username = process.argv[2] || 'admin';
const password = process.argv[3];

if (!password) {
  console.error('Usage: node setup.js <username> <password>');
  process.exit(1);
}

// Initialize database
db.init();
console.log('Database initialized.');

// Create admin user
try {
  const id = db.createUser({
    username,
    password,
    displayName: username.charAt(0).toUpperCase() + username.slice(1),
    isAdmin: true,
  });
  console.log(`Admin user "${username}" created (id: ${id}).`);
} catch (e) {
  if (e.message?.includes('UNIQUE')) {
    console.log(`User "${username}" already exists.`);
  } else {
    throw e;
  }
}

// Generate JWT_SECRET if not set
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
let envContent = '';
try { envContent = fs.readFileSync(envPath, 'utf8'); } catch {}

if (!envContent.includes('JWT_SECRET')) {
  const secret = crypto.randomBytes(32).toString('hex');
  fs.appendFileSync(envPath, `\nJWT_SECRET=${secret}\n`);
  console.log('JWT_SECRET generated and added to .env');
} else {
  console.log('JWT_SECRET already exists in .env');
}

console.log('\nSetup complete. Restart the dashboard service.');
