import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
const DIR = new URL('../data/', import.meta.url);
const FILE = new URL('state.json', DIR);

// state = { releases: { [id]: release }, dm: {...} } — хранится в файле, чтобы статусы пережили перезапуск бота
export function loadState() {
    if (!existsSync(FILE)) return { releases: {} };
    return JSON.parse(readFileSync(FILE, 'utf8'));
}

// Пишем во временный файл и переименовываем — обрыв посреди записи не оставит битый state.json
export function saveState(state) {
    mkdirSync(DIR, { recursive: true });
    const tmp = new URL('state.json.tmp', DIR);
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, FILE);
}

/** Копия state.json в data/backup/state-ГГГГ-ММ-ДД.json (в течение дня перезаписывается), хранит последние keep штук. */
export function backupState({ keep = 14, file = FILE, dir = new URL('backup/', DIR) } = {}) {
    if (!existsSync(file)) return null;
    mkdirSync(dir, { recursive: true });
    const name = `state-${new Date().toISOString().slice(0, 10)}.json`;
    copyFileSync(file, new URL(name, dir));

    const old = readdirSync(dir).filter((f) => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -keep);
    for (const f of old) unlinkSync(new URL(f, dir));
    return name;
}
