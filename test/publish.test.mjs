import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Поддельный Диск в памяти: как настоящий, не даёт создать файл в несуществующей папке.
function fakeDisk(dirs, files = {}, { lockFirstMkdir = false } = {}) {
  let locked = lockFirstMkdir;
  const dirSet = new Set(dirs);
  const stored = new Map(Object.entries(files));
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.searchParams.get('path')?.replace(/^disk:\//, '');
    const send = (code, body = {}) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/up') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      stored.set(p, Buffer.concat(chunks).toString());
      return send(201);
    }
    const parent = p ? p.split('/').slice(0, -1).join('/') : '';
    if (req.method === 'GET' && u.pathname === '/resources') {
      if (!dirSet.has(p)) return send(404, { error: 'DiskNotFoundError' });
      const kids = (q) => q.startsWith(p + '/') && !q.slice(p.length + 1).includes('/');
      const items = [...[...dirSet].filter(kids).map((q) => ({ type: 'dir', name: q.split('/').pop(), path: 'disk:/' + q })),
        ...[...stored.keys()].filter(kids).map((q) => ({ type: 'file', name: q.split('/').pop(), path: 'disk:/' + q }))];
      return send(200, { _embedded: { items } });
    }
    if (req.method === 'PUT' && u.pathname === '/resources') {
      if (locked) { locked = false; return send(423, { error: 'DiskResourceLockedError' }); }
      if (parent && !dirSet.has(parent)) return send(409, { error: 'DiskPathPointsToExistentDirectoryError' });
      if (dirSet.has(p)) return send(409);
      dirSet.add(p);
      return send(201);
    }
    if (req.method === 'GET' && u.pathname === '/resources/upload') {
      if (!dirSet.has(parent)) return send(409, { error: 'нет родительской папки' });
      return send(200, { href: `http://127.0.0.1:${server.address().port}/up?path=${encodeURIComponent(p)}` });
    }
    send(404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, stored, dirSet })));
}

test('publish раскладывает артефакты по свободным номерам, неполные — отдельно, время и ленты — в папку запуска', async () => {
  const case_ = 'Бенчмарк/X';
  const res = `${case_}/Результаты тестирования/track A/GigaCowork`;
  const disk = await fakeDisk(
    ['Бенчмарк', case_, `${case_}/Результаты тестирования`, `${case_}/Результаты тестирования/track A`, res, `${res}/1 прогон`, `${res}/2 прогон`],
    { [`${res}/1 прогон/ручной.xlsx`]: 'manual' },
    { lockFirstMkdir: true }, // Диск иногда отвечает 423: раннер должен повторить, а не упасть
  );
  process.env.YADISK_TOKEN = 't';
  process.env.YADISK_API = `http://127.0.0.1:${disk.server.address().port}`;
  const { publish } = await import('../yadisk-test.mjs');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-publish-'));
  try {
    const entry = (run, status, extra = {}) => ({ case: 'кейс-тест', run, status, track: 'A', startedAt: 't', timingVersion: 2, anomalies: [], answerSec: 10 * run, responseTimesSec: [10 * run], totalSec: 11 * run, ...extra });
    fs.writeFileSync(path.join(dir, 'run-log.json'), JSON.stringify([entry(1, 'done'), entry(2, 'done'), entry(3, 'incomplete'), entry(4, 'done')]));
    for (const r of [1, 2, 3]) {
      const art = path.join(dir, 'артефакты', 'кейс-тест', `прогон-${r}`);
      fs.mkdirSync(art, { recursive: true });
      fs.writeFileSync(path.join(art, `результат-${r}.xlsx`), `art${r}`);
      const feed = path.join(dir, 'прогоны', 'кейс-тест', `прогон-${r}`);
      fs.mkdirSync(feed, { recursive: true });
      fs.writeFileSync(path.join(feed, 'лента.md'), `лента ${r}`);
    }
    const report = `${case_}/Отчёты/Запуски раннера/stamp`;
    const t = await publish({ resultsDir: dir, caseFolder: case_, track: 'A', reportFolder: report, meta: { case: 'X' } });

    // номер 1 занят ручным файлом; пустая заготовка «2 прогон» свободна → 2, 3, (4 — прогон без артефактов)
    assert.equal(disk.stored.get(`${res}/1 прогон/ручной.xlsx`), 'manual');
    assert.equal(disk.stored.get(`${res}/2 прогон/результат-1.xlsx`), 'art1');
    assert.equal(disk.stored.get(`${res}/3 прогон/результат-2.xlsx`), 'art2');
    assert.ok(![...disk.stored.keys()].some((k) => k.includes('результат-3') && k.includes('Результаты тестирования')));
    assert.equal(disk.stored.get(`${report}/неполные-прогоны/прогон-3/результат-3.xlsx`), 'art3');
    assert.equal(disk.stored.get(`${report}/ленты/прогон-2.md`), 'лента 2');
    assert.deepEqual(t.map((x) => x.diskRun), [2, 3, null, null]);
    assert.match(t[3].anomalies.join(), /артефактов нет/);
    assert.equal(JSON.parse(disk.stored.get(`${report}/время.json`)).runs[1].answerSec, 20);
  } finally {
    disk.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
