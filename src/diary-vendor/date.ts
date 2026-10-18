const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertDate(value: string): string {
  const match = DATE_RE.exec(value);
  if (!match) throw Object.assign(new Error("日期格式必须为 YYYY-MM-DD"), { statusCode: 400 });
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() + 1 !== Number(m) || date.getUTCDate() !== Number(d)) {
    throw Object.assign(new Error("日期不存在"), { statusCode: 400 });
  }
  return value;
}

export function todayInTimezone(timezone = "Asia/Shanghai", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(date: string, amount: number): string {
  assertDate(date);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

export function weekStart(date: string): string {
  const d = new Date(`${assertDate(date)}T00:00:00Z`);
  const day = d.getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
}

export function weekLabel(date: string): string {
  const d = new Date(`${assertDate(date)}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / 604_800_000);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export function zonedClock(timezone: string, now = new Date()): { date: string; weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: weekdays[get("weekday")] ?? 0, hour: Number(get("hour")), minute: Number(get("minute")) };
}
