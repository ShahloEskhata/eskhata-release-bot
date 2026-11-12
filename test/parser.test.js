import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRelease, findTesterForTask } from '../src/parser.js';

const testers = JSON.parse(readFileSync(new URL('./fixtures/testers.json', import.meta.url)));

const SAMPLE = `EO Core Release 29/10/2026

Всего задач: 18

Сбережения и накопления (2 задачи)

- [SN-561](https://jira.eskhata.com/browse/SN-561) — Исправление бизнес-логики отбора счетов
  Исполнитель: Рахматов Рахим
  MR: https://gitlab.eskhata.com/x/-/merge_requests/2038

- [SN-543](https://jira.eskhata.com/browse/SN-543) — Backend. Перевод отображения счетов
  Исполнитель: Зухуров Амир

Продукт: P2P Эквайринг (4 задачи)

- [PTOPA-335](https://jira.eskhata.com/browse/PTOPA-335) — Admin: Кэшбэк отправителю
  Исполнитель: Точибоев Абдухамид
- [PTOPA-334](https://jira.eskhata.com/browse/PTOPA-334) — Admin: Раздел «Отложенный кэшбэк»

Лояльность (7 задач)

- [LOYAL-573](https://jira.eskhata.com/browse/LOYAL-573) — Backend / Частые вопросы
`;

test('разбирает название, секции и ключи задач', () => {
    const { title, sections } = parseRelease(SAMPLE);
    assert.equal(title, 'EO Core Release 29/10/2026');
    assert.deepEqual(sections.map((s) => s.title), ['Сбережения и накопления', 'P2P Эквайринг', 'Лояльность']);
    assert.deepEqual(sections[0].taskKeys, ['SN-561', 'SN-543']);
    assert.deepEqual(sections[1].taskKeys, ['PTOPA-335', 'PTOPA-334']);
});

test('строки Исполнитель/MR попадают в свою задачу, а не в соседнюю', () => {
    const [savings] = parseRelease(SAMPLE).sections;
    assert.equal(savings.tasks.length, 2);
    assert.ok(savings.tasks[0].lines.some((l) => l.includes('MR:')));
    assert.ok(savings.tasks[0].lines.some((l) => l.includes('Рахматов')));
    assert.ok(savings.tasks[1].lines.some((l) => l.includes('Зухуров')));
    assert.ok(!savings.tasks[1].lines.some((l) => l.includes('MR:')));
});

test('секция без распознанных задач становится одной задачей без ключа', () => {
    const { sections } = parseRelease('Релиз\n\nЛояльность (2 задачи)\n\n1. Что-то сделали\n2. Ещё что-то');
    assert.equal(sections[0].tasks.length, 1);
    assert.equal(sections[0].tasks[0].key, null);
});

// Реальный формат списка: строки задач без маркера "- ", MR/PR в виде markdown-ссылок
const REAL = `EO Core Release 03/11/2026

Всего задач: 6

Лояльность (2 задачи)

[LOYAL-584](https://jira.eskhata.com/browse/LOYAL-584) — PROD Backend / Геймификация
Исполнитель: Саидхоча Ифтихор
MR: [https://gitlab.eskhata.com/x/-/merge_requests/850](https://gitlab.eskhata.com/x/-/merge_requests/850)
[LOYAL-583](https://jira.eskhata.com/browse/LOYAL-583) — Отсутствует модальное окно
Исполнитель: Саидхоча Ифтихор

EO Admin and Integration (3 задачи)

[EJ-697](https://jira.eskhata.com/browse/EJ-697) — [Admin] Новый раздел в Админ-панели
Исполнитель: Шарипов Далер
PR: [https://gitlab.eskhata.com/x/-/merge_requests/840](https://gitlab.eskhata.com/x/-/merge_requests/840)
[CNOO-501](https://jira.eskhata.com/browse/CNOO-501) — Бэкенд. Исправить договор оферты
[EW-282](https://jira.eskhata.com/browse/EW-282) — Механизм управления офером
`;

test('задачи без маркера списка делятся по ключам, а не сливаются в одну', () => {
    const { sections } = parseRelease(REAL);
    assert.deepEqual(sections[0].taskKeys, ['LOYAL-584', 'LOYAL-583']);
    assert.equal(sections[0].tasks.length, 2);
    assert.ok(sections[0].tasks[0].lines.some((l) => l.startsWith('MR:')));
    assert.ok(!sections[0].tasks[1].lines.some((l) => l.startsWith('MR:')));
    assert.deepEqual(sections[1].taskKeys, ['EJ-697', 'CNOO-501', 'EW-282']);
});

test('тестировщик определяется по проекту задачи, секция — запасной вариант', () => {
    const { sections } = parseRelease(REAL);
    const [, admin] = sections;
    const who = (task) => findTesterForTask({ key: task.key, section: admin.title }, testers)?.username ?? null;
    // в одной секции задачи разных команд уходят разным тестировщикам
    assert.equal(who(admin.tasks[0]), 'yermadam'); // EJ
    assert.equal(who(admin.tasks[1]), 'sadafqa'); // CNOO
    assert.equal(who(admin.tasks[2]), null); // EW нет в testers.json

    assert.equal(findTesterForTask({ key: null, section: 'Лояльность' }, testers).username, 'ab_amrr');
    assert.equal(findTesterForTask({ key: 'ZZ-1', section: 'Сбережения и накопления' }, testers).username, 'dzabirovwork');
    assert.equal(findTesterForTask({ key: 'ZZ-1', section: 'Неизвестная' }, testers), null);
});

test('список без заголовков секций группируется по проектам', async () => {
    const { parseRelease, countMismatches } = await import('../src/parser.js');
    const parsed = parseRelease('[BNPL-968] - Лимиты по периодам при калькуляции\n[EA-1318] - Автокредит: перенос текста\n2) EA-1319 - Ещё одна');
    assert.equal(parsed.inferred, true);
    assert.deepEqual(parsed.sections.map((s) => [s.title, s.taskKeys]), [['BNPL', ['BNPL-968']], ['EA', ['EA-1318', 'EA-1319']]]);
    assert.deepEqual(countMismatches(parsed), []);
});

test('заявленное число задач не совпало с найденным — секция попадает в предупреждение', async () => {
    const { parseRelease, countMismatches } = await import('../src/parser.js');
    const parsed = parseRelease('Лояльность (3 задачи)\n[LOYAL-1] - a\n[LOYAL-2] - b');
    assert.deepEqual(countMismatches(parsed).map((s) => s.title), ['Лояльность']);
});
