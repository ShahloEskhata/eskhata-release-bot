const MAX_LEN = 3800; // лимит Telegram 4096, оставляем запас на статус и теги

const ICON = { ok: '✅', bad: '❌', await: '📎', na: '➖', excluded: '🚫', notready: '🚧' };
const FINISHED = ['ok', 'na', 'bad', 'excluded', 'notready']; // такие задачи показываем в сжатом виде

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// [SN-561](https://...) -> кликабельная ссылка (в исходном тексте markdown не рендерится)
const withLinks = (escaped) => escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

export function mention(tester) {
    if (tester.username) return `@${tester.username}`;
    return `<a href="tg://user?id=${tester.userId}">${esc(tester.name)}</a>`;
}

export function userMention(user) {
    return user.username ? `@${user.username}` : `<a href="tg://user?id=${user.id}">${esc(user.first_name || 'user')}</a>`;
}

export const time = (ts, tz) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });

export function statusLine(task, tz) {
    const files = task.media?.length ? ` (вложений: ${task.media.length})` : '';
    if (task.status === 'ok') return `✅ Протестировано — ${esc(task.by)}, ${time(task.at, tz)}${files}`;
    if (task.status === 'na') return `➖ Не требует теста — ${esc(task.by)}, ${time(task.at, tz)}`;
    if (task.status === 'notready') return `🚧 Задача не готова — ${esc(task.by)}, ${time(task.at, tz)}`;
    if (task.status === 'excluded') return `🚫 Исключена из релиза — ${esc(task.by)}, ${time(task.at, tz)}`;
    if (task.status === 'await') {
        return task.promptDm
            ? '📎 Ждём вложение: бот попросил скриншот или видео в личных сообщениях'
            : '📎 Ждём вложение: прикрепите скриншот или видео в открывшемся ответе';
    }
    if (task.status === 'bad') {
        const reason = task.reason ? `\nПричина: ${esc(task.reason)}` : '\nПричина: ответьте на сообщение бота';
        return `❌ Не пройдена — ${esc(task.by)}, ${time(task.at, tz)}${files}${reason}`;
    }
    return '⏳ Ожидает подтверждения';
}

// Короткая подпись задачи: ключ-ссылка и описание без исполнителя и MR
// Описание задачи без ключа, маркера и ссылок — для коротких подписей и выгрузки
export const taskDescription = (task) =>
    (task.lines[0] || '')
        .replace(/^[-•*]\s*/, '')
        .replace(/^\[?[A-Z][A-Z0-9]*-\d+\]?(\([^)]*\))?\s*[—-]*\s*/, '')
        .trim();

export function taskTitle(task) {
    const url = (task.lines[0] || '').match(/\((https?:\/\/[^)\s]+)\)/)?.[1];
    let desc = taskDescription(task);
    if (desc.length > 120) desc = `${desc.slice(0, 117)}…`;
    const key = task.key ? (url ? `<a href="${esc(url)}">${esc(task.key)}</a>` : `<b>${esc(task.key)}</b>`) : '';
    return `${key}${key && desc ? ' — ' : ''}${esc(desc || (task.key ? '' : task.section))}`;
}

// Одно сообщение = одна задача, поэтому вложение-ответ однозначно относится к ней.
// Завершённая задача сжимается до пары строк, чтобы не превращать группу в простыню.
// pos = { n, m } — номер задачи среди задач этого тестировщика в релизе (показываем, если их больше одной).
export function renderTask(task, tz, pos) {
    const num = pos?.m > 1 ? ` · задача ${pos.n} из ${pos.m}` : '';
    if (FINISHED.includes(task.status)) return `${taskTitle(task)}${num}\n${statusLine(task, tz)}`;

    let body = task.lines.map((l) => withLinks(esc(l))).join('\n');
    if (body.length > MAX_LEN) body = `${body.slice(0, MAX_LEN)}…`;
    // @-тег только в первой задаче тестировщика, остальным не шлём лишних уведомлений
    const who = task.ping ? mention(task.tester) : `<b>${esc(task.tester.name)}</b>`;
    return `<b>${esc(task.section)}</b>${num}\n${who}, подтвердите готовность к релизу:\n\n${body}\n\n${statusLine(task, tz)}`;
}

// link(messageId) даёт ссылку на сообщение задачи: в сводке по ключу можно перейти к нужной задаче
export function renderSummary(rel, tz, link = () => null) {
    const tracked = rel.tasks.filter((t) => t.tester && t.status !== 'excluded' && t.status !== 'notready');
    const done = tracked.filter((t) => t.status === 'ok' || t.status === 'na').length;

    const bySection = new Map();
    for (const t of rel.tasks) {
        if (!bySection.has(t.section)) bySection.set(t.section, []);
        bySection.get(t.section).push(t);
    }

    const keyRef = (t) => {
        const url = link(t.cardChat ? null : t.messageId);
        const name = esc(t.key || 'задача');
        return url ? `<a href="${url}">${name}</a>` : name;
    };
    const rows = (ts) => ts.map((t) => `${ICON[t.status] || '⏳'} ${keyRef(t)}`).join('  ');
    const NO_TESTER = '⚠️ без тестировщика (testers.json + /reload или /assign)';

    // В одной секции могут быть задачи разных команд, поэтому внутри секции группируем ещё и по тестировщику
    const blocks = [...bySection].map(([title, tasks]) => {
        const groups = new Map();
        for (const t of tasks) {
            const k = t.tester ? t.tester.username || `id${t.tester.userId}` : '-';
            if (!groups.has(k)) groups.set(k, { tester: t.tester, ts: [] });
            groups.get(k).ts.push(t);
        }
        if (groups.size === 1) {
            const { tester, ts } = [...groups.values()][0];
            return `<b>${esc(title)}</b> — ${tester ? esc(tester.name) : NO_TESTER}\n${rows(ts)}`;
        }
        const lines = [...groups.values()].map(({ tester, ts }) => `${tester ? esc(tester.name) : NO_TESTER}: ${rows(ts)}`);
        return `<b>${esc(title)}</b>\n${lines.join('\n')}`;
    });

    const failed = tracked.filter((t) => t.status === 'bad');
    const failedBlock = failed.length
        ? `\n\n❌ <b>Не пройдены:</b>\n${failed.map((t) => `• ${esc(t.key || t.section)} — ${esc(t.reason || 'причина не указана')}`).join('\n')}`
        : '';
    const deadline = rel.deadlineAt ? `\nСрок: ${time(rel.deadlineAt, tz)}` : '';

    return `<b>${esc(rel.title)}</b>\nГотово: ${done} из ${tracked.length} задач${deadline}\n\n${blocks.join('\n\n')}${failedBlock}`;
}

// Итог для принятия решения о релизе; link(messageId) даёт ссылку на сообщение или null
export function renderReport(rel, link) {
    const ref = (t) => {
        const url = link(t.cardChat ? null : t.messageId);
        const name = esc(t.key || t.section);
        return url ? `<a href="${url}">${name}</a>` : name;
    };
    const files = (t) =>
        (t.media || [])
            .map((id, i) => (link(id) ? `<a href="${link(id)}">📎${i + 1}</a>` : null))
            .filter(Boolean)
            .join(' ');
    const byStatus = (...statuses) => rel.tasks.filter((t) => t.tester && statuses.includes(t.status));

    const parts = [`📋 <b>Отчёт: ${esc(rel.title)}</b>`];
    const add = (head, tasks, row) => tasks.length && parts.push(`\n${head} (${tasks.length})\n${tasks.map(row).join('\n')}`);

    add('✅ <b>Прошли</b>', byStatus('ok'), (t) => `• ${ref(t)} — ${esc(t.by)} ${files(t)}`.trimEnd());
    add('➖ <b>Не требуют теста</b>', byStatus('na'), (t) => `• ${ref(t)} — ${esc(t.by)}`);
    add('❌ <b>Не пройдены</b>', byStatus('bad'), (t) => `• ${ref(t)} — ${esc(t.reason || 'причина не указана')} ${files(t)}`.trimEnd());
    add('⏳ <b>Без ответа</b>', byStatus('pending', 'await'), (t) => `• ${ref(t)} — ${esc(t.tester.name)}`);
    add('🚧 <b>Не готовы</b>', rel.tasks.filter((t) => t.status === 'notready'), (t) => `• ${ref(t)} — ${esc(t.by)}`);
    add('🚫 <b>Исключены из релиза</b>', rel.tasks.filter((t) => t.status === 'excluded'), (t) => `• ${ref(t)}`);
    add('⚠️ <b>Без тестировщика</b>', rel.tasks.filter((t) => !t.tester), (t) => `• ${esc(t.key || t.section)}`);

    return parts.join('\n');
}
