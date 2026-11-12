import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatTesters, saveTestersFile, loadTestersFile, parseAddTester } from '../src/testers-file.js';

const LIST = [
    { name: 'A', username: 'user_a', titles: ['Секция'], projects: ['SN', 'EJ'] },
    { name: 'Б', userId: 5, titles: [], projects: [] },
];

test('formatTesters: объекты в несколько строк, массивы в одну, JSON остаётся валидным', () => {
    const text = formatTesters(LIST);
    assert.match(text, /"projects": \["SN", "EJ"\]/);
    assert.match(text, /"titles": \[\]/);
    assert.deepEqual(JSON.parse(text), LIST);
});

test('saveTestersFile сохраняет окончания строк файла (CRLF на Windows)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'testers-'));
    const file = join(dir, 'testers.json');
    writeFileSync(file, '[\r\n]\r\n');
    saveTestersFile(file, LIST);
    const raw = readFileSync(file, 'utf8');
    assert.ok(raw.includes('\r\n') && !/[^\r]\n/.test(raw));
    assert.deepEqual(loadTestersFile(file), LIST);

    const lf = join(dir, 'lf.json');
    writeFileSync(lf, '[]\n');
    saveTestersFile(lf, LIST);
    assert.ok(!readFileSync(lf, 'utf8').includes('\r'));
});

test('parseAddTester: проекты приводятся к верхнему регистру, секции делятся по ;', () => {
    const r = parseAddTester('@new_user ew, cvm | Первая; Вторая секция', undefined);
    assert.deepEqual(r, { who: { name: 'new_user', username: 'new_user' }, projects: ['EW', 'CVM'], titles: ['Первая', 'Вторая секция'] });
    assert.deepEqual(parseAddTester('123456 KYC', undefined).who, { name: 'QA 123456', userId: 123456 });
});

test('loadTestersFile убирает "@" из username (иначе ломаются тег и права на кнопки)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'testers-at-'));
    const file = join(dir, 'testers.json');
    writeFileSync(file, JSON.stringify([{ name: 'Н', username: '@Nargis_Mirzoeva', titles: [], projects: ['RKO'] }, { name: 'Б', userId: 5, titles: [], projects: [] }]));
    const [a, b] = loadTestersFile(file);
    assert.equal(a.username, 'Nargis_Mirzoeva');
    assert.equal(b.username, undefined);
});
