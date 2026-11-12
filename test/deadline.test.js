import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClock, nextOccurrence } from '../src/deadline.js';

test('parseClock понимает "17:00" и "до 17:00" и режет остаток', () => {
    assert.deepEqual(parseClock('до 17:00 текст'), { h: 17, m: 0, length: 8 });
    assert.deepEqual(parseClock('9:30'), { h: 9, m: 30, length: 4 });
    assert.equal(parseClock('25:00'), null);
    assert.equal(parseClock('Сбережения (2 задачи)'), null);
});

test('nextOccurrence: сегодня, если время впереди, иначе завтра (Душанбе, UTC+5)', () => {
    const now = Date.UTC(2026, 10, 2, 5, 0); // 10:00 по Душанбе
    assert.equal(nextOccurrence(17, 0, 'Asia/Dushanbe', now) - now, 7 * 3_600_000);
    assert.equal(nextOccurrence(9, 0, 'Asia/Dushanbe', now) - now, 23 * 3_600_000);
});

test('localClock: дата, минуты и день недели в часовом поясе', async () => {
    const { localClock } = await import('../src/deadline.js');
    // 2026-11-02 (понедельник) 23:30 UTC = 03.11 04:30 по Душанбе (вторник)
    assert.deepEqual(localClock(Date.UTC(2026, 10, 2, 23, 30), 'Asia/Dushanbe'), { day: '2026-11-03', minutes: 270, weekday: 'Tue' });
    assert.equal(localClock(Date.UTC(2026, 10, 2, 5, 0), 'Asia/Dushanbe').weekday, 'Mon');
});
