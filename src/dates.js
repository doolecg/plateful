// All dates are YYYY-MM-DD in the server's TZ (TZ in .env, Europe/London by default).
const fmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', weekday: 'long' });

export const localDate = (d = new Date()) => fmt.format(d);
export const localTime = (d = new Date()) => timeFmt.format(d);

// Date arithmetic at UTC noon so DST changes never shift the day
export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekOf(date) {
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0
  const monday = addDays(date, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
