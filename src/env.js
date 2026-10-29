// Settings from before the rename to Plateful still work: LARDER_X in an old .env counts as PLATEFUL_X.
// Imported first, so everything after it only needs to read PLATEFUL_ names.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('LARDER_')) process.env[`PLATEFUL_${k.slice(7)}`] ??= v;
}
