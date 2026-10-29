// Clears someone's PIN so they choose a new one next time they tap their name.
//   docker compose exec plateful node scripts/reset-pin.js Sam
import { db } from '../src/db.js';

const name = process.argv.slice(2).join(' ').trim();
const people = db.prepare('SELECT id, name FROM profiles ORDER BY id').all();
const who = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
if (!who) {
  console.error(`${name ? `No one called "${name}".` : 'Say whose PIN to reset.'} People here: ${people.map((p) => p.name).join(', ') || 'none yet'}.`);
  process.exit(1);
}
db.transaction(() => {
  db.prepare('UPDATE profiles SET pin_hash = NULL WHERE id = ?').run(who.id);
  db.prepare('DELETE FROM sessions WHERE profile_id = ?').run(who.id);
})();
console.log(`${who.name}'s PIN is cleared. They'll be asked to choose a new one when they next tap their name.`);
