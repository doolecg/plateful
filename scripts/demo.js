// Fills an empty Larder with a made-up household (Sam and Alex, PINs 1111 and 2222) so you can
// try the app or take screenshots without logging real food first.
//   DATA_DIR=./demo-data node scripts/demo.js && DATA_DIR=./demo-data node src/server.js
import { db, saveSettings, DEFAULT_SETTINGS } from '../src/db.js';
import { hashPin } from '../src/auth.js';
import { localDate, addDays } from '../src/dates.js';
import { formatQuantity, withGrams } from '../public/units.js';

if (db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n) {
  console.error('This database already has people in it. Point DATA_DIR at an empty folder.');
  process.exit(1);
}

// name, amount, unit, grams, kcal, fat, carbs, protein, source
const FOODS = {
  breakfast: [
    [['Porridge oats with semi-skimmed milk', 1, 'bowl', 240, 285, 7.4, 41, 12.6, 'est.'], ['Banana', 1, 'each', 118, 105, 0.4, 27, 1.3, 'est.']],
    [['Greek yoghurt, 0% fat', 150, 'g', 150, 86, 0.3, 5.4, 15.3, 'label'], ['Granola', 40, 'g', 40, 178, 5.6, 26, 4.2, 'label'], ['Blueberries', 1, 'handful', 40, 23, 0.1, 5.8, 0.3, 'est.']],
    [['Wholemeal toast', 2, 'slice', 72, 170, 2, 30, 7.2, 'label'], ['Peanut butter', 1, 'tbsp', 16, 94, 8, 2.2, 4, 'label'], ['Tea with semi-skimmed milk', 1, 'mug', 300, 22, 0.7, 2, 1.4, 'est.']],
    [['Scrambled eggs', 2, 'each', 120, 182, 13, 1.2, 15, 'est.'], ['Sourdough toast', 1, 'slice', 50, 125, 0.8, 24, 4.6, 'est.'], ['Flat white', 1, 'cup', 250, 110, 5.5, 8.5, 6.5, 'est.']],
  ],
  lunch: [
    [['Chicken and bacon sandwich', 1, 'pack', 196, 452, 18, 39, 32, 'label'], ['Ready salted crisps', 1, 'pack', 25, 132, 7.8, 13, 1.6, 'label']],
    [['Tomato soup', 400, 'g', 400, 208, 7.2, 30, 4, 'label'], ['Crusty roll', 1, 'each', 60, 160, 1.5, 31, 5.5, 'est.']],
    [['Tuna pasta salad', 1, 'portion', 300, 420, 16, 44, 24, 'est.'], ['Apple', 1, 'each', 150, 78, 0.3, 21, 0.4, 'est.']],
    [['Jacket potato with beans and cheese', 1, 'plate', 450, 560, 16, 78, 25, 'est.']],
  ],
  dinner: [
    [['Spaghetti bolognese', 1, 'plate', 450, 620, 21, 72, 34, 'est.'], ['Garlic bread', 2, 'slice', 50, 170, 7.5, 21, 4, 'label']],
    [['Chicken tikka masala', 350, 'g', 350, 480, 24, 18, 44, 'label'], ['Pilau rice', 200, 'g', 200, 290, 5, 56, 5.6, 'label']],
    [['Salmon fillet, oven baked', 1, 'each', 130, 270, 17, 0, 28, 'label'], ['New potatoes', 175, 'g', 175, 131, 0.5, 29, 2.8, 'est.'], ['Tenderstem broccoli', 80, 'g', 80, 28, 0.5, 2.4, 3.4, 'est.']],
    [['Beef chilli with rice', 1, 'bowl', 400, 540, 15, 66, 33, 'est.'], ['Sour cream', 2, 'tbsp', 30, 58, 5.7, 1.2, 0.8, 'label']],
  ],
  snacks: [
    [['Digestive biscuit', 2, 'each', 30, 142, 6.2, 19, 2.1, 'label']],
    [['Protein bar', 1, 'bar', 60, 210, 7, 19, 20, 'label']],
    [['Red wine', 1, 'glass', 175, 149, 0, 4.6, 0.1, 'est.']],
    [['Cheddar', 30, 'g', 30, 125, 10.4, 0, 7.6, 'label'], ['Oatcakes', 3, 'each', 30, 135, 5.7, 18, 3, 'label']],
  ],
};

const today = localDate();
const people = [
  { name: 'Sam', pin: '1111', settings: { daily_kcal: 2000, flex_kcal: 2400, goal_kg: 85 }, start: 98.6, rate: 0.55 },
  { name: 'Alex', pin: '2222', settings: { daily_kcal: 1700, flex_kcal: 2000, goal_kg: 64 }, start: 71.2, rate: 0.3 },
];

const insertEntry = db.prepare(`INSERT INTO entries (profile_id, date, meal, name, quantity, amount, unit, grams, density, each_g, kcal, fat, carbs, protein, source, message_id)
  VALUES (@profile_id, @date, @meal, @name, @quantity, @amount, @unit, @grams, @density, @each_g, @kcal, @fat, @carbs, @protein, @source, @message_id)`);
const insertMessage = db.prepare(`INSERT INTO messages (profile_id, date, created_at, text, images, model, input_tokens, output_tokens)
  VALUES (?, ?, ?, ?, '[]', ?, 1800, 240)`);
const TIMES = { breakfast: '07:40', lunch: '12:50', dinner: '19:15', snacks: '15:30' };

db.transaction(() => {
  people.forEach((p, who) => {
    const pid = db.prepare('INSERT INTO profiles (name, pin_hash) VALUES (?, ?)').run(p.name, hashPin(p.pin)).lastInsertRowid;
    saveSettings(pid, { ...DEFAULT_SETTINGS, ...p.settings });

    // Weekly weigh-ins over two months, losing steadily with a little noise
    for (let w = 8; w >= 0; w -= 1) {
      const noise = [0.2, -0.1, 0.3, 0, -0.2, 0.1, 0.2, -0.1, 0][w];
      db.prepare('INSERT INTO weights (profile_id, date, kg) VALUES (?, ?, ?)').run(pid, addDays(today, -w * 7), Math.round((p.start - (8 - w) * p.rate + noise) * 10) / 10);
    }

    // Ten days of meals; today stops after lunch so the diary looks mid-day
    for (let d = 9; d >= 0; d -= 1) {
      const date = addDays(today, -d);
      for (const meal of ['breakfast', 'lunch', 'snacks', 'dinner']) {
        if (d === 0 && (meal === 'dinner' || meal === 'snacks')) continue;
        if (meal === 'snacks' && (d + who) % 3 === 2) continue;
        const items = FOODS[meal][(d * 3 + who * 2 + meal.length) % FOODS[meal].length];
        const text = items.map(([name, amount, unit]) => `${formatQuantity(amount, unit) || amount} ${name.toLowerCase()}`).join(', ');
        const mid = insertMessage.run(pid, date, `${date} ${TIMES[meal]}:00`, text, 'claude-haiku-5-5').lastInsertRowid;
        for (const [name, amount, unit, grams, kcal, fat, carbs, protein, source] of items) {
          const a = withGrams({ amount, unit, grams });
          insertEntry.run({ profile_id: pid, date, meal, name, quantity: formatQuantity(amount, unit), amount, unit, grams,
            density: a.density ?? null, each_g: a.each_g ?? null, kcal, fat, carbs, protein, source, message_id: mid });
        }
      }
    }

    const food = db.prepare('INSERT INTO foods (profile_id, name, unit, per, kcal, fat, carbs, protein) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    food.run(pid, 'Semi-skimmed milk', 'ml', 100, 50, 1.8, 4.8, 3.6);
    food.run(pid, 'Granola', 'g', 100, 445, 14, 65, 10.5);
    food.run(pid, 'Flat white', 'cup', 1, 110, 5.5, 8.5, 6.5);
  });

  const preset = db.prepare('INSERT INTO presets (profile_id, created_by, name, meal) VALUES (NULL, 1, ?, ?)');
  const item = db.prepare(`INSERT INTO preset_items (preset_id, name, quantity, amount, unit, grams, kcal, fat, carbs, protein)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [name, meal, items] of [['Yoghurt bowl', 'breakfast', FOODS.breakfast[1]], ['Friday curry', 'dinner', FOODS.dinner[1]]]) {
    const id = preset.run(name, meal).lastInsertRowid;
    for (const [n, amount, unit, grams, kcal, fat, carbs, protein] of items) item.run(id, n, formatQuantity(amount, unit), amount, unit, grams, kcal, fat, carbs, protein);
  }
})();

console.log('Demo household added: Sam (PIN 1111) and Alex (PIN 2222).');
