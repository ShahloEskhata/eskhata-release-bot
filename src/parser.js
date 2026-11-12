// Заголовок секции: "Сбережения и накопления (2 задачи)" / "Продукт: P2P Эквайринг (4 задачи)"
const HEADER_RE = /^[*_#\s]*(.+?)\s*\(\s*(\d+)\s*задач[а-яё]*\s*\)[*_\s]*:?$/i;
// Строка задачи: "[SN-561](https://...) — описание", "- SN-561 — описание" (маркер списка необязателен)
const TASK_RE = /^(?:(?:[-•*]|\d+[.)])\s*)?\[?([A-Z][A-Z0-9]*)-(\d+)\]?/;

// неразрывные и нулевой ширины пробелы часто появляются при копировании из Jira/Word
const clean = (text) => text.replace(/[  -​ ﻿]/g, ' ').split(/\r?\n/);

/**
 * Разбирает текст списка релиза на название и секции (по заголовкам со счётчиком задач).
 * Каждая секция делится на задачи: строка с ключом Jira и следующие за ней строки
 * ("Исполнитель", "MR" и т.п.) до следующей задачи.
 */
export function parseRelease(text) {
    const sections = [];
    let title = '';
    let current = null;
    let currentTask = null;

    // неразрывные и нулевой ширины пробелы часто появляются при копировании из Jira/Word
    for (const raw of clean(text)) {
        const line = raw.trim();
        if (!line) continue;

        const header = line.match(HEADER_RE);
        if (header && !TASK_RE.test(line)) {
            current = {
                title: header[1].replace(/^Продукт:\s*/i, '').trim(),
                declared: Number(header[2]),
                tasks: [],
                taskKeys: [],
                orphanLines: [],
            };
            currentTask = null;
            sections.push(current);
            continue;
        }

        if (!current) {
            // до первой секции — шапка; название релиза берём из первой строки со словом "релиз"
            if (!title || (/релиз|release/i.test(line) && !/релиз|release/i.test(title))) title = line;
            continue;
        }

        const task = line.match(TASK_RE);
        if (task) {
            currentTask = { key: `${task[1]}-${task[2]}`, lines: [raw.trimEnd()] };
            current.tasks.push(currentTask);
            current.taskKeys.push(currentTask.key);
        } else if (currentTask) {
            currentTask.lines.push(raw.trimEnd());
        } else {
            current.orphanLines.push(raw.trimEnd());
        }
    }

    // секция без распознанных задач (другой формат строк) — целиком одна задача, чтобы её не потерять
    for (const s of sections) {
        if (!s.tasks.length && s.orphanLines.length) s.tasks.push({ key: null, lines: s.orphanLines });
    }

    // заголовков секций нет, но есть строки с ключами Jira — группируем задачи по проектам (BNPL, EA…)
    if (!sections.length) return parseFlat(text);

    return { title, sections };
}

/** Список без заголовков секций: "[BNPL-968] - описание" на каждой строке. Секции = проекты Jira. */
function parseFlat(text) {
    let title = '';
    let currentTask = null;
    const byProject = new Map();

    for (const raw of clean(text)) {
        const line = raw.trim();
        if (!line) continue;
        const task = line.match(TASK_RE);
        if (task) {
            const project = task[1];
            if (!byProject.has(project)) byProject.set(project, { title: project, declared: 0, tasks: [], taskKeys: [], orphanLines: [] });
            const section = byProject.get(project);
            currentTask = { key: `${project}-${task[2]}`, lines: [raw.trimEnd()] };
            section.tasks.push(currentTask);
            section.taskKeys.push(currentTask.key);
            section.declared++;
        } else if (currentTask) {
            currentTask.lines.push(raw.trimEnd());
        } else if (!title || (/релиз|release/i.test(line) && !/релиз|release/i.test(title))) {
            title = line;
        }
    }
    return { title, sections: [...byProject.values()], inferred: true };
}

/** Секции, где заявленное число задач («(3 задачи)») не совпало с найденным, — признак опечатки в ключе. */
export const countMismatches = (parsed) =>
    parsed.inferred ? [] : parsed.sections.filter((s) => s.taskKeys.length && s.taskKeys.length !== s.declared);

/**
 * Ищет тестировщика для задачи: сначала по префиксу ключа (EJ-697 → проект EJ), потому что в одной секции
 * (например, "EO Admin and Integration") бывают задачи разных команд; если проекта нет в testers.json —
 * по названию секции.
 */
export function findTestersForTask(task, testers) {
    const project = task.key?.split('-')[0];
    const byProject = project ? testers.filter((t) => (t.projects || []).some((p) => p.toUpperCase() === project)) : [];
    if (byProject.length) return byProject;

    const title = task.section.toLowerCase();
    return testers.filter((t) => (t.titles || []).some((k) => title.includes(k.toLowerCase())));
}

/** Первый подходящий тестировщик (если на проекте их несколько, между ними делит app.js). */
export const findTesterForTask = (task, testers) => findTestersForTask(task, testers)[0] ?? null;
