import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { parseRelease, countMismatches, findTestersForTask } from './parser.js';
import { renderTask, renderSummary, renderReport, taskTitle, taskDescription, mention, userMention, esc, time } from './format.js';
import { parseClock, nextOccurrence, localClock } from './deadline.js';
import { releasesToCsv } from './export.js';
import { parseAddTester, parseTesterRef, addOrUpdateTester, isSameTester, ADD_USAGE } from './testers-file.js';
import { computeStats, renderStats, formatDuration } from './stats.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const HOUR = 3_600_000;
const MEDIA = ['message:photo', 'message:video', 'message:document', 'message:animation'];
const FINISHED = ['ok', 'na', 'bad', 'excluded', 'notready'];
// не ждём и не объявляем: задача исключена из релиза или тестировщик отметил, что она не готова
const OUT = ['excluded', 'notready'];

const GUIDE = (bot) =>
    `📌 <b>Как работать с ботом</b>\n\n` +
    `1️⃣ Под вашей задачей кнопки: ✅ Протестировано, ❌ Не пройдена, ➖ Не требует теста и 🚧 Задача не готова.\n` +
    `2️⃣ После ✅ откроется ответ — прикрепите скриншот или видео и отправьте. Задача станет ✅ только после вложения.\n` +
    `   Если вы писали боту /start, подсказка придёт вам в личку: отправьте файл туда, бот сам перенесёт его в группу под вашу задачу.\n` +
    `3️⃣ ❌ — вложение не нужно, напишите причину ответом на сообщение бота (в личке можно просто текстом).\n` +
    `4️⃣ ➖ — для задач, которые нечем или нельзя тестировать (например, backend без интерфейса).\n` +
    `5️⃣ 🚧 — задача не выкачена или ещё не готова к проверке: бот не будет её ждать и сообщит автору списка. Если задача всё же готова — нажмите «↩️ Изменить».\n` +
    `6️⃣ Ошиблись — нажмите «↩️ Изменить».\n` +
    `7️⃣ После сообщения «сервер переключен» сразу проверьте свои задачи на боевом сервере.\n` +
    `8️⃣ /my — список ваших открытых задач со ссылками, /find SN-561 — в каких релизах была задача и чем закончилась.\n` +
    `9️⃣ Один раз напишите @${bot} в личные сообщения команду /start — и задачи с кнопками, подсказки и напоминания будут приходить вам лично, а в группе останется только сводка. Файлы и причины отправляйте боту в личку: файл бот сам перенесёт в группу.`;

const WELCOME = (names, bot) =>
    `👋 Добро пожаловать, ${names}!\n\n` +
    `Это группа тестирования релизов. Как у нас всё устроено:\n` +
    `• Перед релизом Core-команда присылает список задач, а бот делит его на отдельные задачи и отправляет каждому тестировщику его задачи с кнопками (в личку, если вы писали боту /start, иначе в группу). В группе остаётся сводка.\n` +
    `• Ваша работа — отметить результат по каждой своей задаче и приложить подтверждение.\n` +
    `• Когда все задачи закрыты, бот сообщает, что релиз можно выпускать.\n` +
    `• После выката бот объявляет, что сервер переключен, — тогда нужно проверить свои задачи уже на боевом сервере.\n\n` +
    GUIDE(bot);

/**
 * Вся логика бота без побочных эффектов запуска (polling, таймеры) — так её можно проверять тестами.
 * state — объект со всеми релизами, save() сохраняет его после каждого изменения.
 */
export function createApp(opts) {
    const {
        token,
        botInfo,
        adminIds = [],
        adminUsernames = [],
        allowedChatIds = [], // группы, где бот работает; пусто — в любой

        remindEveryMin = 60,
        workHours = [9, 19],
        tz = 'Asia/Dushanbe',
        rmUsernames = [],
        digestTime = '', // "09:30" — когда слать утреннюю сводку админам; пусто — не слать
        tasksInDm = true, // задачи с кнопками — в личку тестировщику (если он писал боту /start), в группе сводка
        adminNotify = 'owner', // 'owner' — служебные сообщения по релизу только тому админу, кто его создал; 'all' — всем админам
        weeklyStats = true, // по понедельникам админам лично — статистика за прошлую неделю
        heartbeatTime = '', // "09:00" — раз в рабочий день писать админам «бот работает»; пусто — не писать
        defaultDeadline = '', // "17:00" — срок для кнопки «Создать до …» при автоопределении списка
        state,
        save,
        loadTesters,
        saveTesters = () => {
            throw new Error('saveTesters не задан');
        },
    } = opts;
    let testers = opts.testers;
    state.dm ||= {}; // личные чаты тестировщиков для напоминаний: { [userId]: { id, username } }

    const bot = new Bot(token, botInfo ? { botInfo } : undefined);
    // Telegram ограничивает ~20 сообщений в минуту в группе — при 429 плагин сам подождёт и повторит
    bot.api.config.use(autoRetry());
    const hintedGroups = new Set(); // чтобы на альбом из N файлов подсказка не приходила N раз

    // ---------- вспомогательное ----------
    const releases = () => Object.values(state.releases).filter((r) => r.tasks);
    const stamp = (r) => r.createdAtMs || parseInt(r.id, 36);
    const activeRelease = (chatId) => releases().find((r) => r.chatId === chatId && !r.closed);
    const latestRelease = (chatId) => releases().filter((r) => r.chatId === chatId).sort((a, b) => stamp(b) - stamp(a))[0];

    // исключённые из релиза задачи не ждём и в итогах не считаем
    const tracked = (rel) => rel.tasks.filter((t) => t.tester && !OUT.includes(t.status));
    // "await" — тестировщик нажал ✅, но ещё не прислал скриншот/видео, поэтому считается неотвеченным
    const pending = (rel) => tracked(rel).filter((t) => t.status === 'pending' || t.status === 'await');
    const label = (task) => task.key || task.section;
    const actor = (u) => (u.username ? `@${u.username}` : u.first_name);
    const testerKey = (t) => t.username?.toLowerCase() || `id:${t.userId}`;

    // Если на проекте несколько тестировщиков, задачи делятся поровну: берём того, у кого сейчас меньше задач в релизе
    const pickTester = (rel, task) => {
        const pool = findTestersForTask(task, testers);
        const load = (t) => rel.tasks.filter((x) => x.tester && testerKey(x.tester) === testerKey(t)).length;
        return pool.reduce((best, t) => (!best || load(t) < load(best) ? t : best), null);
    };

    const chatLink = (rel, id) =>
        id && String(rel.chatId).startsWith('-100') ? `https://t.me/c/${String(rel.chatId).slice(4)}/${id}` : null;
    // карточка задачи может лежать в личке тестировщика (task.cardChat) — тогда ссылки на неё в группе нет
    const cardChatOf = (rel, task) => task.cardChat ?? rel.chatId;
    const taskLink = (rel, task) => {
        const url = task.cardChat ? null : chatLink(rel, task.messageId);
        return url ? `<a href="${url}">${esc(label(task))}</a>` : esc(label(task));
    };

    const isOwnerOf = (u, task) =>
        Boolean(task.tester) &&
        ((u.username && u.username.toLowerCase() === task.tester.username?.toLowerCase()) || u.id === task.tester.userId);
    // Админ — по числовому ID или по username (удобно, когда ID ещё не знаем)
    const isListedAdmin = (u) =>
        adminIds.includes(u.id) || Boolean(u.username && adminUsernames.includes(u.username.toLowerCase()));
    // Действовать по задаче может назначенный тестировщик или админ
    const canAct = (u, task) => isOwnerOf(u, task) || isListedAdmin(u);
    // Если админы не заданы вовсе, команды доступны любому участнику группы
    const isAdmin = (u) => (!adminIds.length && !adminUsernames.length) || isListedAdmin(u);
    // личные чаты админов (по ID или по username, если админ уже писал боту /start)
    const adminDmIds = () => {
        const viaUsername = Object.values(state.dm).filter((d) => d.username && adminUsernames.includes(d.username.toLowerCase()));
        return [...new Set([...adminIds, ...viaUsername.map((d) => d.id)])];
    };
    // Служебные подсказки (настройка testers.json, опечатки в списке) нужны только админам — шлём лично,
    // а если никому не доставить (не писали боту /start), показываем в группе
    // Служебное сообщение по релизу получает только его владелец (кто создал релиз или совершил действие),
    // чтобы админы не мешали друг другу. Если владельцу не доставить — всем админам; если и им нельзя — false
    async function dmAdmins(owner, text, extra = {}) {
        const send = async (ids) => {
            let delivered = 0;
            for (const id of ids) {
                if (await bot.api.sendMessage(id, text, extra).catch(() => null)) delivered++;
            }
            return delivered > 0;
        };
        // создателю релиза не доставить — другим админам не пересылаем (чужие релизы им не нужны), вызывающий код покажет в группе
        if (adminNotify !== 'all' && owner && isListedAdmin(owner)) return send([owner.id]);
        return send(adminDmIds());
    }
    async function tellAdmins(ctx, text) {
        if (!(await dmAdmins(ctx.from, text))) await ctx.reply(text);
    }
    // Журнал действий админов: кто и что сделал (хранится в state, последние 300 записей), смотреть — /log
    function journal(user, text, rel) {
        (state.log ||= []).push({ at: Date.now(), who: user ? actor(user) : 'бот', text, rel: rel?.title });
        if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
    }
    const isAllowed = (ctx) => !allowedChatIds.length || allowedChatIds.includes(String(ctx.chat?.id));
    const guard = (ctx) => isAllowed(ctx) && isAdmin(ctx.from);

    function isWorkingTime(now) {
        const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(now));
        return hour >= workHours[0] && hour < workHours[1];
    }

    const dmChatFor = (tester) =>
        Object.values(state.dm).find(
            (d) => (d.username && d.username.toLowerCase() === tester.username?.toLowerCase()) || d.id === tester.userId,
        )?.id;

    const keyboardFor = (rel, task) => {
        const idx = rel.tasks.indexOf(task);
        if (FINISHED.includes(task.status)) return new InlineKeyboard().text('↩️ Изменить', `r:${rel.id}:${idx}:reset`);
        return new InlineKeyboard()
            .text('✅ Протестировано', `r:${rel.id}:${idx}:ok`)
            .text('❌ Не пройдена', `r:${rel.id}:${idx}:bad`)
            .row()
            .text('➖ Не требует теста', `r:${rel.id}:${idx}:na`)
            .text('🚧 Задача не готова', `r:${rel.id}:${idx}:notready`);
    };

    // Подсказки («прикрепите файл», «напишите причину») живут либо в группе, либо в личке тестировщика
    // (task.promptChat), если он писал боту /start. Само сообщение задачи всегда в группе.
    const promptChatOf = (rel, task) => task.promptChat ?? rel.chatId;
    const dropMessage = (chatId, id) => id && bot.api.deleteMessage(chatId, id).catch(() => {});
    // Подсказку после ответа не удаляем, а превращаем в подтверждение: иначе у вложения остаётся
    // пустая цитата «удалённое сообщение» и не видно, к какой задаче оно относится
    const settlePrompt = (rel, task) => {
        const edit = (id, text) => id && bot.api.editMessageText(promptChatOf(rel, task), id, text, HTML).catch(() => {});
        if (task.status === 'ok') edit(task.promptId, `✅ ${taskTitle(task)}\nВложений: ${task.media.length} — ${esc(task.by)}`);
        if (task.status === 'bad') edit(task.reasonPromptId, `❌ ${taskTitle(task)}\nПричина принята — ${esc(task.by)}`);
    };
    function dropPrompts(rel, task) {
        const chat = promptChatOf(rel, task);
        dropMessage(chat, task.promptId);
        dropMessage(chat, task.reasonPromptId);
        delete task.promptId;
        delete task.reasonPromptId;
        delete task.promptChat;
        delete task.promptDm;
    }

    const summaryText = (rel) => renderSummary(rel, tz, (id) => chatLink(rel, id));
    // "message is not modified" и удалённые сообщения — не ошибки
    const refreshSummary = (rel) => bot.api.editMessageText(rel.chatId, rel.summaryMessageId, summaryText(rel), HTML).catch(() => {});

    // Какая по счёту это задача среди задач того же тестировщика: "задача 2 из 3"
    const position = (rel, task) => {
        const own = rel.tasks.filter((t) => t.tester && testerKey(t.tester) === testerKey(task.tester));
        return { n: own.indexOf(task) + 1, m: own.length };
    };
    const refreshTask = (rel, task) =>
        bot.api
            .editMessageText(cardChatOf(rel, task), task.messageId, renderTask(task, tz, position(rel, task)), {
                ...HTML,
                reply_markup: keyboardFor(rel, task),
            })
            .catch(() => {});

    async function postTask(rel, task, replyTo) {
        task.postedAt = Date.now(); // для статистики: сколько тестировщик отвечал на задачу
        // Тестировщик писал боту /start — карточка с кнопками уходит ему в личку, в группе остаётся сводка.
        // Не получилось (бот заблокирован) или /start не было — публикуем в группе, как раньше.
        const dmId = tasksInDm ? dmChatFor(task.tester) : null;
        if (dmId) {
            task.ping = false; // в личке тег не нужен
            const card = await bot.api
                .sendMessage(dmId, renderTask(task, tz, position(rel, task)), { ...HTML, reply_markup: keyboardFor(rel, task) })
                .catch(() => null);
            if (card) {
                task.cardChat = dmId;
                task.messageId = card.message_id;
                return;
            }
        }
        const key = testerKey(task.tester);
        task.ping = !rel.tasks.some((t) => t !== task && t.ping && t.messageId && !t.cardChat && t.tester && testerKey(t.tester) === key);
        const msg = await bot.api.sendMessage(rel.chatId, renderTask(task, tz, position(rel, task)), {
            ...HTML,
            reply_markup: keyboardFor(rel, task),
            ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        });
        task.messageId = msg.message_id;
    }

    // Группе — одно сообщение вместо потока задач: кому ушли карточки в личку, а кому нужно написать боту /start
    async function announceDelivery(ctx, rel, added) {
        const byTester = new Map();
        for (const t of added.filter((x) => x.tester)) {
            const k = testerKey(t.tester);
            if (!byTester.has(k)) byTester.set(k, { tester: t.tester, dm: 0, group: 0 });
            byTester.get(k)[t.cardChat ? 'dm' : 'group']++;
        }
        const inDm = [...byTester.values()].filter((x) => x.dm);
        if (!inDm.length) return;
        const lines = ['📬 <b>Задачи отправлены в личные сообщения</b>', ...inDm.map((x) => `• ${mention(x.tester)} — ${x.dm}`)];
        const waiting = [...byTester.values()].filter((x) => x.group);
        if (waiting.length) {
            lines.push('', `Задачи ${waiting.map((x) => mention(x.tester)).join(', ')} — в группе выше. Чтобы получать их лично, напишите @${ctx.me.username} команду /start.`);
        }
        await bot.api.sendMessage(rel.chatId, lines.join('\n'), { ...HTML, reply_parameters: { message_id: rel.summaryMessageId } });
    }

    // Публикует по сообщению на каждую задачу; возвращает задачи, для которых не нашёлся тестировщик
    async function postTasks(rel, parsed, sourceMessageId) {
        // сначала добавляем все задачи, потом публикуем: иначе в первом сообщении не знаем, сколько задач у тестировщика
        const added = parsed.sections.flatMap((s) =>
            s.tasks.map((t) => {
                const task = { section: s.title, key: t.key, lines: t.lines, status: 'pending', media: [] };
                task.tester = pickTester(rel, task);
                rel.tasks.push(task);
                return task;
            }),
        );
        for (const task of added.filter((t) => t.tester)) await postTask(rel, task, sourceMessageId);
        return { added, unmapped: added.filter((t) => !t.tester) };
    }

    async function sendChunked(chatId, text, extra = {}) {
        let cur = '';
        const out = [];
        for (const line of text.split('\n')) {
            if (cur.length + line.length + 1 > 3800) {
                out.push(cur);
                cur = '';
            }
            cur += `${line}\n`;
        }
        if (cur.trim()) out.push(cur);
        for (const chunk of out) await bot.api.sendMessage(chatId, chunk, { ...HTML, ...extra });
    }

    const sendReport = (rel, replyTo) =>
        sendChunked(rel.chatId, renderReport(rel, (id) => chatLink(rel, id)), replyTo ? { reply_parameters: { message_id: replyTo } } : {});

    // ---------- команды ----------
    bot.command('start', async (ctx) => {
        if (ctx.chat.type === 'private') {
            state.dm[String(ctx.from.id)] = { id: ctx.from.id, username: ctx.from.username };
            save();
            return ctx.reply(
                'Готово ✅ Теперь ваши задачи с кнопками, подсказки и напоминания по релизам будут приходить сюда, а в группе останется сводка. ' +
                    'Файлы и причины отправляйте мне — файл я сам перенесу в группу. Свои открытые задачи покажет /my.' +
                    (isAdmin(ctx.from) ? '\nКак админ вы будете получать здесь и служебные подсказки (кнопка «Сервер переключен», утренняя сводка).' : ''),
            );
        }
        await ctx.reply(
            'Вставьте или перешлите список релиза в группу — я предложу кнопку «Создать релиз» (или ответьте на список командой /release, можно со сроком: /release до 17:00). ' +
                'Если релиз уже идёт, новые задачи можно добавить кнопкой или командой /release add — повторы я пропущу.\n' +
                '/my — ваши открытые задачи, /find SN-561 — где и как проходила задача\n' +
                '/panel — все действия кнопками, /who — кто что не закрыл (с кнопками «напомнить»)\n' +
                '/log — журнал действий админов, /status — прогресс, /report — итоговый отчёт, /export [all] — выгрузка в Excel, /stats — статистика\n' +
                '/deadline 17:00 — срок, /remind — напомнить сейчас, /stop — закрыть релиз\n' +
                '/exclude SN-543 EA-12 — убрать задачи из релиза, /live — сообщить командам, что задачи уже на боевом сервере\n' +
                '/assign <задача или секция> @user — переназначить (или кнопкой «✏️ Переназначить» в /panel), /reload — перечитать testers.json, /testers — кто за что\n' +
                '/addtester @user KEY1,KEY2 | Секция — добавить QA, /removetester @user — убрать\n' +
                '/guide — памятка для QA (закрепляется в группе), /welcome — предпросмотр приветствия, /myid — ваш ID и ID чата',
        );
    });

    bot.command('myid', (ctx) => ctx.reply(`user id: ${ctx.from.id}\nchat id: ${ctx.chat.id}`));

    bot.command('guide', async (ctx) => {
        if (!guard(ctx)) return;
        const msg = await ctx.reply(GUIDE(ctx.me.username), HTML);
        // закрепить можно только с правом админа — если его нет, подскажем сделать вручную
        await ctx.api.pinChatMessage(ctx.chat.id, msg.message_id, { disable_notification: true }).catch(() =>
            ctx.reply('Не смог закрепить памятку — закрепите её вручную или дайте боту право закреплять сообщения.'),
        );
    });

    // Приветствие новым участникам (боты в приветствие не попадают)
    bot.on('message:new_chat_members', async (ctx) => {
        if (!isAllowed(ctx)) return;
        const people = ctx.message.new_chat_members.filter((u) => !u.is_bot);
        if (!people.length) return;
        await ctx.reply(WELCOME(people.map(userMention).join(', '), ctx.me.username), HTML);
    });

    // Предпросмотр приветствия — чтобы проверить текст, не добавляя никого в группу
    bot.command('welcome', async (ctx) => {
        if (!guard(ctx)) return;
        await ctx.reply(WELCOME(userMention(ctx.from), ctx.me.username), HTML);
    });

    bot.command('release', async (ctx) => {
        if (!guard(ctx)) return;

        let arg = ctx.match.trim();
        const append = /^add\b/i.test(arg);
        if (append) arg = arg.replace(/^add\b/i, '').trim();
        const clock = parseClock(arg);
        const deadlineAt = clock ? nextOccurrence(clock.h, clock.m, tz) : null;
        if (clock) arg = arg.slice(clock.length).trim();

        // список — либо текст после команды, либо сообщение, на которое ответили командой
        const source = ctx.message.reply_to_message;
        const text = arg || source?.text || source?.caption || '';
        const sourceMessageId = arg ? ctx.message.message_id : source?.message_id;
        await startRelease(ctx, { text, sourceMessageId, deadlineAt, append });
    });

    // Общая часть для /release и для кнопки «Создать релиз» под автоматически найденным списком
    async function startRelease(ctx, { text, sourceMessageId, deadlineAt = null, append = false }) {
        const parsed = parseRelease(text);

        if (!parsed.sections.length) {
            // показываем, что бот реально прочитал — так сразу видно, не то ли сообщение выбрано
            const seen = text ? `«${text.slice(0, 200)}${text.length > 200 ? '…' : ''}»` : 'пусто (в сообщении нет текста)';
            return ctx.reply(
                `Не нашёл в тексте ни одной задачи. Ответьте командой /release на сообщение со списком релиза.\n\n` +
                    `Бот понимает строки с ключом Jira, секции необязательны:\n\n` +
                    `EO Core Release 05/11/2026\n\nЛояльность (2 задачи)\n[LOYAL-573] - Описание задачи\n[LOYAL-574] - Описание задачи\n\n` +
                    `Или просто список: [BNPL-968] - Описание / EA-1318 - Описание (сгруппирую по проектам).\n\n` +
                    `Я прочитал (${text.length} симв.): ${seen}`,
            );
        }

        let rel = append ? activeRelease(ctx.chat.id) : null;
        if (append && !rel) return ctx.reply('Нет активного релиза. Используйте /release без add.');

        // при добавлении повторы по ключу пропускаем — иначе одна задача появится дважды
        if (append) {
            const have = new Set(rel.tasks.map((t) => t.key).filter(Boolean));
            const skipped = [];
            for (const s of parsed.sections) {
                s.tasks = s.tasks.filter((t) => {
                    if (t.key && have.has(t.key)) skipped.push(t.key);
                    return !(t.key && have.has(t.key));
                });
            }
            parsed.sections = parsed.sections.filter((s) => s.tasks.length);
            if (skipped.length) await ctx.reply(`ℹ️ Уже были в релизе, пропустил: ${skipped.join(', ')}.`);
            if (!parsed.sections.length) return ctx.reply('Новых задач нет — всё уже в релизе.');
        }

        if (!rel) {
            const old = activeRelease(ctx.chat.id);
            if (old) old.closed = true; // новый релиз закрывает предыдущий
            // id — время в base36 (по нему считаем возраст релиза); при совпадении миллисекунды (две группы сразу) сдвигаем
            let stampMs = Date.now();
            while (state.releases[stampMs.toString(36)]) stampMs++;
            const id = stampMs.toString(36);
            rel = {
                id,
                chatId: ctx.chat.id,
                title: parsed.title || 'Релиз',
                createdBy: ctx.from,
                createdAtMs: Date.now(),
                tasks: [],
                lastRemindAt: Date.now(),
                summaryMessageId: (await ctx.reply('Разбираю список…')).message_id,
            };
            state.releases[id] = rel;
            journal(ctx.from, 'создал релиз', rel);
        }
        if (deadlineAt) {
            rel.deadlineAt = deadlineAt;
            delete rel.deadlineNotified;
            delete rel.warnedH;
        }

        const { added, unmapped } = await postTasks(rel, parsed, sourceMessageId);
        if (append) journal(ctx.from, `добавил задач: ${added.length}`, rel);
        await refreshSummary(rel);
        save();
        await announceDelivery(ctx, rel, added);

        const notes = [];
        if (parsed.inferred) {
            const counts = parsed.sections.map((s) => `${s.title} — ${s.tasks.length}`).join(', ');
            notes.push(`ℹ️ В списке не было заголовков «Название (N задач)», поэтому я сгруппировал задачи по проектам: ${counts}.`);
        }
        for (const s of countMismatches(parsed)) {
            notes.push(`⚠️ В секции «${s.title}» заявлено задач: ${s.declared}, нашёл: ${s.taskKeys.length}. Проверьте ключи (недостающие можно добавить через /release add).`);
        }
        if (notes.length) await tellAdmins(ctx, `Релиз «${rel.title}»:\n${notes.join('\n')}`);

        // итог раскладки — создателю релиза лично, с кнопками «Назначить» / «Переназначить»
        const counts = new Map();
        for (const t of added) {
            const name = t.tester ? t.tester.name : null;
            counts.set(name, (counts.get(name) || 0) + 1);
        }
        const parts = [...counts].filter(([n]) => n).map(([n, c]) => `у ${esc(n)} — ${c}`);
        if (unmapped.length) parts.push(`без тестировщика — ${unmapped.length}`);
        const kb = new InlineKeyboard();
        if (unmapped.length) kb.text('✏️ Назначить', `a:${rel.id}:U`);
        kb.text('✏️ Переназначить', `a:${rel.id}:L`);
        let hint = `📋 <b>${esc(rel.title)}</b>\n${append ? 'Добавлено' : 'Создано'}: ${plural(added.length, 'задача', 'задачи', 'задач')}: ${parts.join(', ')}`;
        if (unmapped.length) {
            const projects = [...new Set(unmapped.map((t) => t.key?.split('-')[0]).filter(Boolean))];
            const addHint = projects.length ? `Добавьте проект ${projects.join(', ')} в testers.json (projects) и выполните /reload, или назначьте` : 'Назначьте';
            hint += `\n⚠️ Не найден тестировщик для: ${unmapped.map((t) => esc(label(t))).join(', ')}. ${addHint}: /assign <задача> @user`;
        }
        // без личной доставки показываем в группе только если есть о чём предупредить
        if (!(await dmAdmins(ctx.from, hint, { ...HTML, reply_markup: kb })) && unmapped.length) await ctx.reply(hint, { ...HTML, reply_markup: kb });
    }

    // «5 задач», «2 задачи», «1 задача»
    const plural = (n, one, few, many) => {
        const m = n % 100;
        const w = m > 10 && m < 20 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many;
        return `${n} ${w}`;
    };

    bot.command('deadline', async (ctx) => {
        if (!guard(ctx)) return;
        const rel = activeRelease(ctx.chat.id);
        if (!rel) return ctx.reply('Активного релиза нет.');
        const arg = ctx.match.trim();
        if (/^(off|нет|сброс)$/i.test(arg)) {
            delete rel.deadlineAt;
        } else {
            const clock = parseClock(arg);
            if (!clock) return ctx.reply('Формат: /deadline 17:00 (или /deadline off)');
            rel.deadlineAt = nextOccurrence(clock.h, clock.m, tz);
            delete rel.deadlineNotified;
            delete rel.warnedH;
        }
        save();
        await refreshSummary(rel);
        await ctx.reply(rel.deadlineAt ? `Срок релиза: ${time(rel.deadlineAt, tz)}` : 'Срок снят.');
    });

    bot.command('status', async (ctx) => {
        const rel = activeRelease(ctx.chat.id) || latestRelease(ctx.chat.id);
        if (!rel) return ctx.reply('Релизов пока нет.');
        await ctx.reply(summaryText(rel), { ...HTML, reply_parameters: { message_id: rel.summaryMessageId } });
    });

    bot.command('report', async (ctx) => {
        if (!isAllowed(ctx)) return;
        const rel = activeRelease(ctx.chat.id) || latestRelease(ctx.chat.id);
        if (!rel) return ctx.reply('Релизов пока нет.');
        await sendReport(rel);
    });

    // Выгрузка в CSV (открывается в Excel): /export — текущий или последний релиз, /export all — вся история
    bot.command('export', async (ctx) => {
        if (!guard(ctx)) return;
        const all = /^all\b/i.test(ctx.match.trim());
        const history = releases().filter((r) => r.chatId === ctx.chat.id).sort((a, b) => stamp(a) - stamp(b));
        const picked = all ? history : [activeRelease(ctx.chat.id) || latestRelease(ctx.chat.id)].filter(Boolean);
        if (!picked.length) return ctx.reply('Релизов пока нет.');

        const csv = releasesToCsv(picked, { link: (rel, id) => chatLink(rel, id), tz });
        const day = localClock(stamp(picked.at(-1)), tz).day;
        await ctx.replyWithDocument(new InputFile(Buffer.from(csv, 'utf8'), `${all ? 'releases' : 'release'}-${day}.csv`), {
            caption: `Выгрузка: ${all ? `все релизы (${picked.length})` : picked[0].title}. Открывается в Excel.`,
        });
    });

    bot.command('stats', async (ctx) => {
        if (!guard(ctx)) return;
        await ctx.reply(renderStats(computeStats(releases().filter((r) => r.chatId === ctx.chat.id))), HTML);
    });

    // /log — последние действия админов (создал, назначил, исключил, объявил, закрыл)
    bot.command('log', async (ctx) => {
        if (!guard(ctx)) return;
        const rows = (state.log || []).slice(-15).reverse().map((e) => {
            const lc = localClock(e.at, tz);
            return `${lc.day.slice(8)}.${lc.day.slice(5, 7)} ${time(e.at, tz)} — ${esc(e.who)}: ${esc(e.text)}${e.rel ? ` · ${esc(e.rel)}` : ''}`;
        });
        await ctx.reply(rows.length ? `🧾 <b>Последние действия</b>\n${rows.join('\n')}` : 'Журнал пока пуст.', HTML);
    });

    bot.command('remind', async (ctx) => {
        if (!guard(ctx)) return;
        const rel = activeRelease(ctx.chat.id);
        if (!rel) return ctx.reply('Активного релиза нет.');
        if (!pending(rel).length) return ctx.reply('Все уже ответили.');
        await remind(rel, Date.now());
    });

    bot.command('stop', async (ctx) => {
        if (!guard(ctx)) return;
        const rel = activeRelease(ctx.chat.id);
        if (!rel) return ctx.reply('Активного релиза нет.');
        rel.closed = true;
        journal(ctx.from, 'закрыл релиз', rel);
        save();
        await ctx.reply(`Релиз «${rel.title}» закрыт, напоминаний больше не будет.`);
    });

    // /exclude SN-543 EA-12 — задача не едет в релиз: её не ждём, не напоминаем и не упоминаем в «/live».
    // Можно ответить командой на сообщение задачи. Вернуть — кнопкой «↩️ Изменить» под задачей.
    bot.command('exclude', async (ctx) => {
        if (!guard(ctx)) return;
        const rel = activeRelease(ctx.chat.id) || latestRelease(ctx.chat.id);
        if (!rel) return ctx.reply('Релизов пока нет.');

        const keys = ctx.match.toUpperCase().match(/[A-Z][A-Z0-9]*-\d+/g) || [];
        const replied = ctx.message.reply_to_message?.message_id;
        const tasks = rel.tasks.filter((t) => (t.key && keys.includes(t.key)) || (replied && !t.cardChat && t.messageId === replied));
        if (!tasks.length) return ctx.reply('Формат: /exclude SN-543 EA-12 (или ответьте командой на сообщение задачи).');

        for (const task of tasks) {
            dropPrompts(rel, task);
            task.status = 'excluded';
            task.by = actor(ctx.from);
            task.at = Date.now();
            if (task.messageId) await refreshTask(rel, task);
            journal(ctx.from, `исключил ${label(task)}`, rel);
        }
        save();
        await refreshSummary(rel);
        const missing = keys.filter((k) => !rel.tasks.some((t) => t.key === k));
        await ctx.reply(
            `🚫 Исключено из релиза: ${tasks.map(label).join(', ')}.` + (missing.length ? `\nНе нашёл в релизе: ${missing.join(', ')}.` : ''),
        );
        if (!rel.closed) await checkCompletion(rel);
    });

    // Сообщение командам после выката: задачи уже на боевом сервере. Исключённые задачи не упоминаем.
    bot.command('live', async (ctx) => {
        if (!guard(ctx)) return;
        const rel = activeRelease(ctx.chat.id) || latestRelease(ctx.chat.id);
        if (!rel) return ctx.reply('Релизов пока нет.');
        const force = /\bforce\b/i.test(ctx.match);
        await announceLive(ctx, rel, { force, direct: force }); // «/live force» шлёт сразу, без выбора задач
    });

    // Кнопки «🚀 Сервер переключен» (после «можно выпускать») и выбор по незакрытым задачам
    bot.callbackQuery(/^l:([^:]+):(go|force|exclude)$/, async (ctx) => {
        // кнопка приходит и из личного чата админа, поэтому проверяем только роль, а не чат
        if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: 'Только для админов', show_alert: true });
        const [, relId, action] = ctx.match;
        const rel = state.releases[relId];
        if (!rel) return ctx.answerCallbackQuery({ text: 'Релиз не найден', show_alert: true });
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
        if (action === 'exclude') {
            for (const t of rel.tasks.filter((x) => ['pending', 'await', 'bad'].includes(x.status))) {
                dropPrompts(rel, t);
                t.status = 'excluded';
                t.by = actor(ctx.from);
                t.at = Date.now();
                if (t.messageId) await refreshTask(rel, t);
                journal(ctx.from, `исключил ${label(t)}`, rel);
            }
            save();
            await refreshSummary(rel);
        }
        await announceLive(ctx, rel, { force: action !== 'go' });
    });

    // краткое описание задачи для списков: " — текст…" или пусто
    const short = (t) => {
        const d = taskDescription(t).replace(/\s+/g, ' ').trim();
        return d ? ` — ${esc(d.length > 70 ? `${d.slice(0, 67)}…` : d)}` : '';
    };

    async function announceLive(ctx, rel, { force, direct = false }) {
        const open = rel.tasks.filter((t) => t.status === 'pending' || t.status === 'await' || t.status === 'bad');
        if (open.length && !force) {
            const list = (arr) => arr.map((t) => `• ${esc(label(t))}${short(t)}`).join('\n');
            const silent = open.filter((t) => t.status !== 'bad');
            const failed = open.filter((t) => t.status === 'bad');
            const parts = ['⚠️ <b>Не все задачи закрыты</b>', ''];
            if (silent.length) parts.push(`Ещё не проверены (${silent.length}):`, list(silent), '');
            if (failed.length) parts.push(`Не прошли проверку (${failed.length}):`, list(failed), '');
            parts.push(
                'Что делать с этими задачами?',
                '• <b>Исключить и объявить</b> — их нет в выкате: они уберутся из релиза и не попадут в сообщение командам.',
                '• <b>Объявить как есть</b> — сообщение уйдёт со всеми задачами, включая эти.',
            );
            return ctx.reply(parts.join('\n'), {
                ...HTML,
                reply_markup: new InlineKeyboard()
                    .text('🚫 Исключить и объявить', `l:${rel.id}:exclude`)
                    .row()
                    .text('🚀 Объявить как есть', `l:${rel.id}:force`),
            });
        }
        if (rel.liveAt && !force) {
            return ctx.reply(`Объявление уже отправлено в ${time(rel.liveAt, tz)}.`, {
                reply_markup: new InlineKeyboard().text('🔁 Отправить ещё раз', `l:${rel.id}:force`),
            });
        }
        // перед отправкой админ в личке может убрать задачи, выпавшие из релиза на код-ревью
        if (!direct) return showLiveEditor(ctx, rel, { fresh: true });
        return sendLive(ctx, rel);
    }

    const editable = (rel) => rel.tasks.map((task, idx) => ({ task, idx })).filter(({ task }) => !OUT.includes(task.status));

    // Список задач будущего объявления: нажатие на задачу переключает ✅ входит / 🚫 не входит (пока ничего не отправлено)
    async function showLiveEditor(ctx, rel, { fresh = false } = {}) {
        if (fresh) rel.liveSkip = [];
        const skip = new Set(rel.liveSkip || []);
        const items = editable(rel);
        if (!items.length) return ctx.reply('Все задачи релиза исключены — объявлять нечего.');

        const kb = new InlineKeyboard();
        items.slice(0, MAX_BUTTONS * 2).forEach(({ task, idx }, i) => {
            kb.text(`${skip.has(idx) ? '🚫' : '✅'} ${short24(label(task))}`, `e:${rel.id}:t:${idx}`);
            if (i % 2) kb.row();
        });
        const included = items.length - items.filter(({ idx }) => skip.has(idx)).length;
        kb.row().text(`🚀 Отправить в группу (${included})`, `e:${rel.id}:ok`).row().text('Отмена', `e:${rel.id}:no`);
        const text =
            `🚀 <b>Что войдёт в сообщение «сервер переключен»?</b>\n«${esc(rel.title)}»\n` +
            'Нажмите на задачу, которую убрали из релиза (например, на код-ревью): она станет 🚫 и в группу не попадёт.' +
            (items.length > MAX_BUTTONS * 2 ? `\nПоказаны первые ${MAX_BUTTONS * 2} из ${items.length}, остальные можно исключить командой /exclude.` : '');
        const extra = { ...HTML, reply_markup: kb };
        if (fresh) return ctx.reply(text, extra);
        return ctx.editMessageText(text, extra).catch(() => {});
    }

    bot.callbackQuery(/^e:([^:]+):(t:(\d+)|ok|no)$/, async (ctx) => {
        if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: 'Только для админов', show_alert: true });
        const rel = state.releases[ctx.match[1]];
        if (!rel?.tasks) return ctx.answerCallbackQuery({ text: 'Релиз не найден', show_alert: true });
        const what = ctx.match[2];
        if (what === 'no') {
            delete rel.liveSkip;
            save();
            await ctx.answerCallbackQuery();
            return ctx.editMessageText('Отменено, в группу ничего не отправлено.').catch(() => {});
        }
        if (what.startsWith('t:')) {
            const idx = Number(ctx.match[3]);
            const skip = new Set(rel.liveSkip || []);
            if (skip.has(idx)) skip.delete(idx);
            else skip.add(idx);
            rel.liveSkip = [...skip];
            save();
            await ctx.answerCallbackQuery();
            return showLiveEditor(ctx, rel);
        }
        // ok: помечаем выбранные исключёнными и отправляем объявление
        const skipped = editable(rel).filter(({ idx }) => (rel.liveSkip || []).includes(idx));
        if (skipped.length === editable(rel).length) return ctx.answerCallbackQuery({ text: 'Все задачи убраны — отправлять нечего', show_alert: true });
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
        for (const { task } of skipped) {
            dropPrompts(rel, task);
            task.status = 'excluded';
            task.by = actor(ctx.from);
            task.at = Date.now();
            if (task.messageId) await refreshTask(rel, task);
            journal(ctx.from, `исключил ${label(task)} (перед объявлением)`, rel);
        }
        delete rel.liveSkip;
        if (skipped.length) await refreshSummary(rel);
        await sendLive(ctx, rel);
    });

    async function sendLive(ctx, rel) {
        const shipped = rel.tasks.filter((t) => !OUT.includes(t.status));
        if (!shipped.length) return ctx.reply('Все задачи релиза исключены — объявлять нечего.');

        // «вчерашнего» / «сегодняшнего» — по дню создания релиза, иначе называем по названию
        const daysAgo = Math.round((Date.parse(localClock(Date.now(), tz).day) - Date.parse(localClock(stamp(rel), tz).day)) / (24 * HOUR));
        const which = daysAgo === 0 ? 'сегодняшнего релиза' : daysAgo === 1 ? 'вчерашнего релиза' : `релиза «${esc(rel.title)}»`;

        // тегаем тестировщиков со ссылками на их задачи — каждый видит, что именно проверять
        const byTester = new Map();
        for (const t of shipped.filter((x) => x.tester)) {
            const k = testerKey(t.tester);
            if (!byTester.has(k)) byTester.set(k, { tester: t.tester, tasks: [] });
            byTester.get(k).tasks.push(t);
        }
        const blocks = [...byTester.values()].map(
            ({ tester, tasks }) => `👤 ${mention(tester)}\n${tasks.map((t) => `   • ${taskLink(rel, t)}${short(t)}`).join('\n')}`,
        );
        const noTester = shipped.filter((t) => !t.tester);
        if (noTester.length) blocks.push(`👤 Тестировщик не назначен\n${noTester.map((t) => `   • ${esc(label(t))}${short(t)}`).join('\n')}`);

        await sendChunked(
            rel.chatId,
            `🚀 <b>Релиз на боевом сервере</b>\n\n` +
                `Коллеги, сервер переключен. Все задачи ${which} уже находятся на боевой версии и доступны для проверки.\n` +
                `⚠️ <b>ПРОСИМ ПРОВЕРИТЬ СВОИ ЗАДАЧИ НА БОЕВОМ СЕРВЕРЕ СРАЗУ ПОСЛЕ ЭТОГО СООБЩЕНИЯ</b> ⚠️\n` +
                `<b>Чтобы позже не возникало вопросов, вошла ли задача в релиз.</b>\n\n` +
                `<b>Задачи в релизе (${shipped.length}):</b>\n\n${blocks.join('\n\n')}`,
        );
        rel.liveAt = Date.now();
        journal(ctx.from, 'объявил «сервер переключен»', rel);
        save();
        if (ctx.chat.id !== rel.chatId) await ctx.reply('✅ Сообщение отправлено в группу.');
    }

    // Назначает тестировщика; если у задачи ещё не было сообщения — публикует его
    async function assign(rel, task, tester) {
        // карточка в личке прежнего тестировщика не нужна — публикуем заново новому
        if (task.cardChat) {
            const old = task.cardChat;
            dropPrompts(rel, task);
            await dropMessage(old, task.messageId);
            delete task.cardChat;
            delete task.messageId;
        }
        task.tester = tester;
        if (task.messageId) {
            task.ping = true;
            await refreshTask(rel, task);
            await bot.api.sendMessage(rel.chatId, `${mention(tester)}, вам назначена задача ${taskLink(rel, task)}.`, {
                ...HTML,
                reply_parameters: { message_id: task.messageId },
            });
        } else {
            await postTask(rel, task);
        }
    }

    bot.command('assign', async (ctx) => {
        if (!guard(ctx)) return;
        const rel = activeRelease(ctx.chat.id);
        if (!rel) return ctx.reply('Активного релиза нет.');

        const words = ctx.match.trim().split(/\s+/);
        const username = words.pop()?.replace(/^@/, '');
        const target = words.join(' ').toLowerCase();
        if (!username || !target) return ctx.reply('Формат: /assign SN-543 @user или /assign Лояльность @user');

        const tasks = rel.tasks.filter((t) => t.key?.toLowerCase() === target || t.section.toLowerCase().includes(target));
        if (!tasks.length) return ctx.reply(`Не нашёл задачу или секцию «${target}».`);

        const tester = testers.find((t) => t.username?.toLowerCase() === username.toLowerCase()) || { name: username, username };
        for (const task of tasks) {
            await assign(rel, task, tester);
            journal(ctx.from, `назначил ${label(task)} → ${tester.name}`, rel);
        }
        await refreshSummary(rel);
        save();
        await ctx.reply(`Назначил ${mention(tester)}: ${tasks.map(label).join(', ')}`, HTML);
    });

    // Задачи, у которых раньше не было тестировщика, пробуем назначить заново; возвращает, сколько назначено
    async function assignUnmapped(rel) {
        let assigned = 0;
        for (const task of rel?.tasks.filter((t) => !t.tester) ?? []) {
            const tester = pickTester(rel, task);
            if (!tester) continue;
            await assign(rel, task, tester);
            assigned++;
        }
        if (assigned) {
            await refreshSummary(rel);
            save();
        }
        return assigned;
    }

    // «✏️ Переназначить»: a:<релиз>:<L|U> — список задач (L — открытые, U — без тестировщика),
    // a:<релиз>:<режим>:<задача> — выбор тестировщика, a:<релиз>:<режим>:<задача>:<тестировщик> — назначить
    const MAX_BUTTONS = 40;
    const reassignable = (rel, mode) =>
        rel.tasks
            .map((task, idx) => ({ task, idx }))
            .filter(({ task }) => (mode === 'U' ? !task.tester : !task.tester || task.status === 'pending' || task.status === 'await'));
    const short24 = (s) => (s.length > 24 ? `${s.slice(0, 23)}…` : s);

    function reassignListView(rel, mode) {
        const items = reassignable(rel, mode);
        if (!items.length) return { text: mode === 'U' ? '✅ Задач без тестировщика нет.' : 'Открытых задач для переназначения нет.', kb: new InlineKeyboard() };
        const kb = new InlineKeyboard();
        items.slice(0, MAX_BUTTONS).forEach(({ task, idx }, i) => {
            kb.text(short24(`${label(task)} · ${task.tester ? task.tester.name : 'нет'}`), `a:${rel.id}:${mode}:${idx}`);
            if (i % 2) kb.row();
        });
        const more = items.length > MAX_BUTTONS ? `\nПоказаны первые ${MAX_BUTTONS} из ${items.length}, остальные — командой /assign.` : '';
        return { text: `✏️ <b>${esc(rel.title)}</b>\nВыберите задачу:${more}`, kb };
    }

    bot.callbackQuery(/^a:([^:]+):([LU])(?::(\d+)(?::(\d+))?)?$/, async (ctx) => {
        if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: 'Только для админов', show_alert: true });
        const [, relId, mode, taskIdx, testerIdx] = ctx.match;
        const rel = state.releases[relId];
        if (!rel?.tasks) return ctx.answerCallbackQuery({ text: 'Релиз не найден', show_alert: true });
        if (rel.closed) return ctx.answerCallbackQuery({ text: 'Релиз уже закрыт', show_alert: true });
        const show = (text, kb) => ctx.editMessageText(text, { ...HTML, reply_markup: kb }).catch(() => {});

        if (taskIdx === undefined) {
            await ctx.answerCallbackQuery();
            const v = reassignListView(rel, mode);
            return show(v.text, v.kb);
        }
        const task = rel.tasks[Number(taskIdx)];
        if (!task) return ctx.answerCallbackQuery({ text: 'Задача не найдена', show_alert: true });

        if (testerIdx === undefined) {
            await ctx.answerCallbackQuery();
            const kb = new InlineKeyboard();
            testers.slice(0, MAX_BUTTONS).forEach((tester, i) => {
                kb.text(short24(tester.name), `a:${rel.id}:${mode}:${taskIdx}:${i}`);
                if (i % 2) kb.row();
            });
            kb.row().text('↩️ Назад', `a:${rel.id}:${mode}`);
            return show(`✏️ ${taskTitle(task)}\nСейчас: ${task.tester ? esc(task.tester.name) : 'не назначен'}\nКому передать? Другого человека — командой /assign ${esc(label(task))} @user`, kb);
        }

        const tester = testers[Number(testerIdx)];
        if (!tester) return ctx.answerCallbackQuery({ text: 'Список тестировщиков изменился, откройте заново', show_alert: true });
        if (task.tester && testerKey(task.tester) === testerKey(tester)) return ctx.answerCallbackQuery({ text: 'Уже назначен этому тестировщику' });
        await ctx.answerCallbackQuery({ text: `Назначил: ${tester.name}` });
        const was = task.tester?.name;
        await assign(rel, task, tester);
        journal(ctx.from, `назначил ${label(task)}: ${was ? `${was} → ` : ''}${tester.name}`, rel);
        await refreshSummary(rel);
        save();
        const v = reassignListView(rel, mode);
        await show(`✅ ${esc(label(task))} → ${esc(tester.name)}\n\n${v.text}`, v.kb);
    });

    bot.command('reload', async (ctx) => {
        if (!guard(ctx)) return;
        testers = loadTesters();
        const assigned = await assignUnmapped(activeRelease(ctx.chat.id));
        await ctx.reply(`testers.json перечитан: ${testers.length} чел.${assigned ? ` Назначено задач: ${assigned}.` : ''}`);
    });

    // /addtester @user KEY1,KEY2 | Секция — добавляет или дополняет запись в testers.json без правки файла вручную
    bot.command('addtester', async (ctx) => {
        if (!guard(ctx)) return;
        const parsed = parseAddTester(ctx.match, ctx.message.reply_to_message?.from);
        if (parsed.error) return ctx.reply(parsed.error);

        testers = loadTesters(); // подхватываем ручные правки файла, чтобы не затереть их
        const { created, entry } = addOrUpdateTester(testers, parsed.who, parsed.projects, parsed.titles);
        saveTesters(testers);
        const assigned = await assignUnmapped(activeRelease(ctx.chat.id));

        const scope = [entry.projects?.length && `проекты ${entry.projects.join(', ')}`, entry.titles?.length && `секции ${entry.titles.map(esc).join('; ')}`];
        await ctx.reply(
            `${created ? '✅ Добавлен' : '✅ Обновлён'} ${mention(entry)}: ${scope.filter(Boolean).join('; ')}.` +
                (assigned ? ` Назначено задач текущего релиза: ${assigned}.` : ''),
            HTML,
        );
    });

    bot.command('removetester', async (ctx) => {
        if (!guard(ctx)) return;
        const ref = parseTesterRef(ctx.match.trim().split(/\s+/).filter(Boolean), ctx.message.reply_to_message?.from);
        if (ref.error) return ctx.reply(ADD_USAGE.replace('/addtester @user KEY1,KEY2 | Название секции; Другая секция', '/removetester @user'));

        testers = loadTesters();
        const left = testers.filter((t) => !isSameTester(t, ref.who));
        if (left.length === testers.length) return ctx.reply('Не нашёл такого тестировщика в testers.json.');
        saveTesters(left);
        testers = left;

        // его открытые задачи остаются за ним — предупреждаем, чтобы их переназначили
        const rel = activeRelease(ctx.chat.id);
        const open = rel ? pending(rel).filter((t) => isSameTester(t.tester, ref.who)) : [];
        await ctx.reply(
            `🗑 Удалён ${ref.who.username ? `@${ref.who.username}` : esc(ref.who.name)}.` +
                (open.length ? `\nОстались его открытые задачи: ${open.map((t) => taskLink(rel, t)).join(', ')}. Переназначьте: /assign KEY @user` : ''),
            HTML,
        );
    });

    const STATUS_TEXT = {
        ok: '✅ Протестирована',
        na: '➖ Не требует теста',
        bad: '❌ Не пройдена',
        notready: '🚧 Не готова',
        excluded: '🚫 Исключена из релиза',
        pending: '⏳ Без ответа',
        await: '📎 Ждём вложение',
    };
    // в группе — релизы этой группы, в личном чате — релизы всех групп
    const scopeReleases = (ctx) => releases().filter((r) => ctx.chat.type === 'private' || r.chatId === ctx.chat.id);

    // /my — мои открытые задачи со ссылками: не нужно искать их прокруткой по чату
    bot.command('my', async (ctx) => {
        if (ctx.chat.type !== 'private' && !isAllowed(ctx)) return;
        const rels = scopeReleases(ctx).filter((r) => !r.closed).sort((a, b) => stamp(b) - stamp(a));
        const blocks = rels
            .map((rel) => ({ rel, tasks: rel.tasks.filter((t) => isOwnerOf(ctx.from, t) && (t.status === 'pending' || t.status === 'await')) }))
            .filter((b) => b.tasks.length);
        if (!blocks.length) return ctx.reply('У вас нет открытых задач 🎉');

        const total = blocks.reduce((n, b) => n + b.tasks.length, 0);
        const lines = [`📋 <b>Ваши открытые задачи (${total})</b>`];
        for (const { rel, tasks } of blocks) {
            if (blocks.length > 1) lines.push('', `<b>${esc(rel.title)}</b>`);
            for (const t of tasks) lines.push(`• ${taskLink(rel, t)}${short(t)}${t.status === 'await' ? ' — 📎 ждём вложение' : ''}`);
        }
        await sendChunked(ctx.chat.id, lines.join('\n'));
    });

    // /find SN-561 или /find кэшбэк — в каких релизах была задача и чем закончилась
    bot.command('find', async (ctx) => {
        if (ctx.chat.type === 'private' ? !isAdmin(ctx.from) : !isAllowed(ctx)) return;
        const query = ctx.match.trim();
        if (!query) return ctx.reply('Формат: /find SN-561 (или часть названия: /find кэшбэк)');

        const keys = query.toUpperCase().match(/[A-Z][A-Z0-9]*-\d+/g);
        const needle = query.toLowerCase();
        const matches = (t) => (keys ? keys.includes(t.key) : `${taskDescription(t)} ${t.section}`.toLowerCase().includes(needle));
        const hits = scopeReleases(ctx)
            .sort((a, b) => stamp(b) - stamp(a))
            .flatMap((rel) => rel.tasks.filter(matches).map((task) => ({ rel, task })));
        if (!hits.length) return ctx.reply(`«${query}» не встречается ни в одном релизе.`);

        const SHOWN = 10;
        const rows = hits.slice(0, SHOWN).map(({ rel, task }) => {
            const date = new Date(stamp(rel)).toLocaleDateString('ru-RU', { timeZone: tz });
            const done = FINISHED.includes(task.status) && task.by ? ` · ${esc(task.by)}, ${time(task.at, tz)}` : '';
            const who = task.tester ? esc(task.tester.name) : 'без тестировщика';
            const reason = task.status === 'bad' && task.reason ? `\nПричина: ${esc(task.reason)}` : '';
            return `<b>${esc(rel.title)}</b> (${date})\n${taskLink(rel, task)}${short(task)}\n${STATUS_TEXT[task.status]} · ${who}${done}${reason}`;
        });
        const more = hits.length > SHOWN ? `\n\nИ ещё ${hits.length - SHOWN} — уточните запрос.` : '';
        await sendChunked(ctx.chat.id, `🔎 Найдено: ${hits.length}\n\n${rows.join('\n\n')}${more}`);
    });

    bot.command('testers', async (ctx) => {
        if (!guard(ctx)) return;
        const rows = testers.map((t) => `${mention(t)} — ${[...(t.titles || []), ...(t.projects || [])].join(', ')}`);
        await ctx.reply(rows.join('\n') || 'testers.json пуст', HTML);
    });

    // ---------- кнопки ----------
    bot.callbackQuery(/^r:([^:]+):(\d+):(ok|bad|na|notready|reset)$/, async (ctx) => {
        const [, relId, idx, action] = ctx.match;
        const rel = state.releases[relId];
        const task = rel?.tasks?.[Number(idx)];
        if (!task?.tester) return ctx.answerCallbackQuery({ text: 'Релиз не найден', show_alert: true });
        if (rel.closed) return ctx.answerCallbackQuery({ text: 'Релиз уже закрыт', show_alert: true });

        const u = ctx.from;
        if (!canAct(u, task)) {
            return ctx.answerCallbackQuery({ text: `Эта задача назначена ${task.tester.name}`, show_alert: true });
        }

        const target = { ok: 'await', bad: 'bad', na: 'na', notready: 'notready', reset: 'pending' }[action];
        if (task.status === target) return ctx.answerCallbackQuery({ text: 'Уже так отмечено' });

        const toast = {
            ok: 'Прикрепите скриншот или видео в открывшемся ответе 📎',
            bad: 'Записано: не пройдена. Напишите причину ответом ❌',
            na: 'Отмечено: не требует теста ➖',
            notready: 'Отмечено: задача не готова 🚧',
            reset: 'Сбросил, можно отметить заново',
        };
        await ctx.answerCallbackQuery({ text: toast[action] });

        dropPrompts(rel, task);
        task.status = target;
        task.by = actor(u);
        task.at = Date.now();
        if (action !== 'bad') delete task.reason;

        // force_reply сам открывает поле ответа у нажавшего — искать нужное сообщение в ленте не надо
        const forceReply = (placeholder) => ({ force_reply: true, selective: true, input_field_placeholder: placeholder });
        // Подсказка отвечает на сообщение задачи (видна цитата) и называет её целиком, а не одним ключом:
        // когда у тестировщика несколько задач, по подсказке сразу ясно, к какой пойдёт вложение
        const ofTask = { reply_parameters: { message_id: task.messageId, allow_sending_without_reply: true } };
        // карточка задачи в личке — в группе на неё не сослаться
        const groupReply = task.cardChat ? {} : ofTask;
        const pos = position(rel, task);
        const num = pos.m > 1 ? ` (задача ${pos.n} из ${pos.m})` : '';
        // Задача в личке — подсказка там же, ответом на карточку. Иначе: если нажавший писал боту /start —
        // подсказка ему в личку (лента группы короче), если нет — в группу.
        // Вложение из лички бот сам копирует в группу.
        const dmId = task.cardChat ?? state.dm[String(u.id)]?.id;
        const dmPrompt = (text, placeholder) =>
            dmId
                ? bot.api
                      .sendMessage(dmId, text, { ...HTML, ...(task.cardChat ? ofTask : {}), reply_markup: forceReply(placeholder) })
                      .catch(() => null)
                : null;
        if (action === 'ok') {
            const p = await dmPrompt(`📎 Прикрепите скриншот или видео для:\n${taskTitle(task)}${num}\nФайл появится в группе под этой задачей.`, 'Скриншот или видео');
            if (p) {
                task.promptChat = dmId;
                task.promptDm = true;
                task.promptId = p.message_id;
            } else {
                const g = await bot.api.sendMessage(
                    rel.chatId,
                    `📎 ${userMention(u)}, прикрепите скриншот или видео для:\n${taskTitle(task)}${num}`,
                    { ...HTML, ...groupReply, reply_markup: forceReply('Скриншот или видео') },
                );
                task.promptId = g.message_id;
            }
        } else if (action === 'bad') {
            const head = `❌ ${userMention(rel.createdBy)}, не пройдена (${task.by}):\n${taskTitle(task)}${num}`;
            const p = await dmPrompt(`❌ Не пройдена:\n${taskTitle(task)}${num}\nНапишите причину ответом на это сообщение.`, 'Причина, почему не пройдена');
            if (p) {
                // в группе автору списка — короткое уведомление, причина появится в сообщении задачи
                task.promptChat = dmId;
                task.promptDm = true;
                task.reasonPromptId = p.message_id;
                await bot.api.sendMessage(rel.chatId, head, { ...HTML, ...groupReply });
            } else {
                const g = await bot.api.sendMessage(rel.chatId, `${head}\n${userMention(u)}, напишите причину ответом на это сообщение.`, {
                    ...HTML,
                    ...groupReply,
                    reply_markup: forceReply('Причина, почему не пройдена'),
                });
                task.reasonPromptId = g.message_id;
            }
        }
        save();

        await refreshTask(rel, task);
        await refreshSummary(rel);
        if (action === 'notready') {
            // автору списка — решение, что делать с задачей; сама она из ожидания и из объявления уже выпала
            await bot.api.sendMessage(
                rel.chatId,
                `🚧 ${userMention(rel.createdBy)}, ${userMention(u)} отметил, что задача не готова:
${taskTitle(task)}`,
                { ...HTML, ...groupReply },
);
            // кнопку «исключить» видят только админы: лично, а если им не написать — в группе
            const kb = new InlineKeyboard().text('🚫 Исключить из релиза', `x:${rel.id}:${rel.tasks.indexOf(task)}`);
            const text = `🚧 В релизе «${esc(rel.title)}» задача не готова:
${taskTitle(task)}
Убрать её из релиза совсем?`;
            if (!(await dmAdmins(rel.createdBy, text, { ...HTML, reply_markup: kb }))) {
                await bot.api.sendMessage(rel.chatId, text, { ...HTML, ...groupReply, reply_markup: kb });
            }
        }
        if (action === 'bad' || action === 'na' || action === 'notready') await checkCompletion(rel);
    });

    // «🚫 Исключить из релиза» под сообщением о неготовой задаче (приходит админу лично)
    bot.callbackQuery(/^x:([^:]+):(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: 'Только для админов', show_alert: true });
        const rel = state.releases[ctx.match[1]];
        const task = rel?.tasks?.[Number(ctx.match[2])];
        if (!task) return ctx.answerCallbackQuery({ text: 'Задача не найдена', show_alert: true });
        await ctx.answerCallbackQuery();
        dropPrompts(rel, task);
        task.status = 'excluded';
        task.by = actor(ctx.from);
        task.at = Date.now();
        journal(ctx.from, `исключил ${label(task)} (не готова)`, rel);
        save();
        if (task.messageId) await refreshTask(rel, task);
        await refreshSummary(rel);
        await ctx.editMessageText(`🚫 Исключена из релиза: ${esc(label(task))}`, HTML).catch(() => {});
    });

    // ---------- вложения и причины ----------
    // Номера сообщений уникальны только внутри одного чата, поэтому сверяем и чат: сообщение задачи — в группе,
    // подсказки — там, где бот их отправил (группа или личка тестировщика)
    const findByReply = (rels, replyTo, chatId) => {
        for (const rel of rels) {
            const task = rel.tasks.find(
                (t) =>
                    (cardChatOf(rel, t) === chatId && t.messageId === replyTo) ||
                    (promptChatOf(rel, t) === chatId && (t.promptId === replyTo || t.reasonPromptId === replyTo)),
            );
            if (task) return { rel, task };
        }
        return null;
    };

    // В личке релизы ищем по всем группам, в группе — по этой
    const activeFor = (ctx) => releases().filter((r) => !r.closed && (ctx.chat.type === 'private' || r.chatId === ctx.chat.id));

    async function hint(ctx, text) {
        const group = ctx.message.media_group_id;
        if (group && hintedGroups.has(group)) return;
        if (group) hintedGroups.add(group);
        await ctx.reply(text, { reply_parameters: { message_id: ctx.message.message_id } });
    }

    bot.on(MEDIA, async (ctx) => {
        const m = ctx.message;
        const active = activeFor(ctx);
        let hit;

        if (m.reply_to_message) {
            hit = findByReply(active, m.reply_to_message.message_id, ctx.chat.id);
            if (!hit) return; // ответ на чужое сообщение — обычный разговор
        } else {
            // без Reply Telegram доставляет файл боту только при выключенном privacy mode
            const mine = active.flatMap((rel) => rel.tasks.filter((t) => isOwnerOf(ctx.from, t)).map((task) => ({ rel, task })));
            if (!mine.length) return;
            const keys = (m.caption || '').match(/[A-Z][A-Z0-9]*-\d+/g) || [];
            hit = mine.find(({ task }) => keys.includes(task.key));
            if (!hit) {
                const awaiting = mine.filter(({ task }) => task.status === 'await');
                if (awaiting.length !== 1) {
                    return hint(
                        ctx,
                        awaiting.length
                            ? `К какой задаче вложение? Ответьте (Reply) на её сообщение или напишите номер в подписи: ${awaiting.map(({ task }) => label(task)).join(', ')}`
                            : 'Не понял, к какой задаче вложение. Нажмите ✅ под задачей и прикрепите файл в открывшемся ответе.',
                    );
                }
                hit = awaiting[0];
            }
        }

        const { rel, task } = hit;
        if (!canAct(ctx.from, task)) return;

        // файл из лички копируем в группу под сообщение задачи — доказательство видно всем, ссылки в отчёте работают
        let storedId = m.message_id;
        if (ctx.chat.id !== rel.chatId) {
            // карточка в группе — копия ответом на неё; карточка в личке — копия с подписью (какая задача и кто прислал)
            const options = task.cardChat
                ? { parse_mode: 'HTML', caption: `${taskTitle(task)} — ${esc(actor(ctx.from))}${m.caption ? `\n${esc(m.caption.slice(0, 500))}` : ''}` }
                : { reply_parameters: { message_id: task.messageId, allow_sending_without_reply: true } };
            const copy = await bot.api.copyMessage(rel.chatId, ctx.chat.id, m.message_id, options).catch(() => null);
            if (!copy) return ctx.reply('Не удалось переслать файл в группу. Попробуйте ещё раз или напишите админу.');
            storedId = copy.message_id;
        }
        task.media ||= [];
        task.media.push(storedId);
        await ctx.react('👍').catch(() => {});

        if (task.status === 'bad') {
            // файл к отказу — скриншот ошибки; подпись берём как причину, если её ещё нет
            if (m.caption && !task.reason) task.reason = m.caption.slice(0, 500);
            save();
            return refreshTask(rel, task);
        }

        const firstConfirm = task.status !== 'ok';
        if (firstConfirm) {
            task.status = 'ok';
            task.by = actor(ctx.from);
            task.at = Date.now();
        }
        save();
        settlePrompt(rel, task);
        await refreshTask(rel, task);
        if (firstConfirm) {
            await refreshSummary(rel);
            await checkCompletion(rel);
        }
    });

    // Админ просто пересылает/вставляет список — бот сам замечает задачи и предлагает создать релиз кнопкой,
    // без /release и Reply. Нужен выключенный privacy mode (иначе боту обычные сообщения не приходят).
    bot.on('message:text', async (ctx, next) => {
        const m = ctx.message;
        if (m.reply_to_message || m.text.startsWith('/') || !guard(ctx)) return next();
        const parsed = parseRelease(m.text);
        const count = parsed.sections.reduce((n, s) => n + s.tasks.filter((t) => t.key).length, 0);
        const current = activeRelease(ctx.chat.id);
        if (count < (current ? 1 : 2)) return next();
        const deadline = defaultDeadline;
        const kb = new InlineKeyboard();
        // уже есть открытый релиз — по умолчанию предлагаем дополнить его, а не плодить второй
        if (current) kb.text('➕ Добавить в текущий релиз', 'o:add').row();
        kb.text(current ? '🆕 Новый релиз (текущий закроется)' : '🚀 Создать релиз', 'o:go');
        if (deadline && !current) kb.text(`⏰ Создать до ${deadline}`, 'o:dl');
        kb.row().text('✖️ Не нужно', 'o:no');
        const question = current
            ? `Нашёл ${count} задач. Уже идёт релиз «${current.title}» — добавить их в него (повторы пропущу) или создать новый?`
            : `Нашёл ${count} задач в ${parsed.sections.length} секц. Создать по ним релиз?`;
        await ctx.reply(question, {
            reply_markup: kb,
            reply_parameters: { message_id: m.message_id },
        });
    });

    bot.callbackQuery(/^o:(go|dl|no|add)$/, async (ctx) => {
        if (!guard(ctx)) return ctx.answerCallbackQuery({ text: 'Только для админов', show_alert: true });
        const action = ctx.match[1];
        const source = ctx.callbackQuery.message?.reply_to_message;
        await ctx.answerCallbackQuery();
        if (action === 'no') return ctx.deleteMessage().catch(() => {});
        const text = source?.text || source?.caption || '';
        if (!text) return ctx.editMessageText('Не вижу исходный список — ответьте /release на сообщение со списком.').catch(() => {});
        await ctx.editMessageText(action === 'add' ? 'Добавляю задачи…' : 'Создаю релиз…').catch(() => {});
        let deadlineAt = null;
        if (action === 'dl') {
            const clock = parseClock(defaultDeadline);
            if (clock) deadlineAt = nextOccurrence(clock.h, clock.m, tz);
        }
        await startRelease(ctx, { text, sourceMessageId: source.message_id, deadlineAt, append: action === 'add' });
        await ctx.deleteMessage().catch(() => {});
    });

    bot.on('message:text', async (ctx, next) => {
        const replyTo = ctx.message.reply_to_message?.message_id;
        let hit = replyTo ? findByReply(activeFor(ctx), replyTo, ctx.chat.id) : null;
        // в личке причину можно написать и без Reply — если ждётся ровно одна
        if (!hit && !replyTo && ctx.chat.type === 'private') {
            const waiting = activeFor(ctx).flatMap((rel) =>
                rel.tasks.filter((t) => t.status === 'bad' && t.reasonPromptId && !t.reason && promptChatOf(rel, t) === ctx.chat.id && isOwnerOf(ctx.from, t)).map((task) => ({ rel, task })),
            );
            if (waiting.length === 1) hit = waiting[0];
        }
        if (!hit || hit.task.reasonPromptId == null || hit.task.status !== 'bad') return next();
        const { rel, task } = hit;
        if (!canAct(ctx.from, task)) return next();

        task.reason = ctx.message.text.slice(0, 500);
        save();
        settlePrompt(rel, task);
        await ctx.react('👍').catch(() => {});
        await refreshTask(rel, task);
        await refreshSummary(rel);
    });

    // ---------- завершение, напоминания, срок ----------
    // Когда ждать больше некого — сообщаем автору списка
    async function checkCompletion(rel) {
        if (pending(rel).length) return;
        const failed = tracked(rel).filter((t) => t.status === 'bad');
        const who = userMention(rel.createdBy);
        const replyTo = { reply_parameters: { message_id: rel.summaryMessageId } };

        if (failed.length) {
            await bot.api.sendMessage(
                rel.chatId,
                `⚠️ ${who}, все ответили, но не пройдены: ${failed.map((t) => taskLink(rel, t)).join(', ')}. Уберите их из списка релиза.`,
                { ...HTML, ...replyTo },
            );
        } else {
            rel.closed = true;
            await sendReport(rel, rel.summaryMessageId);
            await bot.api.sendMessage(rel.chatId, `✅ ${who}, все задачи подтверждены — «${esc(rel.title)}» можно выпускать.`, { ...HTML, ...replyTo });
            // кнопку «сервер переключен» видят только админы: шлём её лично (кому не писали боту /start — кнопка в группе)
            const kb = new InlineKeyboard().text('🚀 Сервер переключен — объявить', `l:${rel.id}:go`);
            const dmText = `🚀 Релиз «${esc(rel.title)}» полностью подтверждён.\nПосле выката нажмите кнопку — в группу уйдёт сообщение командам.`;
            if (!(await dmAdmins(rel.createdBy, dmText, { ...HTML, reply_markup: kb }))) {
                await bot.api.sendMessage(rel.chatId, dmText, { ...HTML, ...replyTo, reply_markup: kb });
            }
        }
        save();
    }

    // onlyKey — напомнить одному тестировщику (кнопка в /who), иначе всем, кто не ответил. Возвращает, скольким напомнили
    async function remind(rel, now = Date.now(), { onlyKey } = {}) {
        const byTester = new Map();
        for (const t of pending(rel).filter((x) => !onlyKey || testerKey(x.tester) === onlyKey)) {
            const k = testerKey(t.tester);
            if (!byTester.has(k)) byTester.set(k, { tester: t.tester, tasks: [] });
            byTester.get(k).tasks.push(t);
        }
        if (!byTester.size) return 0;

        if (!onlyKey) rel.lastRemindAt = now;
        save();
        const inGroup = [];
        for (const { tester, tasks } of byTester.values()) {
            const dm = dmChatFor(tester);
            if (dm) {
                const sent = await bot.api
                    .sendMessage(dm, `🔔 Ждём подтверждение по «${esc(rel.title)}»: ${tasks.map((t) => taskLink(rel, t)).join(', ')}`, HTML)
                    .catch(() => null); // бота заблокировали или чат недоступен — напомним в группе
                if (sent) continue;
            }
            inGroup.push(`${mention(tester)} (${tasks.map((t) => taskLink(rel, t)).join(', ')})`);
        }
        if (inGroup.length) {
            await bot.api.sendMessage(rel.chatId, `🔔 ${inGroup.join('; ')} — ждём подтверждение (✅ + скриншот/видео, ❌, ➖ или 🚧).`, {
                ...HTML,
                reply_parameters: { message_id: rel.summaryMessageId },
            });
        }
        return byTester.size;
    }

    // ---------- контроль для админа: «кто что не закрыл», предупреждение до срока, панель, «бот жив» ----------
    // Тестировщики с незакрытыми задачами, у кого больше всего — первыми
    const openByTester = (rel) => {
        const byTester = new Map();
        for (const t of pending(rel)) {
            const k = testerKey(t.tester);
            if (!byTester.has(k)) byTester.set(k, { key: k, tester: t.tester, tasks: [] });
            byTester.get(k).tasks.push(t);
        }
        return [...byTester.values()].sort((a, b) => b.tasks.length - a.tasks.length);
    };
    // Без тегов (имя, а не @username): админский обзор не должен уведомлять тестировщиков
    const whoLines = (rel, now) =>
        openByTester(rel).map(({ tester, tasks }) => {
            const since = Math.min(...tasks.map((t) => t.postedAt || now));
            return `• ${esc(tester.name)} — ${tasks.length}: ${tasks.map((t) => esc(label(t))).join(', ')} (ждёт ${formatDuration(now - since)})`;
        });
    const whoKeyboard = (rel) => {
        const kb = new InlineKeyboard();
        for (const { key, tester, tasks } of openByTester(rel)) kb.text(`🔔 ${tester.name} (${tasks.length})`, `w:${rel.id}:${key}`).row();
        return kb.text('🔔 Напомнить всем', `w:${rel.id}:all`);
    };

    async function sendWho(ctx, rel) {
        const now = Date.now();
        if (!pending(rel).length) return ctx.reply('✅ Все ответили — открытых задач нет.');
        const deadline = rel.deadlineAt > now ? `\nСрок: ${time(rel.deadlineAt, tz)} (осталось ${formatDuration(rel.deadlineAt - now)})` : '';
        await ctx.reply(`👥 <b>Кто что не закрыл</b> — «${esc(rel.title)}»\nОткрыто задач: ${pending(rel).length}${deadline}\n\n${whoLines(rel, now).join('\n')}`, {
            ...HTML,
            reply_markup: whoKeyboard(rel),
        });
    }

    bot.command('who', async (ctx) => {
        if (!guard(ctx)) return;
        const rel = activeRelease(ctx.chat.id);
        if (!rel) return ctx.reply('Активного релиза нет.');
        await sendWho(ctx, rel);
    });

    // Кнопки «🔔 имя» и «🔔 Напомнить всем» (в /who, панели и предупреждении перед сроком)
    bot.callbackQuery(/^w:([^:]+):(.+)$/, async (ctx) => {
        if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: 'Только для админов', show_alert: true });
        const [, relId, who] = ctx.match;
        const rel = state.releases[relId];
        if (!rel || rel.closed) return ctx.answerCallbackQuery({ text: 'Релиз уже закрыт', show_alert: true });
        const n = await remind(rel, Date.now(), who === 'all' ? {} : { onlyKey: who });
        await ctx.answerCallbackQuery({ text: n ? `Напомнил: ${n} 🔔` : 'Все уже ответили', show_alert: !n });
    });

    // Раз в рабочее время за 3 часа и за 1 час до срока — админам лично (или в группу), с кнопками «напомнить»
    async function warnBeforeDeadline(rel, now) {
        if (!rel.deadlineAt || rel.deadlineAt <= now || !isWorkingTime(now)) return;
        const left = rel.deadlineAt - now;
        const h = [1, 3].find((x) => left <= x * HOUR);
        if (!h || (rel.warnedH && rel.warnedH <= h) || !pending(rel).length) return;
        rel.warnedH = h;
        save();

        const text = `⏳ До срока по «${esc(rel.title)}» осталось ${formatDuration(left)} (${time(rel.deadlineAt, tz)}). Не закрыто задач: ${pending(rel).length}\n\n${whoLines(rel, now).join('\n')}`;
        if (!(await dmAdmins(rel.createdBy, text, { ...HTML, reply_markup: whoKeyboard(rel) }))) {
            await bot.api.sendMessage(rel.chatId, text, { ...HTML, reply_markup: whoKeyboard(rel) });
        }
    }

    // /panel — кнопки вместо команд
    const panelKeyboard = () =>
        new InlineKeyboard()
            .text('📊 Статус', 'p:status')
            .text('👥 Кто отстаёт', 'p:who')
            .row()
            .text('🔔 Напомнить всем', 'p:remind')
            .text('📋 Отчёт', 'p:report')
            .row()
            .text('⏰ Срок', 'p:dl')
            .text('🚀 Объявить', 'p:live')
            .row()
            .text('✏️ Переназначить', 'p:assign')
            .text('🛑 Закрыть релиз', 'p:stop');

    bot.command('panel', async (ctx) => {
        if (!guard(ctx)) return;
        const rel = activeRelease(ctx.chat.id) || latestRelease(ctx.chat.id);
        if (!rel) return ctx.reply('Релизов пока нет — вставьте список задач, и я предложу создать релиз.');
        const done = tracked(rel).filter((t) => t.status === 'ok' || t.status === 'na').length;
        await ctx.reply(`🎛 <b>Панель</b> — «${esc(rel.title)}»${rel.closed ? ' (закрыт)' : ''}\nГотово: ${done} из ${tracked(rel).length}`, {
            ...HTML,
            reply_markup: panelKeyboard(),
        });
    });

    bot.callbackQuery(/^p:(status|who|remind|report|dl|setdl|live|assign|stop|stopok|cancel)(?::(\d{4}|off))?$/, async (ctx) => {
        if (!guard(ctx)) return ctx.answerCallbackQuery({ text: 'Только для админов', show_alert: true });
        const [, action, arg] = ctx.match;
        if (action === 'cancel') {
            await ctx.answerCallbackQuery();
            return ctx.deleteMessage().catch(() => {});
        }
        const rel = activeRelease(ctx.chat.id) || latestRelease(ctx.chat.id);
        if (!rel) return ctx.answerCallbackQuery({ text: 'Релизов пока нет', show_alert: true });
        const needsOpen = ['who', 'remind', 'dl', 'setdl', 'assign', 'stop', 'stopok'].includes(action);
        if (needsOpen && rel.closed) return ctx.answerCallbackQuery({ text: 'Релиз уже закрыт', show_alert: true });

        if (action === 'remind') {
            const n = await remind(rel, Date.now());
            return ctx.answerCallbackQuery({ text: n ? `Напомнил: ${n} 🔔` : 'Все уже ответили', show_alert: !n });
        }
        await ctx.answerCallbackQuery();
        if (action === 'status') return ctx.reply(summaryText(rel), { ...HTML, reply_parameters: { message_id: rel.summaryMessageId } });
        if (action === 'who') return sendWho(ctx, rel);
        if (action === 'assign') {
            const v = reassignListView(rel, 'L');
            return ctx.reply(v.text, { ...HTML, reply_markup: v.kb });
        }
        if (action === 'report') return sendReport(rel);
        if (action === 'live') return announceLive(ctx, rel, { force: false });
        if (action === 'dl') {
            return ctx.reply('Какой срок поставить?', {
                reply_markup: new InlineKeyboard().text('15:00', 'p:setdl:1500').text('17:00', 'p:setdl:1700').text('19:00', 'p:setdl:1900').row().text('Снять срок', 'p:setdl:off'),
            });
        }
        if (action === 'setdl') {
            if (arg === 'off') {
                delete rel.deadlineAt;
            } else {
                rel.deadlineAt = nextOccurrence(Number(arg.slice(0, 2)), Number(arg.slice(2)), tz);
                delete rel.deadlineNotified;
                delete rel.warnedH;
            }
            save();
            await refreshSummary(rel);
            await ctx.editMessageText(rel.deadlineAt ? `Срок релиза: ${time(rel.deadlineAt, tz)}` : 'Срок снят.').catch(() => {});
            return;
        }
        if (action === 'stop') {
            return ctx.reply(`Закрыть релиз «${rel.title}»? Напоминаний больше не будет.`, {
                reply_markup: new InlineKeyboard().text('Да, закрыть', 'p:stopok').text('Отмена', 'p:cancel'),
            });
        }
        if (action === 'stopok') {
            rel.closed = true;
            journal(ctx.from, 'закрыл релиз', rel);
            save();
            await ctx.editMessageText(`Релиз «${rel.title}» закрыт, напоминаний больше не будет.`).catch(() => {});
        }
    });

    // «Бот жив»: при запуске после простоя и раз в рабочий день — личное сообщение админам.
    // Сам упавший бот написать не может, зато по отсутствию сообщения сбой заметен, а после запуска видно, сколько он был недоступен.
    let lastSeenSavedAt = 0;
    const touchSeen = (now) => {
        state.lastSeenAt = now;
        if (now - lastSeenSavedAt >= 5 * 60_000) {
            lastSeenSavedAt = now;
            save();
        }
    };
    const tellAdminsDm = async (text) => {
        for (const id of adminDmIds()) await bot.api.sendMessage(id, text, HTML).catch(() => null);
    };

    async function announceStart(now = Date.now()) {
        const prev = state.lastSeenAt;
        touchSeen(now);
        save();
        if (!prev || now - prev < 10 * 60_000) return; // быстрый перезапуск (правка .env) не шумим
        const since = new Date(prev).toLocaleString('ru-RU', { timeZone: tz });
        await tellAdminsDm(
            `♻️ Бот снова работает. Был недоступен с ${since} (${formatDuration(now - prev)}).` +
                (now - prev > 24 * HOUR ? ' Сообщения старше суток Telegram не хранит, они могли потеряться.' : ' Сообщения за это время Telegram доставит, бот их обработает.'),
        );
    }

    const heartbeatClock = parseClock(heartbeatTime);
    // Раз в неделю (понедельник, после времени утренней сводки) — итоги последних 7 дней по всем группам
    async function maybeWeekly(now) {
        if (!weeklyStats) return;
        const lc = localClock(now, tz);
        const clock = digestClock || { h: 9, m: 30 };
        if (lc.weekday !== 'Mon' || lc.minutes < clock.h * 60 + clock.m || state.lastWeeklyDay === lc.day) return;
        state.lastWeeklyDay = lc.day;
        save();
        const recent = releases().filter((r) => now - stamp(r) <= 7 * 24 * HOUR);
        if (!recent.length) return;
        await tellAdminsDm(`🗓 <b>Итоги недели</b>\n${renderStats(computeStats(recent))}`);
    }

    async function maybeHeartbeat(now) {
        if (!heartbeatClock) return;
        const lc = localClock(now, tz);
        if (['Sat', 'Sun'].includes(lc.weekday) || lc.minutes < heartbeatClock.h * 60 + heartbeatClock.m || state.lastHeartbeatDay === lc.day) return;
        state.lastHeartbeatDay = lc.day;
        save();
        const open = releases().filter((r) => !r.closed);
        const waiting = open.reduce((n, r) => n + pending(r).length, 0);
        await tellAdminsDm(`🟢 Бот работает. ${open.length ? `Открытых релизов: ${open.length}, задач без ответа: ${waiting}.` : 'Открытых релизов нет.'}`);
    }

    async function escalate(rel) {
        rel.deadlineNotified = true;
        save();
        const open = pending(rel);
        const failed = tracked(rel).filter((t) => t.status === 'bad');
        const tags = [userMention(rel.createdBy), ...rmUsernames.map((u) => `@${u}`)].join(' ');
        const lines = [`⏰ ${tags}, срок по «${esc(rel.title)}» вышел.`];
        if (open.length) lines.push(`Не подтверждены: ${open.map((t) => `${taskLink(rel, t)} (${mention(t.tester)})`).join(', ')}`);
        if (failed.length) lines.push(`Не пройдены: ${failed.map((t) => taskLink(rel, t)).join(', ')}`);
        await bot.api.sendMessage(rel.chatId, lines.join('\n'), { ...HTML, reply_parameters: { message_id: rel.summaryMessageId } });
    }

    // Чем ближе срок, тем чаще напоминаем
    function remindInterval(rel, now) {
        const left = rel.deadlineAt ? rel.deadlineAt - now : Infinity;
        if (left > 0 && left <= HOUR) return 15;
        if (left > 0 && left <= 3 * HOUR) return 30;
        return remindEveryMin;
    }

    // Утренняя сводка админам: раз в рабочий день после digestTime, пока релиз не закрыт
    const digestClock = parseClock(digestTime);
    async function maybeDigest(rel, now) {
        if (!digestClock) return;
        const lc = localClock(now, tz);
        if (['Sat', 'Sun'].includes(lc.weekday) || lc.minutes < digestClock.h * 60 + digestClock.m || rel.lastDigestDay === lc.day) return;
        rel.lastDigestDay = lc.day;
        save();
        if (localClock(stamp(rel), tz).day === lc.day) return; // релиз создан сегодня — сводка не нужна

        const text = `☀️ <b>Утренняя сводка</b>\n${summaryText(rel)}`;
        // лично достать админов не удалось (не писали боту /start) — отправляем в группу
        if (!(await dmAdmins(rel.createdBy, text, HTML))) await bot.api.sendMessage(rel.chatId, text, HTML);
    }

    /** Вызывается раз в минуту: срок, сводка, напоминания. */
    async function tick(now = Date.now()) {
        touchSeen(now);
        await maybeHeartbeat(now);
        await maybeWeekly(now);
        for (const rel of releases()) {
            if (rel.closed) continue;
            if (rel.deadlineAt && now >= rel.deadlineAt && !rel.deadlineNotified) await escalate(rel);
            await maybeDigest(rel, now);
            await warnBeforeDeadline(rel, now);

            const nearDeadline = rel.deadlineAt && rel.deadlineAt > now && rel.deadlineAt - now <= 3 * HOUR;
            if (!isWorkingTime(now) && !nearDeadline) continue;
            if (now - rel.lastRemindAt >= remindInterval(rel, now) * 60_000) await remind(rel, now);
        }
    }

    return { bot, tick, announceStart };
}
