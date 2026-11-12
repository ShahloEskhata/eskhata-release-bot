/** Время вида "17:00" или "до 17:00" в начале строки; возвращает {h, m, length} или null. */
export function parseClock(str) {
    const match = str.match(/^(?:до\s+)?(\d{1,2}):(\d{2})\b/i);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return { h, m, length: match[0].length };
}

/** Текущая дата, минуты от полуночи и день недели ('Mon'…'Sun') в часовом поясе tz. */
export function localClock(now, tz) {
    const p = new Intl.DateTimeFormat('en-GB', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        weekday: 'short', hourCycle: 'h23', timeZone: tz,
    })
        .formatToParts(now)
        .reduce((acc, x) => ({ ...acc, [x.type]: x.value }), {});
    return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}

/** Ближайший момент (мс) с часами h:m в часовом поясе tz: сегодня, а если уже прошло — завтра. */
export function nextOccurrence(h, m, tz, now = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz })
        .formatToParts(now)
        .reduce((acc, p) => ({ ...acc, [p.type]: Number(p.value) }), {});
    const diffMin = h * 60 + m - (parts.hour * 60 + parts.minute);
    const ts = Math.floor(now / 60_000) * 60_000 + diffMin * 60_000;
    return ts > now ? ts : ts + 24 * 3_600_000;
}
