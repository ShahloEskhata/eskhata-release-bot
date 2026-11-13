import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InputFile } from 'grammy';
import { createApp } from '../src/app.js';
import { releasesToCsv } from '../src/export.js';
import { computeStats, renderStats } from '../src/stats.js';
import { backupState } from '../src/state.js';

const testers = JSON.parse(readFileSync(new URL('./fixtures/testers.json', import.meta.url)));
const CHAT = { id: -1004499457810, type: 'supergroup', title: 'Release' };
const ADMIN = { id: 1, username: 'admin_qa', first_name: 'Admin' };
const DALER = { id: 11, username: 'dzabirovwork', first_name: 'Daler' };
const AISHA = { id: 12, username: 'aishabb21', first_name: 'Aisha' };

const LIST = `EO Core Release 29/10/2026

Сбережения и накопления (2 задачи)

- [SN-561](https://jira.eskhata.com/browse/SN-561) — Отбор счетов
  Исполнитель: Рахим
- [SN-543](https://jira.eskhata.com/browse/SN-543) — Перевод отображения счетов

P2P Эквайринг (1 задача)

- [PTOPA-335](https://jira.eskhata.com/browse/PTOPA-335) — Кэшбэк отправителю

Неизвестная команда (1 задача)

- [ZZ-1](https://jira.eskhata.com/browse/ZZ-1) — Что-то
`;

// Подставной Telegram: запоминает вызовы и не ходит в сеть
function setup(extra = {}) {
    const calls = [];
    let nextId = 1000;
    const state = { releases: {} };
    const app = createApp({
        token: '1:test',
        botInfo: { id: 1, is_bot: true, first_name: 'T', username: 'test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false },
        adminIds: [ADMIN.id],
        workHours: [0, 24],
        rmUsernames: ['rm_boss'],
        testers,
        loadTesters: () => testers,
        state,
        save: () => {},
        ...extra,
    });
    app.bot.api.config.use(async (_prev, method, payload) => {
        calls.push({ method, payload });
        if (method === 'sendMessage') return { ok: true, result: { message_id: ++nextId, date: 0, chat: { id: payload.chat_id, type: 'supergroup', title: 't' } } };
        if (method === 'copyMessage') return { ok: true, result: { message_id: ++nextId } };
        return { ok: true, result: true };
    });

    let updateId = 1;
    const send = (message) => app.bot.handleUpdate({ update_id: updateId++, message: { date: 0, chat: CHAT, ...message } });
    return {
        app, state, calls,
        sent: (method) => calls.filter((c) => c.method === method).map((c) => c.payload),
        command: (from, text, extra = {}) =>
            send({ message_id: ++nextId, from, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }], ...extra }),
        press: (from, data, source) =>
            app.bot.handleUpdate({ update_id: updateId++, callback_query: { id: String(updateId), from, chat_instance: 'x', data, message: { message_id: 1, date: 0, chat: CHAT, ...(source ? { reply_to_message: { message_id: 500, date: 0, chat: CHAT, text: source } } : {}) } } }),
        plain: (from, text) => send({ message_id: ++nextId, from, text }),
        // сообщение в личный чат с ботом
        dm: (from, message) =>
            app.bot.handleUpdate({ update_id: updateId++, message: { message_id: ++nextId, date: 0, from, chat: { id: from.id, type: 'private' }, ...message } }),
        photo: (from, replyTo, caption) =>
            send({ message_id: ++nextId, from, photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }], caption, ...(replyTo ? { reply_to_message: { message_id: replyTo, date: 0, chat: CHAT } } : {}) }),
        text: (from, replyTo, text) =>
            send({ message_id: ++nextId, from, text, reply_to_message: { message_id: replyTo, date: 0, chat: CHAT } }),
    };
}

async function startRelease(t, text = LIST) {
    await t.command(ADMIN, '/release', { reply_to_message: { message_id: 500, date: 0, chat: CHAT, text } });
    const rel = Object.values(t.state.releases)[0];
    return { rel, id: rel.id };
}

test('/release: сообщение на каждую задачу, один @-тег на тестировщика, секция без тестировщика предупреждена', async () => {
    const t = setup();
    const { rel } = await startRelease(t);

    assert.equal(rel.tasks.length, 4);
    const [sn1, sn2, pt, zz] = rel.tasks;
    const sentTexts = t.sent('sendMessage').map((p) => p.text);
    const sn1Msg = sentTexts.find((x) => x.includes('SN-561'));
    const sn2Msg = sentTexts.find((x) => x.includes('SN-543'));
    assert.match(sn1Msg, /@dzabirovwork/);
    assert.doesNotMatch(sn2Msg, /@dzabirovwork/); // второй задаче того же тестировщика — без пинга
    // у тестировщика две задачи — в каждой видно, какая по счёту; у единственной задачи номера нет
    assert.match(sn1Msg, /задача 1 из 2/);
    assert.match(sn2Msg, /задача 2 из 2/);
    assert.doesNotMatch(sentTexts.find((x) => x.includes('PTOPA-335')), /задача \d из/);
    assert.ok(sn1.messageId && sn2.messageId && pt.messageId);
    assert.equal(zz.messageId, undefined);
    assert.ok(sentTexts.some((x) => x.includes('Не найден тестировщик для: ZZ-1') && x.includes('проект ZZ')));
});

test('смешанная секция: задачи разных проектов уходят своим тестировщикам, EW без владельца', async () => {
    const t = setup();
    const { rel } = await startRelease(
        t,
        `Релиз\n\nEO Admin and Integration (3 задачи)\n\n[EJ-697](https://j/EJ-697) — Раздел\nИсполнитель: Далер\n[CNOO-501](https://j/CNOO-501) — Договор\n[EW-282](https://j/EW-282) — Офер\n`,
    );
    assert.deepEqual(rel.tasks.map((x) => x.tester?.username ?? null), ['yermadam', 'sadafqa', null]);
    assert.match(t.sent('sendMessage').find((p) => p.text.includes('EJ-697')).text, /@yermadam/);
    assert.match(t.sent('sendMessage').find((p) => p.text.includes('CNOO-501')).text, /@sadafqa/);
    assert.ok(t.sent('sendMessage').some((p) => p.text.includes('проект EW')));
    const summary = t.sent('editMessageText').filter((p) => p.message_id === rel.summaryMessageId).at(-1).text;
    // в сводке ключи — ссылки на сообщения задач
    assert.match(summary, /Damir Yermanov: ⏳ <a href="https:\/\/t\.me\/c\/\d+\/\d+">EJ-697<\/a>/);
});

test('✅ открывает force_reply, вложение-ответ подтверждает задачу и сжимает сообщение', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t);
    const task = rel.tasks[0];

    await t.press(DALER, `r:${id}:0:ok`);
    assert.equal(task.status, 'await');
    const prompt = t.sent('sendMessage').find((p) => p.reply_markup?.force_reply);
    assert.ok(prompt, 'ожидался force_reply');
    assert.match(prompt.text, /@dzabirovwork/);

    // подсказка отвечает на сообщение задачи и называет её целиком, а не одним ключом
    assert.equal(prompt.reply_parameters.message_id, task.messageId);
    assert.match(prompt.text, /SN-561/);
    assert.match(prompt.text, /Отбор счетов/);
    assert.match(prompt.text, /задача 1 из 2/);

    const promptId = task.promptId;
    await t.photo(DALER, task.promptId);
    assert.equal(task.status, 'ok');
    assert.equal(task.media.length, 1);
    // подсказку не удаляем — у вложения должна остаться читаемая цитата; она становится подтверждением
    assert.equal(t.sent('deleteMessage').length, 0);
    const settled = t.sent('editMessageText').filter((p) => p.message_id === promptId).at(-1);
    assert.match(settled.text, /✅.*SN-561/s);
    assert.match(settled.text, /Вложений: 1/);
    const edit = t.sent('editMessageText').filter((p) => p.message_id === task.messageId).at(-1);
    assert.match(edit.text, /Протестировано/);
    assert.doesNotMatch(edit.text, /Исполнитель/); // сжатый вид
});

test('новому участнику бот отправляет приветствие с памяткой; ботов не приветствует', async () => {
    const t = setup();
    await t.app.bot.handleUpdate({
        update_id: 5000,
        message: {
            message_id: 7, date: 0, chat: CHAT, from: ADMIN,
            new_chat_members: [{ id: 50, is_bot: false, first_name: 'Newbie', username: 'newqa' }, { id: 51, is_bot: true, first_name: 'SomeBot' }],
        },
    });
    const text = t.sent('sendMessage').at(-1).text;
    assert.match(text, /Добро пожаловать, @newqa/);
    assert.match(text, /Как работать с ботом/);
    assert.doesNotMatch(text, /SomeBot/);

    const before = t.sent('sendMessage').length;
    await t.app.bot.handleUpdate({ update_id: 5001, message: { message_id: 8, date: 0, chat: CHAT, from: ADMIN, new_chat_members: [{ id: 51, is_bot: true, first_name: 'SomeBot' }] } });
    assert.equal(t.sent('sendMessage').length, before);

    await t.command(ADMIN, '/welcome');
    assert.match(t.sent('sendMessage').at(-1).text, /Добро пожаловать, @admin_qa/);
});

test('админ по username может запускать релиз, посторонний — нет', async () => {
    const odil = { id: 77, username: 'Odiljon_95', first_name: 'Odil' }; // регистр username не важен
    const stranger = { id: 99, username: 'someone', first_name: 'X' };

    const denied = setup({ adminUsernames: ['odiljon_95'] });
    await denied.command(stranger, '/release', { reply_to_message: { message_id: 500, date: 0, chat: CHAT, text: LIST } });
    assert.equal(Object.keys(denied.state.releases).length, 0);

    const allowed = setup({ adminUsernames: ['odiljon_95'] });
    await allowed.command(odil, '/release', { reply_to_message: { message_id: 500, date: 0, chat: CHAT, text: LIST } });
    assert.equal(Object.keys(allowed.state.releases).length, 1);
});

test('чужой тестировщик не может нажать кнопку чужой задачи', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t);
    await t.press(AISHA, `r:${id}:0:ok`);
    assert.equal(rel.tasks[0].status, 'pending');
    assert.equal(t.sent('answerCallbackQuery').at(-1).show_alert, true);
});

test('вложение без Reply: берётся единственная задача в ожидании, иначе подсказка', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t);

    await t.photo(DALER, null); // ничего не ждём — подсказка
    assert.match(t.sent('sendMessage').at(-1).text, /Нажмите ✅/);

    await t.press(DALER, `r:${id}:0:ok`);
    await t.photo(DALER, null);
    assert.equal(rel.tasks[0].status, 'ok');

    await t.press(DALER, `r:${id}:1:ok`);
    await t.photo(DALER, null, 'готово SN-543'); // ключ в подписи
    assert.equal(rel.tasks[1].status, 'ok');
});

test('❌ запрашивает причину и сохраняет её; ➖ закрывает без вложения', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t);

    await t.press(DALER, `r:${id}:1:bad`);
    const task = rel.tasks[1];
    assert.equal(task.status, 'bad');
    await t.text(DALER, task.reasonPromptId, 'Не открывается раздел');
    assert.equal(task.reason, 'Не открывается раздел');
    assert.match(t.sent('editMessageText').filter((p) => p.message_id === rel.summaryMessageId).at(-1).text, /Не открывается раздел/);

    await t.press(DALER, `r:${id}:0:na`);
    assert.equal(rel.tasks[0].status, 'na');
});

test('финал: пока есть непройденные — предупреждение; после исправления — релиз закрыт и отчёт', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t, LIST.replace(/Неизвестная команда[\s\S]*$/, ''));

    await t.press(DALER, `r:${id}:0:na`);
    await t.press(DALER, `r:${id}:1:bad`);
    await t.press(AISHA, `r:${id}:2:na`);
    assert.match(t.sent('sendMessage').at(-1).text, /не пройдены/);
    assert.equal(rel.closed, undefined);

    await t.press(DALER, `r:${id}:1:reset`);
    await t.press(DALER, `r:${id}:1:na`);
    assert.equal(rel.closed, true);
    const texts = t.sent('sendMessage').map((p) => p.text);
    assert.ok(texts.some((x) => x.includes('можно выпускать')));
    assert.ok(texts.some((x) => x.includes('Отчёт') && x.includes('Не требуют теста')));
});

test('/assign и /reload назначают тестировщика для секции без владельца', async () => {
    const t = setup();
    const { rel } = await startRelease(t);
    const zz = rel.tasks[3];

    await t.command(ADMIN, '/assign ZZ-1 @aishabb21');
    assert.equal(zz.tester.username, 'aishabb21');
    assert.ok(zz.messageId, 'сообщение задачи должно быть опубликовано');
});

test('срок: эскалация руководителю один раз; напоминание уходит в личку, если тестировщик нажал /start', async () => {
    const t = setup();
    const { rel } = await startRelease(t, LIST.replace(/Неизвестная команда[\s\S]*$/, ''));

    // Daler написал боту в личку
    await t.app.bot.handleUpdate({ update_id: 999, message: { message_id: 1, date: 0, chat: { id: 11, type: 'private' }, from: DALER, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } });

    rel.lastRemindAt = 0;
    await t.app.tick(Date.now());
    const dm = t.sent('sendMessage').find((p) => p.chat_id === 11 && p.text.includes('Ждём подтверждение'));
    assert.ok(dm, 'напоминание Daler должно уйти в личку');
    const group = t.sent('sendMessage').filter((p) => p.chat_id === CHAT.id && p.text.startsWith('🔔'));
    assert.match(group.at(-1).text, /@aishabb21/); // у Aisha личного чата нет — напоминаем в группе
    assert.doesNotMatch(group.at(-1).text, /@dzabirovwork/);

    rel.deadlineAt = Date.now() - 1000;
    await t.app.tick(Date.now());
    await t.app.tick(Date.now());
    const escalations = t.sent('sendMessage').filter((p) => p.text.startsWith('⏰'));
    assert.equal(escalations.length, 1);
    assert.match(escalations[0].text, /@rm_boss/);
});

test('утренняя сводка админам: раз в рабочий день после 09:30, не в день создания и не в выходные', async () => {
    const t = setup({ digestTime: '09:30' });
    const { rel } = await startRelease(t, LIST.replace(/Неизвестная команда[\s\S]*$/, ''));
    const mon10 = Date.UTC(2026, 10, 2, 5, 0); // понедельник 10:00 по Душанбе
    const DAY = 86_400_000;
    rel.createdAtMs = mon10 - 2 * DAY;
    const digests = () => t.sent('sendMessage').filter((p) => p.text.startsWith('☀️'));

    await t.app.tick(mon10);
    assert.equal(digests().length, 1);
    assert.equal(digests()[0].chat_id, ADMIN.id); // лично админу

    await t.app.tick(mon10 + 60_000); // в тот же день повторно — нет
    await t.app.tick(mon10 + DAY - 2 * 3_600_000); // вторник 08:00 — рано
    assert.equal(digests().length, 1);
    await t.app.tick(mon10 + DAY); // вторник 10:00
    assert.equal(digests().length, 2);
    await t.app.tick(mon10 + 5 * DAY); // суббота
    assert.equal(digests().length, 2);
});

test('сводка в день создания релиза не шлётся', async () => {
    const t = setup({ digestTime: '09:30' });
    const { rel } = await startRelease(t);
    const mon10 = Date.UTC(2026, 10, 2, 5, 0);
    rel.createdAtMs = mon10 - 3_600_000;
    await t.app.tick(mon10);
    assert.equal(t.sent('sendMessage').filter((p) => p.text.startsWith('☀️')).length, 0);
});

test('/export отправляет CSV-файл; формулы в ячейках обезвреживаются', async () => {
    const t = setup();
    const { rel } = await startRelease(t);
    await t.command(ADMIN, '/export');
    const doc = t.sent('sendDocument').at(-1);
    assert.ok(doc.document instanceof InputFile);
    assert.match(doc.caption, /EO Core Release/);

    const csv = releasesToCsv([rel], { link: () => null, tz: 'Asia/Dushanbe' });
    assert.ok(csv.startsWith('﻿"Релиз";"Дата"'));
    assert.match(csv, /"Сбережения и накопления";"SN-561";"Отбор счетов"/);
    assert.match(csv, /"Без тестировщика"/); // ZZ-1

    const evil = { id: 'a', title: 'T', createdAtMs: 0, tasks: [{ section: 'S', key: null, lines: ['=HYPERLINK("x")'], tester: { name: 'N' }, status: 'pending' }] };
    assert.match(releasesToCsv([evil], { link: () => null, tz: 'UTC' }), /"'=HYPERLINK/);
});

test('/stats и computeStats: счётчики по тестировщикам, среднее время и доля отказов по командам', async () => {
    const tester = { name: 'Daler' };
    const rel = {
        tasks: [
            { section: 'Лояльность', tester, status: 'ok', postedAt: 0, at: 90 * 60_000 },
            { section: 'Лояльность', tester, status: 'ok', postedAt: 0, at: 30 * 60_000 },
            { section: 'Лояльность', tester, status: 'bad' },
            { section: 'CVM', tester, status: 'pending' },
            { section: 'CVM', tester: null, status: 'pending' }, // без тестировщика не считается
        ],
    };
    const stats = computeStats([rel]);
    assert.equal(stats.people[0].total, 4);
    const text = renderStats(stats);
    assert.match(text, /Daler — 4: ✅2 ❌1 ➖0 ⏳1, в среднем 1 ч 0 мин/);
    assert.match(text, /Лояльность — 3 задач, не пройдено 1 \(33%\)/);

    const t = setup();
    await startRelease(t);
    await t.command(ADMIN, '/stats');
    assert.match(t.sent('sendMessage').at(-1).text, /Статистика/);
});

test('два тестировщика на одном проекте: задачи делятся поровну', async () => {
    const t = setup();
    const { rel } = await startRelease(
        t,
        'Релиз\n\nEskhata Merchant Core (4 задачи)\n\n[EMC-1](https://j/1) — a\n[EMC-2](https://j/2) — b\n[EMC-3](https://j/3) — c\n[EMC-4](https://j/4) — d\n',
    );
    assert.deepEqual(rel.tasks.map((x) => x.tester.username), ['FaridmehrQA', 'shahnoza_qa', 'FaridmehrQA', 'shahnoza_qa']);
});

test('копия состояния: файл по дате, хранятся только последние keep штук', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-backup-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, '{"releases":{}}');
    const backupDir = join(dir, 'backup');
    const url = pathToFileURL(backupDir + sep);
    backupState({ keep: 2, file: pathToFileURL(file), dir: url });
    for (const old of ['2020-01-01', '2020-01-02', '2020-01-03']) writeFileSync(join(backupDir, `state-${old}.json`), '{}');

    const name = backupState({ keep: 2, file: pathToFileURL(file), dir: url });
    const left = readdirSync(backupDir).sort();
    assert.equal(left.length, 2);
    assert.ok(left.includes(name));
    assert.ok(left.includes('state-2020-01-03.json'));
});

// ---------- /addtester и /removetester ----------
// "файл" testers.json в памяти: бот читает его перед правкой и сохраняет после
function withStore() {
    let store = JSON.parse(JSON.stringify(testers));
    return {
        get store() { return store; },
        opts: {
            testers: JSON.parse(JSON.stringify(store)),
            loadTesters: () => JSON.parse(JSON.stringify(store)),
            saveTesters: (list) => { store = JSON.parse(JSON.stringify(list)); },
        },
    };
}
const lastText = (t) => t.sent('sendMessage').at(-1).text;

test('/addtester @user KEY | Секция: добавляет в файл и сразу назначает задачи релиза без тестировщика', async () => {
    const f = withStore();
    const t = setup(f.opts);
    const { rel } = await startRelease(t, 'Релиз\n\nEO Admin and Integration (1 задача)\n\n[EW-282](https://j/EW-282) — Офер\n');
    assert.equal(rel.tasks[0].tester, null);

    await t.command(ADMIN, '/addtester @ew_tester EW, CVM | Админ и интеграция; EO Admin');
    const added = f.store.find((x) => x.username === 'ew_tester');
    assert.deepEqual(added, { name: 'ew_tester', username: 'ew_tester', titles: ['Админ и интеграция', 'EO Admin'], projects: ['EW', 'CVM'] });
    assert.equal(rel.tasks[0].tester.username, 'ew_tester'); // задача EW-282 назначена и опубликована
    assert.ok(rel.tasks[0].messageId);
    assert.match(lastText(t), /Добавлен @ew_tester.*Назначено задач текущего релиза: 1/);
});

test('/addtester для существующего дополняет проекты и секции, не создавая дубликат', async () => {
    const f = withStore();
    const t = setup(f.opts);
    const before = f.store.length;
    await t.command(ADMIN, '/addtester @yermadam ej, EA | Новая секция');
    assert.equal(f.store.length, before);
    const entry = f.store.find((x) => x.username === 'yermadam');
    assert.deepEqual(entry.projects, ['EJ', 'EA']);
    assert.deepEqual(entry.titles, ['Junior', 'Новая секция']);
    assert.match(lastText(t), /Обновлён/);
});

test('/addtester ответом на сообщение человека берёт его ID и имя (подходит, если нет username)', async () => {
    const f = withStore();
    const t = setup(f.opts);
    await t.command(ADMIN, '/addtester KYC', { reply_to_message: { message_id: 9, date: 0, chat: CHAT, from: { id: 555, is_bot: false, first_name: 'Нари' } } });
    assert.deepEqual(f.store.at(-1), { name: 'Нари', userId: 555, titles: [], projects: ['KYC'] });

    // найденный по userId тестировщик получает задачи, а кнопки ему доступны
    const { rel, id } = await startRelease(t, 'Релиз\n\nKYC (1 задача)\n\n[KYC-1](https://j/KYC-1) — Что-то\n');
    await t.press({ id: 555, first_name: 'Нари' }, `r:${id}:0:na`);
    assert.equal(rel.tasks[0].status, 'na');
});

test('/addtester: кривой username, кривой ключ проекта и пустая команда — ошибка, файл не меняется', async () => {
    const f = withStore();
    const t = setup(f.opts);
    const snapshot = JSON.stringify(f.store);

    await t.command(ADMIN, '/addtester @Наргис RKO');
    assert.match(lastText(t), /не похоже на username/);
    await t.command(ADMIN, '/addtester @good_user ключ-1');
    assert.match(lastText(t), /выглядит странно/);
    await t.command(ADMIN, '/addtester @good_user');
    assert.match(lastText(t), /Формат: \/addtester/);
    assert.equal(JSON.stringify(f.store), snapshot);
});

test('/addtester и /removetester доступны только админам', async () => {
    const f = withStore();
    const t = setup(f.opts);
    const snapshot = JSON.stringify(f.store);
    await t.command({ id: 99, username: 'stranger', first_name: 'X' }, '/addtester @hacker_qa EJ');
    await t.command({ id: 99, username: 'stranger', first_name: 'X' }, '/removetester @yermadam');
    assert.equal(JSON.stringify(f.store), snapshot);
});

test('/removetester убирает все записи человека и предупреждает об его открытых задачах', async () => {
    const f = withStore();
    const t = setup(f.opts);
    await startRelease(t, LIST.replace(/Неизвестная команда[\s\S]*$/, ''));

    await t.command(ADMIN, '/removetester @dzabirovwork');
    assert.ok(!f.store.some((x) => x.username === 'dzabirovwork'));
    assert.match(lastText(t), /Удалён @dzabirovwork/);
    assert.match(lastText(t), /открытые задачи.*SN-561.*SN-543/s); // остались за ним — просим переназначить

    await t.command(ADMIN, '/removetester @dzabirovwork');
    assert.match(lastText(t), /Не нашёл/);
});

test('бот работает в нескольких разрешённых группах, остальные игнорирует; релизы у групп независимы', async () => {
    const OTHER = { id: -1009999999999, type: 'supergroup', title: 'Other team' };
    const STRANGER = { id: -1008888888888, type: 'supergroup', title: 'Stranger' };
    const t = setup({ allowedChatIds: [String(CHAT.id), String(OTHER.id)] });
    const release = (chat) =>
        t.app.bot.handleUpdate({
            update_id: Math.floor(Math.random() * 1e9),
            message: { message_id: 1, date: 0, chat, from: ADMIN, text: '/release', entities: [{ type: 'bot_command', offset: 0, length: 8 }], reply_to_message: { message_id: 5, date: 0, chat, text: LIST } },
        });

    await release(CHAT);
    await release(OTHER);
    await release(STRANGER); // группа не из списка — молча игнорируется
    const rels = Object.values(t.state.releases);
    assert.deepEqual(rels.map((r) => r.chatId).sort(), [CHAT.id, OTHER.id].sort());
    assert.equal(rels.length, 2);
    assert.ok(rels.every((r) => !r.closed)); // релиз второй группы не закрыл релиз первой
});

test('/release без заголовков секций: группирует по проектам и объясняет это', async () => {
    const t = setup();
    const { rel } = await startRelease(t, '[SN-561] - Лимиты\n[PTOPA-335] - Кэшбэк');
    assert.equal(rel.tasks.length, 2);
    assert.deepEqual(rel.tasks.map((x) => x.section), ['SN', 'PTOPA']);
    assert.ok(t.sent('sendMessage').some((p) => p.text.includes('сгруппировал задачи по проектам')));
});

test('/release без единой задачи показывает пример формата', async () => {
    const t = setup();
    await t.command(ADMIN, '/release', { reply_to_message: { message_id: 500, date: 0, chat: CHAT, text: 'просто текст' } });
    assert.ok(t.sent('sendMessage').some((p) => p.text.includes('Бот понимает строки с ключом Jira')));
});

test('/exclude убирает задачу из ожидания, /live не упоминает её и тегает тестировщиков', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t);
    await t.command(ADMIN, '/exclude SN-543');
    assert.equal(rel.tasks[1].status, 'excluded');

    // пока есть неотвеченные задачи — /live предупреждает
    await t.command(ADMIN, '/live');
    assert.ok(t.sent('sendMessage').at(-1).text.includes('Не все задачи закрыты'));

    await t.press(DALER, `r:${id}:0:na`);
    await t.press(AISHA, `r:${id}:2:na`);
    await t.command(ADMIN, '/live force');
    const live = t.sent('sendMessage').at(-1).text;
    assert.match(live, /Коллеги, сервер переключен/);
    assert.match(live, /сегодняшнего релиза/);
    assert.match(live, /@dzabirovwork/);
    assert.match(live, /SN-561/);
    assert.doesNotMatch(live, /SN-543/);
});

test('список текстом без команды: бот предлагает кнопку и создаёт релиз по нажатию', async () => {
    const t = setup({ defaultDeadline: '17:00' });
    await t.plain(DALER, LIST); // не админ — молчим
    await t.plain(ADMIN, 'привет');
    assert.equal(t.sent('sendMessage').length, 0);

    await t.plain(ADMIN, LIST);
    const offer = t.sent('sendMessage').at(-1);
    assert.match(offer.text, /Нашёл 4 задач/);
    assert.deepEqual(offer.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['o:go', 'o:dl', 'o:no']);

    await t.press(DALER, 'o:go', LIST); // кнопка только для админов
    assert.equal(Object.keys(t.state.releases).length, 0);
    await t.press(ADMIN, 'o:dl', LIST);
    const rel = Object.values(t.state.releases)[0];
    assert.equal(rel.tasks.length, 4);
    assert.ok(rel.deadlineAt > Date.now());
});

test('после «можно выпускать» кнопка объявляет о боевом; незакрытые задачи можно исключить кнопкой', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t, '[SN-561] - a\n[SN-543] - b');
    await t.press(DALER, `r:${id}:0:na`);
    await t.press(DALER, `r:${id}:1:na`);
    // в группе — сообщение без кнопки, кнопка уходит админу лично
    const group = t.sent('sendMessage').find((p) => p.chat_id === CHAT.id && /можно выпускать/.test(p.text));
    assert.equal(group.reply_markup, undefined);
    const dm = t.sent('sendMessage').find((p) => p.chat_id === ADMIN.id && /полностью подтверждён/.test(p.text));
    assert.equal(dm.reply_markup.inline_keyboard[0][0].callback_data, `l:${id}:go`);

    await t.press(ADMIN, `l:${id}:go`);
    // сначала админ видит список задач и ничего не уходит в группу
    assert.match(t.sent('sendMessage').at(-1).text, /Что войдёт/);
    assert.ok(!rel.liveAt);
    await t.press(ADMIN, `e:${id}:ok`);
    assert.match(t.sent('sendMessage').at(-1).text, /Коллеги, сервер переключен/);
    assert.ok(rel.liveAt);

    const t2 = setup();
    const r2 = await startRelease(t2, '[SN-561] - a\n[SN-543] - b');
    await t2.press(DALER, `r:${r2.id}:0:na`);
    await t2.command(ADMIN, '/live');
    assert.deepEqual(t2.sent('sendMessage').at(-1).reply_markup.inline_keyboard.flat().map((b) => b.callback_data), [`l:${r2.id}:exclude`, `l:${r2.id}:force`]);
    await t2.press(ADMIN, `l:${r2.id}:exclude`);
    assert.equal(r2.rel.tasks[1].status, 'excluded');
    await t2.press(ADMIN, `e:${r2.id}:ok`);
    const live = t2.sent('sendMessage').at(-1).text;
    assert.match(live, /сервер переключен/);
    assert.doesNotMatch(live, /SN-543/);
});

test('открытый релиз: список текстом предлагает «Добавить в текущий», повторы по ключу пропускаются', async () => {
    const t = setup();
    const { rel } = await startRelease(t, '[SN-561] - a\n[SN-543] - b');
    const NEW = '[SN-543] - b\n[PTOPA-335] - c';

    await t.plain(ADMIN, '[PTOPA-335] - c'); // даже одна задача — предложение добавить
    const offer = t.sent('sendMessage').at(-1);
    assert.deepEqual(offer.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['o:add', 'o:go', 'o:no']);

    await t.press(ADMIN, 'o:add', NEW);
    assert.equal(Object.keys(t.state.releases).length, 1); // новый релиз не создан
    assert.deepEqual(rel.tasks.map((x) => x.key), ['SN-561', 'SN-543', 'PTOPA-335']);
    assert.ok(t.sent('sendMessage').some((p) => /пропустил: SN-543/.test(p.text)));

    await t.press(ADMIN, 'o:add', NEW); // повторное добавление ничего не меняет
    assert.equal(rel.tasks.length, 3);
    assert.ok(t.sent('sendMessage').some((p) => /Новых задач нет/.test(p.text)));
});

test('🚧 «Задача не готова»: не ждём, не напоминаем, не объявляем; автору списка — сообщение, в отчёте отдельный блок', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t, '[SN-561] - a\n[SN-543] - b');
    const kb = t.sent('sendMessage').find((p) => p.reply_markup?.inline_keyboard)?.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(kb.includes(`r:${id}:0:notready`));

    await t.press(DALER, `r:${id}:0:notready`);
    assert.equal(rel.tasks[0].status, 'notready');
    assert.ok(t.sent('sendMessage').some((p) => /не готова/.test(p.text) && /не готова/.test(p.text)));

    await t.press(DALER, `r:${id}:1:na`); // последняя задача закрыта — релиз завершается
    assert.ok(rel.closed);
    assert.ok(t.sent('sendMessage').some((p) => /Не готовы/.test(p.text) && /SN-561/.test(p.text)));

    await t.press(ADMIN, `l:${id}:go`);
    await t.press(ADMIN, `e:${id}:ok`);
    const live = t.sent('sendMessage').at(-1).text;
    assert.doesNotMatch(live, /SN-561/);
    assert.match(live, /SN-543/);
});

test('после «не готова» админ получает кнопку «Исключить из релиза»; чужой нажать не может', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t, '[SN-561] - a\n[SN-543] - b');
    await t.press(DALER, `r:${id}:0:notready`);
    const dm = t.sent('sendMessage').find((p) => p.chat_id === ADMIN.id && /Убрать её из релиза/.test(p.text));
    const data = dm.reply_markup.inline_keyboard[0][0].callback_data;
    assert.equal(data, `x:${id}:0`);

    await t.press(DALER, data); // не админ
    assert.equal(rel.tasks[0].status, 'notready');
    await t.press(ADMIN, data);
    assert.equal(rel.tasks[0].status, 'excluded');
});

test('/my показывает только мои открытые задачи; /find ищет задачу по ключу и по тексту в истории релизов', async () => {
    const t = setup();
    const { id } = await startRelease(t);
    await t.press(DALER, `r:${id}:0:na`); // SN-561 закрыта, SN-543 открыта

    await t.command(DALER, '/my');
    const mine = t.sent('sendMessage').at(-1).text;
    assert.match(mine, /Ваши открытые задачи \(1\)/);
    assert.match(mine, /SN-543/);
    assert.doesNotMatch(mine, /SN-561/);

    await t.command(AISHA, '/my');
    assert.doesNotMatch(t.sent('sendMessage').at(-1).text, /SN-543/);

    await t.command(DALER, '/find SN-561'); // искать может любой участник
    const found = t.sent('sendMessage').at(-1).text;
    assert.match(found, /Найдено: 1/);
    assert.match(found, /EO Core Release 29\/10\/2026/);
    assert.match(found, /Не требует теста/);

    await t.command(DALER, '/find перевод');
    assert.match(t.sent('sendMessage').at(-1).text, /SN-543/);
    await t.command(DALER, '/find QQ-1');
    assert.match(t.sent('sendMessage').at(-1).text, /не встречается/);
    await t.command(DALER, '/find');
    assert.match(t.sent('sendMessage').at(-1).text, /Формат: \/find/);
});

test('если тестировщик писал боту /start, подсказка про вложение уходит в личку, а файл копируется в группу под задачу', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t, '[SN-561] - a\n[SN-543] - b');
    await t.dm(DALER, { text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
    const before = t.sent('sendMessage').length;

    await t.press(DALER, `r:${id}:0:ok`);
    const prompts = t.sent('sendMessage').slice(before);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].chat_id, DALER.id); // подсказка в личке, в группе тишина
    assert.ok(prompts[0].reply_markup.force_reply);
    assert.equal(rel.tasks[0].promptChat, DALER.id);
    assert.match(t.sent('editMessageText').filter((p) => p.message_id === rel.tasks[0].messageId).at(-1).text, /в личных сообщениях/);

    // файл без Reply: ждётся ровно одна задача — бот привязывает сам и копирует в группу
    await t.dm(DALER, { photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }] });
    assert.equal(rel.tasks[0].status, 'ok');
    const copy = t.sent('copyMessage').at(-1);
    assert.equal(copy.chat_id, CHAT.id);
    assert.equal(copy.reply_parameters.message_id, rel.tasks[0].messageId);
    assert.equal(rel.tasks[0].media.length, 1);
    assert.notEqual(rel.tasks[0].media[0], undefined);
    assert.equal(rel.tasks[0].promptChat, DALER.id);
});

test('❌ при личке: причину просят в личке (можно без Reply), автору списка — короткое уведомление в группе', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t, '[SN-561] - a\n[SN-543] - b');
    await t.dm(DALER, { text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] });

    await t.press(DALER, `r:${id}:0:bad`);
    const sent = t.sent('sendMessage');
    assert.ok(sent.some((p) => p.chat_id === DALER.id && /Напишите причину/.test(p.text)));
    assert.ok(sent.some((p) => p.chat_id === CHAT.id && /не пройдена/.test(p.text) && !p.reply_markup?.force_reply));

    await t.dm(DALER, { text: 'Кнопка не нажимается' });
    assert.equal(rel.tasks[0].reason, 'Кнопка не нажимается');

    // тестировщик без /start получает подсказку в группе, как раньше
    await t.press(AISHA, `r:${id}:1:ok`).catch(() => {}); // задача Daler — чужая, ничего не меняется
    assert.equal(rel.tasks[1].status, 'pending');
});

test('тестировщик с /start: карточки задач в личке, в группе одно сообщение; файл копируется в группу с подписью задачи', async () => {
    const t = setup();
    await t.dm(DALER, { text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
    const { rel, id } = await startRelease(t, '[SN-561] - Отбор счетов\n[SN-543] - Перевод\n[PTOPA-335] - Кэшбэк');
    const [a, b, c] = rel.tasks;

    // Daler (SN) — карточки в личке; Aisha (PTOPA) не писала боту — карточка в группе
    assert.equal(a.cardChat, DALER.id);
    assert.equal(b.cardChat, DALER.id);
    assert.equal(c.cardChat, undefined);
    assert.equal(t.sent('sendMessage').filter((p) => p.chat_id === DALER.id && p.reply_markup?.inline_keyboard).length, 2);
    assert.ok(!t.sent('sendMessage').some((p) => p.chat_id === CHAT.id && /SN-561/.test(p.text) && p.reply_markup?.inline_keyboard));
    const notice = t.sent('sendMessage').find((p) => p.chat_id === CHAT.id && /отправлены в личные сообщения/.test(p.text));
    assert.match(notice.text, /@dzabirovwork — 2/);
    assert.match(notice.text, /@aishabb21/);
    assert.match(notice.text, /\/start/);

    // ссылки на карточки в личке в группе не строим
    const summary = t.sent('editMessageText').at(-1).text;
    assert.doesNotMatch(summary, new RegExp(`href="[^"]*/${a.messageId}">SN-561`));

    // ✅ в личке: подсказка там же ответом на карточку; файл → копия в группу с подписью задачи, без Reply
    await t.press(DALER, `r:${id}:0:ok`);
    assert.equal(a.promptChat, DALER.id);
    await t.dm(DALER, { photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }], caption: 'iOS 17' });
    assert.equal(a.status, 'ok');
    const copy = t.sent('copyMessage').at(-1);
    assert.equal(copy.chat_id, CHAT.id);
    assert.equal(copy.reply_parameters, undefined);
    assert.match(copy.caption, /SN-561/);
    assert.match(copy.caption, /iOS 17/);
    assert.equal(a.media.length, 1);

    // ❌ у карточки в личке: в группе автору — уведомление без ответа на несуществующую карточку
    await t.press(DALER, `r:${id}:1:bad`);
    const head = t.sent('sendMessage').filter((p) => p.chat_id === CHAT.id && /не пройдена/.test(p.text)).at(-1);
    assert.equal(head.reply_parameters, undefined);
});

test('TASKS_IN_DM=false: задачи остаются в группе, как раньше', async () => {
    const t = setup({ tasksInDm: false });
    await t.dm(DALER, { text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
    const { rel } = await startRelease(t, '[SN-561] - a\n[SN-543] - b');
    assert.equal(rel.tasks[0].cardChat, undefined);
    assert.ok(t.sent('sendMessage').some((p) => p.chat_id === CHAT.id && /SN-561/.test(p.text) && p.reply_markup?.inline_keyboard));
});

test('/who: кто что не закрыл, кнопка «напомнить» одному тестировщику; чужой нажать не может', async () => {
    const t = setup();
    const { id } = await startRelease(t, '[SN-561] - a\n[SN-543] - b\n[PTOPA-335] - c');
    await t.command(DALER, '/who'); // не админ — молчим
    const before = t.sent('sendMessage').length;
    await t.command(ADMIN, '/who');
    const who = t.sent('sendMessage').at(-1);
    assert.match(who.text, /Кто что не закрыл/);
    assert.ok(who.text.indexOf('Daler') < who.text.indexOf('Aisha')); // у кого больше открытых — выше
    assert.doesNotMatch(who.text, /@dzabirovwork/); // обзор без тегов
    const buttons = who.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(buttons, [`w:${id}:dzabirovwork`, `w:${id}:aishabb21`, `w:${id}:all`]);

    await t.press(DALER, `w:${id}:all`);
    assert.equal(t.sent('sendMessage').filter((p) => p.text.startsWith('🔔')).length, 0);
    await t.press(ADMIN, `w:${id}:aishabb21`);
    const reminder = t.sent('sendMessage').filter((p) => p.text.startsWith('🔔')).at(-1).text;
    assert.match(reminder, /PTOPA-335/);
    assert.doesNotMatch(reminder, /SN-561/);
    assert.ok(before >= 0);
});

test('предупреждение до срока: за 3 часа и за час админу лично, повторно в то же окно — нет', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t, '[SN-561] - a\n[PTOPA-335] - b');
    const now = Date.UTC(2026, 10, 2, 5, 0); // понедельник 10:00 по Душанбе
    rel.deadlineAt = now + 2.5 * 3_600_000;
    const warns = () => t.sent('sendMessage').filter((p) => p.chat_id === ADMIN.id && p.text.startsWith('⏳'));

    await t.app.tick(now); // осталось 2.5 ч — окно «3 часа»
    assert.equal(warns().length, 1);
    assert.match(warns()[0].text, /Не закрыто задач: 2/);
    assert.equal(warns()[0].reply_markup.inline_keyboard.flat().at(-1).callback_data, `w:${id}:all`);

    await t.app.tick(now + 60_000);
    assert.equal(warns().length, 1);
    await t.app.tick(now + 1.7 * 3_600_000); // осталось ~48 минут — окно «1 час»
    assert.equal(warns().length, 2);
    await t.app.tick(now + 1.8 * 3_600_000);
    assert.equal(warns().length, 2);
});

test('/panel: кнопки статус/срок/закрытие работают только для админа', async () => {
    const t = setup();
    const { rel } = await startRelease(t, '[SN-561] - a\n[PTOPA-335] - b');
    await t.command(DALER, '/panel');
    assert.ok(!t.sent('sendMessage').some((p) => /Панель/.test(p.text)));
    await t.command(ADMIN, '/panel');
    const panel = t.sent('sendMessage').at(-1);
    assert.match(panel.text, /Панель/);
    assert.equal(panel.reply_markup.inline_keyboard.flat().length, 8);

    await t.press(DALER, 'p:stopok');
    assert.equal(rel.closed, undefined);
    await t.press(ADMIN, 'p:setdl:1700');
    assert.ok(rel.deadlineAt > Date.now());
    await t.press(ADMIN, 'p:remind');
    assert.ok(t.sent('sendMessage').some((p) => p.text.startsWith('🔔')));
    await t.press(ADMIN, 'p:stop');
    assert.ok(t.sent('sendMessage').at(-1).reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'p:stopok'));
    await t.press(ADMIN, 'p:stopok');
    assert.equal(rel.closed, true);
});

test('«бот жив»: после простоя админ получает сообщение, быстрый перезапуск не шумит; раз в рабочий день — heartbeat', async () => {
    const t = setup({ heartbeatTime: '09:00' });
    const mon10 = Date.UTC(2026, 10, 2, 5, 0);
    const alive = () => t.sent('sendMessage').filter((p) => p.chat_id === ADMIN.id);

    await t.app.announceStart(mon10); // первый запуск — предыдущего «был жив» нет
    assert.equal(alive().length, 0);
    await t.app.announceStart(mon10 + 5 * 60_000); // быстрый перезапуск
    assert.equal(alive().length, 0);
    await t.app.announceStart(mon10 + 5 * 60_000 + 3 * 3_600_000); // простой 3 часа
    assert.match(alive().at(-1).text, /снова работает/);
    assert.match(alive().at(-1).text, /3 ч/);

    await t.app.tick(mon10 + 4 * 3_600_000);
    assert.match(alive().at(-1).text, /Бот работает/);
    const n = alive().length;
    await t.app.tick(mon10 + 4 * 3_600_000 + 60_000); // в тот же день — нет
    assert.equal(alive().length, n);
});

test('подсказка после создания релиза и «✏️ Переназначить»: список, выбор задачи и тестировщика — только админ', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t, '[SN-561] - a\n[ZZ-1] - b');
    const hint = t.sent('sendMessage').find((p) => p.chat_id === ADMIN.id && /Создано: 2 задачи/.test(p.text));
    assert.match(hint.text, /без тестировщика — 1/);
    const buttons = hint.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(buttons, [`a:${id}:U`, `a:${id}:L`]);

    const zz = rel.tasks.findIndex((x) => x.key === 'ZZ-1');
    await t.press(DALER, `a:${id}:U:${zz}:0`);
    assert.equal(t.sent('answerCallbackQuery').at(-1).show_alert, true);
    assert.ok(!rel.tasks[zz].tester);

    await t.press(ADMIN, `a:${id}:U`);
    assert.match(t.sent('editMessageText').at(-1).text, /Выберите задачу/);
    await t.press(ADMIN, `a:${id}:U:${zz}`);
    assert.match(t.sent('editMessageText').at(-1).text, /Кому передать/);
    await t.press(ADMIN, `a:${id}:U:${zz}:0`);
    assert.equal(rel.tasks[zz].tester.username, testers[0].username);
    assert.match(t.sent('editMessageText').at(-1).text, /Задач без тестировщика нет/);
});

test('/log показывает действия админов; по понедельникам админам приходят итоги недели', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t, '[SN-561] - a\n[ZZ-1] - b');
    await t.press(ADMIN, `a:${id}:U:${rel.tasks.findIndex((x) => x.key === 'ZZ-1')}:0`);
    await t.command(DALER, '/log');
    assert.ok(!t.sent('sendMessage').some((p) => /Последние действия/.test(p.text)));
    await t.command(ADMIN, '/log');
    const log = t.sent('sendMessage').at(-1).text;
    assert.match(log, /создал релиз/);
    assert.match(log, /назначил ZZ-1/);

    const mon10 = Date.UTC(2026, 10, 2, 5, 0);
    const weekly = () => t.sent('sendMessage').filter((p) => p.chat_id === ADMIN.id && /Итоги недели/.test(p.text));
    await t.app.tick(mon10);
    assert.equal(weekly().length, 1);
    await t.app.tick(mon10 + 60_000);
    assert.equal(weekly().length, 1);
});

test('перед объявлением админ убирает задачи кнопками в личке: переключатель, отмена, чужой не может', async () => {
    const t = setup();
    const { rel, id } = await startRelease(t, '[SN-561] - a\n[SN-543] - b');
    await t.press(DALER, `r:${id}:0:na`);
    await t.press(DALER, `r:${id}:1:na`);
    await t.press(ADMIN, `l:${id}:go`);

    await t.press(DALER, `e:${id}:t:1`);
    assert.equal(t.sent('answerCallbackQuery').at(-1).show_alert, true);
    await t.press(ADMIN, `e:${id}:t:1`); // убрали SN-543 (например, на код-ревью)
    const kb = t.sent('editMessageText').at(-1).reply_markup.inline_keyboard.flat();
    assert.ok(kb.some((b) => b.text.startsWith('🚫') && b.text.includes('SN-543')));
    assert.ok(kb.some((b) => /Отправить в группу \(1\)/.test(b.text)));

    await t.press(ADMIN, `e:${id}:no`);
    assert.ok(!rel.liveAt);
    assert.equal(rel.tasks[1].status, 'na');

    await t.press(ADMIN, `l:${id}:go`);
    await t.press(ADMIN, `e:${id}:t:1`);
    await t.press(ADMIN, `e:${id}:ok`);
    const live = t.sent('sendMessage').at(-1).text;
    assert.match(live, /SN-561/);
    assert.doesNotMatch(live, /SN-543/);
    assert.equal(rel.tasks[1].status, 'excluded');
});
