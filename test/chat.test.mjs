import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { assertNewChat, newChat } from '../lib/chat.mjs';
import { runEvals } from '../lib/evals.mjs';
import { loadSelectors, pick, tryPick } from '../lib/stand.mjs';

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

test('выбор агента не открывает задачу из истории', async () => {
  const page = await browser.newPage();
  try {
    await page.route('https://test.local/**', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<button onclick="location.href='/workspaces/123/sessions/old'">Старая задача Агент</button>
        <button onclick="document.querySelector('dialog').showModal()">Добавить агента</button>
        <textarea placeholder="Чем я могу помочь?"></textarea>
        <dialog><button onclick="document.body.dataset.selected='yes'; this.closest('dialog').close()">Агент</button></dialog>`,
    }));
    const sel = loadSelectors();
    sel.chat.settleMs = 0;
    await newChat(page, sel, 'https://test.local/workspaces/123', { agentName: 'Агент' });
    assert.equal(await page.locator('body').getAttribute('data-selected'), 'yes');
    assert.ok(!page.url().includes('/sessions/'));
  } finally { await page.close(); }
});

test('существующая сессия блокируется до отправки', () => {
  assert.throws(() => assertNewChat({ url: () => 'https://test.local/workspaces/123/sessions/old' }), /существующий чат/);
  assert.doesNotThrow(() => assertNewChat({ url: () => 'https://test.local/workspaces/123?tab=new-task' }));
});

test('для вложений не выбирается поле загрузки папки', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<input type="file" webkitdirectory>');
    const candidates = loadSelectors().chat.attachInput;
    assert.equal(await tryPick(page, candidates, { attached: true, timeout: 0 }), null);
    await page.locator('body').evaluate((body) => {
      const input = document.createElement('input');
      input.type = 'file';
      body.append(input);
    });
    assert.equal(await (await pick(page, candidates, { attached: true })).getAttribute('webkitdirectory'), null);
  } finally { await page.close(); }
});

test('замер ответов исключает подготовку и отдельно учитывает уточнение', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-timing-test-'));
  const page = await browser.newPage();
  try {
    const caseDir = path.join(dir, 'evals', 'кейс-тест');
    fs.mkdirSync(caseDir, { recursive: true });
    fs.writeFileSync(path.join(caseDir, 'prompt.md'), '## Промпт\nТест\n\n## Canned-ответы\n- Да\n');
    await page.route('https://test.local/**', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<main>
        <textarea placeholder="Чем я могу помочь?"></textarea>
        <button id="send" disabled>Отправить</button>
        <div id="thread"></div>
        </main>
        <script>
        const send = document.querySelector('#send');
        setTimeout(() => send.disabled = false, 3500);
        send.onclick = () => {
          send.hidden = true;
          document.querySelector('#thread').innerHTML = '<div data-turn-id="1">Первый ответ</div>';
          setTimeout(() => {
            document.querySelector('#thread').insertAdjacentHTML('beforeend',
              '<section id="question"><label><input type="radio" name="answer">Да</label><button>Пропустить</button><button id="submit">Отправить</button></section>');
            document.querySelector('#submit').onclick = () => {
              document.querySelector('#question').remove();
              document.querySelector('#thread').insertAdjacentHTML('beforeend', '<div data-turn-id="2">Итоговый ответ</div>');
            };
          }, 100);
        };
        </script>`,
    }));
    const sel = loadSelectors();
    sel.chat.settleMs = 0;
    sel.chat.stableMs = 200;
    sel.chat.answerTimeoutMs = 15000;
    const result = await runEvals(page, sel, { dir }, {
      chatUrl: 'https://test.local/workspaces/123', runs: 1, date: '2026-11-11', runId: 'test',
      fixtures: false, download: false,
    });
    const [run] = JSON.parse(fs.readFileSync(path.join(result.resultsDir, 'run-log.json'), 'utf8'));
    assert.equal(run.status, 'done');
    assert.equal(run.timingVersion, 2);
    assert.equal(run.responseTimesSec.length, 2);
    assert.ok(run.responseTimesSec.every((seconds) => seconds >= 1));
    assert.ok(Math.abs(run.answerSec - run.responseTimesSec.reduce((a, b) => a + b, 0)) <= 1);
    assert.ok(run.setupToAnswerSec - run.answerSec >= 2, 'ожидание доступности кнопки не должно входить в замер ответов');
    assert.ok(run.totalSec >= run.setupToAnswerSec);
    assert.match(fs.readFileSync(result.facts, 'utf8'), /по ответам:/);
  } finally {
    await page.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
