import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/; // правила Telegram: латиница, 5–32 символа
const KEY_RE = /^[A-Z][A-Z0-9]*$/;

export const ADD_USAGE =
    'Формат: /addtester @user KEY1,KEY2 | Название секции; Другая секция\n' +
    'Можно ответить командой на сообщение человека — тогда @user не нужен (подойдёт и тем, у кого нет username). ' +
    'Нужен хотя бы один проект или секция.';

const inline = (a) => `[${a.map((x) => JSON.stringify(x)).join(', ')}]`;

/** JSON в стиле нашего testers.json: объект на несколько строк, массивы в одну. */
export function formatTesters(list) {
    const rows = list.map((t) => {
        const fields = Object.entries(t).map(([k, v]) => `        ${JSON.stringify(k)}: ${Array.isArray(v) ? inline(v) : JSON.stringify(v)}`);
        return `    {\n${fields.join(',\n')}\n    }`;
    });
    return `[\n${rows.join(',\n')}\n]\n`;
}

// "@username" в файле — частая опечатка: с @ не работают ни тег, ни проверка прав на кнопки, поэтому убираем его при чтении
export const loadTestersFile = (path) =>
    JSON.parse(readFileSync(path, 'utf8')).map((t) => (t.username ? { ...t, username: t.username.replace(/^@/, '').trim() } : t));

// Пишем напрямую, а не через переименование: в Docker testers.json примонтирован файлом, и rename на нём не работает.
// Окончания строк сохраняем как в файле (на Windows это CRLF), чтобы правка бота не меняла каждую строку в git.
export function saveTestersFile(path, list) {
    const crlf = existsSync(path) && readFileSync(path, 'utf8').includes('\r\n');
    const text = formatTesters(list);
    writeFileSync(path, crlf ? text.replace(/\n/g, '\r\n') : text);
}

export const isSameTester = (t, who) =>
    Boolean((who.username && t.username?.toLowerCase() === who.username.toLowerCase()) || (who.userId && t.userId === who.userId));

/** Кто имеется в виду: автор сообщения, на которое ответили, либо первый токен (@username или числовой ID). */
export function parseTesterRef(tokens, replyUser) {
    if (replyUser && !replyUser.is_bot) {
        const who = { name: replyUser.first_name, userId: replyUser.id };
        if (replyUser.username) who.username = replyUser.username;
        return { who, rest: tokens };
    }
    const [first, ...rest] = tokens;
    const ref = first?.replace(/^@/, '');
    if (!ref) return { error: ADD_USAGE };
    if (/^\d+$/.test(ref)) return { who: { name: `QA ${ref}`, userId: Number(ref) }, rest };
    if (USERNAME_RE.test(ref)) return { who: { name: ref, username: ref }, rest };
    return {
        error: `«${first}» не похоже на username: нужна латиница, 5–32 символа (буквы, цифры, _). Ответьте командой на сообщение человека или укажите числовой ID.`,
    };
}

/** Разбор "@user KEY1,KEY2 | Секция 1; Секция 2" → { who, projects, titles } или { error }. */
export function parseAddTester(arg, replyUser) {
    const [left, ...right] = arg.split('|');
    const titles = right.join('|').split(';').map((s) => s.trim()).filter(Boolean);

    const ref = parseTesterRef(left.trim().split(/\s+/).filter(Boolean), replyUser);
    if (ref.error) return ref;

    const projects = ref.rest.join(' ').split(/[,\s]+/).map((s) => s.toUpperCase()).filter(Boolean);
    const bad = projects.find((p) => !KEY_RE.test(p));
    if (bad) return { error: `Ключ проекта «${bad}» выглядит странно: нужен префикс Jira латиницей, например EJ.` };
    if (!projects.length && !titles.length) return { error: ADD_USAGE };
    return { who: ref.who, projects, titles };
}

/** Добавляет тестировщика или дополняет существующего (проекты и секции объединяются). Меняет list на месте. */
export function addOrUpdateTester(list, who, projects, titles) {
    const existing = list.find((t) => isSameTester(t, who));
    if (existing) {
        existing.projects = [...new Set([...(existing.projects || []), ...projects])];
        existing.titles = [...new Set([...(existing.titles || []), ...titles])];
        if (who.userId && !existing.userId) existing.userId = who.userId; // userId переживёт смену username
        return { created: false, entry: existing };
    }
    const entry = { name: who.name };
    if (who.username) entry.username = who.username;
    if (who.userId) entry.userId = who.userId;
    Object.assign(entry, { titles, projects });
    list.push(entry);
    return { created: true, entry };
}
