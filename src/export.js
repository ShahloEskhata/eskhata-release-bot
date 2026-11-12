import { taskDescription, time } from './format.js';

const STATUS = { ok: 'Протестировано', bad: 'Не пройдена', na: 'Не требует теста', excluded: 'Исключена', notready: 'Не готова', pending: 'Без ответа', await: 'Ждём вложение' };
const HEAD = ['Релиз', 'Дата', 'Секция', 'Задача', 'Описание', 'Тестировщик', 'Статус', 'Кто отметил', 'Время', 'Причина', 'Вложения'];

// Excel воспринимает ячейку, начинающуюся с = + - @, как формулу — гасим апострофом
const cell = (v) => {
    const s = String(v ?? '');
    return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/**
 * CSV для Excel (разделитель ";", UTF-8 с BOM, чтобы кириллица открылась сразу).
 * link(rel, messageId) даёт ссылку на сообщение или null.
 */
export function releasesToCsv(rels, { link, tz }) {
    const rows = rels.flatMap((rel) => {
        const date = new Date(rel.createdAtMs || parseInt(rel.id, 36)).toLocaleDateString('ru-RU', { timeZone: tz });
        return rel.tasks.map((t) => {
            const done = ['ok', 'bad', 'na'].includes(t.status);
            return [
                rel.title,
                date,
                t.section,
                t.key || '',
                taskDescription(t),
                t.tester?.name || '',
                t.tester ? STATUS[t.status] : 'Без тестировщика',
                done ? t.by : '',
                done ? time(t.at, tz) : '',
                t.reason || '',
                (t.media || []).map((id) => link(rel, id)).filter(Boolean).join(' '),
            ];
        });
    });
    return `﻿${[HEAD, ...rows].map((r) => r.map(cell).join(';')).join('\r\n')}`;
}
