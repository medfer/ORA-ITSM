// Create a user account from the command line.
// Usage: node server/add-user.js <email> <password> <role> "<name>"
//        role = client | engineer | admin
const { db, hashPassword } = require('./db');

const [email, password, role = 'client', ...nameParts] = process.argv.slice(2);
const name = nameParts.join(' ').trim() || String(email || '').split('@')[0];

if (!email || !password) {
  console.log('Usage: node server/add-user.js <email> <password> <client|engineer|admin> "<name>"');
  process.exit(1);
}
if (!['client', 'engineer', 'admin'].includes(role)) {
  console.error('Role must be client, engineer or admin.');
  process.exit(1);
}
if (password.length < 8) {
  console.error('The password must be at least 8 characters.');
  process.exit(1);
}
if (db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim())) {
  console.error(`An account already exists for ${email}. Edit it in Settings -> Users.`);
  process.exit(1);
}
db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
  .run(name, email.trim(), hashPassword(password), role, Date.now());
console.log(`Account created: ${name} <${email.trim()}> (${role})`);
