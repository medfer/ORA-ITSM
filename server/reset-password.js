// Réinitialise (ou crée) un compte administrateur directement dans la base.
// Usage : node server/reset-password.js <email> <nouveau_mot_de_passe>
//         node server/reset-password.js --list
const { db, hashPassword } = require('./db');

const [arg1, arg2] = process.argv.slice(2);

if (!arg1 || arg1 === '--list') {
  const users = db.prepare('SELECT id, email, role, active FROM users ORDER BY id').all();
  console.log('Comptes existants :');
  for (const u of users) console.log(`  ${u.email}  (${u.role}${u.active ? '' : ', désactivé'})`);
  if (!arg1) console.log('\nUsage : node server/reset-password.js <email> <nouveau_mot_de_passe>');
  process.exit(0);
}

if (!arg2 || arg2.length < 8) {
  console.error('Le mot de passe doit contenir au moins 8 caractères.');
  process.exit(1);
}

const email = arg1.trim();
const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (user) {
  db.prepare("UPDATE users SET password_hash = ?, active = 1, role = 'admin' WHERE id = ?").run(hashPassword(arg2), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  console.log(`Mot de passe réinitialisé pour ${email} (rôle admin, compte actif).`);
} else {
  db.prepare("INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Administrateur', ?, ?, 'admin', ?)")
    .run(email, hashPassword(arg2), Date.now());
  console.log(`Compte admin créé : ${email}`);
}
