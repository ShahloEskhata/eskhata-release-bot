import { esc } from './format.js';

const MIN = 60_000;

export function formatDuration(ms) {
    const min = Math.round(ms / MIN);
    if (min < 60) return `${min} мин`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} ч ${min % 60} мин`;
    return `${Math.floor(h / 24)} д ${h % 24} ч`;
}

/** Считает по тестировщикам и по секциям (командам) по всем переданным релизам. */
export function computeStats(releases) {
    const people = new Map();
    const sections = new Map();

    for (const rel of releases) {
        for (const t of rel.tasks) {
            if (!t.tester || t.status === 'excluded' || t.status === 'notready') continue;
            const p = people.get(t.tester.name) || { name: t.tester.name, total: 0, ok: 0, bad: 0, na: 0, open: 0, waitMs: 0, waitN: 0 };
            const s = sections.get(t.section) || { title: t.section, total: 0, bad: 0 };
            p.total++;
            s.total++;
            if (t.status === 'ok' || t.status === 'bad' || t.status === 'na') p[t.status]++;
            else p.open++;
            if (t.status === 'bad') s.bad++;
            // время реакции: от публикации задачи до подтверждения с вложением
            if (t.status === 'ok' && typeof t.postedAt === 'number' && t.at >= t.postedAt) {
                p.waitMs += t.at - t.postedAt;
                p.waitN++;
            }
            people.set(p.name, p);
            sections.set(s.title, s);
        }
    }

    return {
        releases: releases.length,
        people: [...people.values()].sort((a, b) => b.total - a.total),
        sections: [...sections.values()].sort((a, b) => b.bad / b.total - a.bad / a.total || b.total - a.total),
    };
}

export function renderStats(stats) {
    if (!stats.people.length) return 'Пока нет данных для статистики.';
    const people = stats.people.map((p) => {
        const avg = p.waitN ? `, в среднем ${formatDuration(p.waitMs / p.waitN)}` : '';
        const open = p.open ? ` ⏳${p.open}` : '';
        return `• ${esc(p.name)} — ${p.total}: ✅${p.ok} ❌${p.bad} ➖${p.na}${open}${avg}`;
    });
    const sections = stats.sections.map(
        (s) => `• ${esc(s.title)} — ${s.total} задач, не пройдено ${s.bad} (${Math.round((s.bad / s.total) * 100)}%)`,
    );
    return (
        `📊 <b>Статистика</b> (релизов: ${stats.releases})\n\n` +
        `<b>По тестировщикам</b> (задач: ✅ ❌ ➖, время до подтверждения)\n${people.join('\n')}\n\n` +
        `<b>По командам</b>\n${sections.join('\n')}`
    );
}
