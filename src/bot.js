import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadTestersFile, saveTestersFile } from './testers-file.js';
import { loadState, saveState, backupState } from './state.js';

const {
    BOT_TOKEN,
    ADMIN_IDS = '',
    ADMIN_USERNAMES = '',
    ALLOWED_CHAT_ID = '',
    REMIND_EVERY_MIN = '60',
    WORK_HOURS = '9-19',
    TZ_NAME = 'Asia/Dushanbe',
    RM_USERNAMES = '',
    DIGEST_TIME = '09:30',
    HEARTBEAT_TIME = '09:00',
    ADMIN_NOTIFY = 'owner',
    WEEKLY_STATS = 'true',
    TASKS_IN_DM = 'true',
    DEFAULT_DEADLINE = '17:00',
} = process.env;

if (!BOT_TOKEN) throw new Error('❌ Не задан BOT_TOKEN в .env');

const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const testersPath = fileURLToPath(new URL('../testers.json', import.meta.url));
const loadTesters = () => loadTestersFile(testersPath);
const state = loadState();

// релизы старого формата (по секциям) закрываем, а закрытые старше 90 дней удаляем (их хватает для /stats), чтобы файл не рос
for (const [id, rel] of Object.entries(state.releases)) {
    if (!rel.tasks) rel.closed = true;
    if (rel.closed && Date.now() - parseInt(id, 36) > 90 * 24 * 3_600_000) delete state.releases[id];
}

const { bot, tick, announceStart } = createApp({
    token: BOT_TOKEN,
    adminIds: list(ADMIN_IDS).map(Number),
    adminUsernames: list(ADMIN_USERNAMES).map((u) => u.replace(/^@/, '').toLowerCase()),
    allowedChatIds: list(ALLOWED_CHAT_ID), // можно несколько групп через запятую
    remindEveryMin: Number(REMIND_EVERY_MIN),
    workHours: WORK_HOURS.split('-').map(Number),
    tz: TZ_NAME,
    rmUsernames: list(RM_USERNAMES).map((u) => u.replace(/^@/, '')),
    digestTime: DIGEST_TIME,
    heartbeatTime: HEARTBEAT_TIME,
    adminNotify: ADMIN_NOTIFY,
    weeklyStats: WEEKLY_STATS !== 'false',
    tasksInDm: TASKS_IN_DM !== 'false',
    defaultDeadline: DEFAULT_DEADLINE,
    testers: loadTesters(),
    loadTesters,
    saveTesters: (list) => saveTestersFile(testersPath, list),
    state,
    save: () => saveState(state),
});

setInterval(() => tick().catch(console.error), 60_000);

// копия состояния при старте и каждые 6 часов (в течение дня файл обновляется, хранится последние 14 дней)
const backup = () => {
    try {
        backupState();
    } catch (err) {
        console.error('❌ Не удалось сделать копию состояния:', err.message);
    }
};
backup();
setInterval(backup, 6 * 3_600_000);

bot.catch((err) => console.error('❌ Ошибка бота:', err.error?.message || err));
bot.start({
    onStart: (me) => {
        console.log(`✅ Бот @${me.username} запущен`);
        announceStart().catch(console.error); // админам: «бот снова работает», если был простой
    },
});
