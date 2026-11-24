// Чат агента: новая задача, вложения, отправка, ожидание ответа, question, команды, скачивание документов.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { anyVisible, click, log, pick, sleep, toLocator, tryPick } from './stand.mjs';
import { normName } from './disk-case.mjs';

// Подстановка {name} в селекторы-шаблоны (пункт меню команды, агент в списке).
const withName = (cands, name) =>
  (cands || []).map((c) => JSON.parse(JSON.stringify(c).replaceAll('{name}', JSON.stringify(name).slice(1, -1))));

const workspaceRoot = (url) => {
  const m = url.match(/^(.*\/workspaces\/[0-9a-f-]{36})/);
  return m ? m[1] : url.replace(/[?#].*$/, '');
};

// Новая задача = вкладка ?tab=new-task пространства; чат получает URL /sessions/<uuid> после отправки.
export async function newChat(page, sel, url, { agentName } = {}) {
  await page.goto(workspaceRoot(url) + sel.chat.newTaskQuery);
  if (!(await tryPick(page, sel.chat.input, { timeout: 8000 }))) await click(page, sel.chat.newChat, 'Новая задача');
  await pick(page, sel.chat.input, { timeout: 30000, what: 'поле ввода чата' });
  // Страница новой задачи догружается повторной навигацией на тот же URL и сбрасывает
  // вложения, прикреплённые раньше, — ждём успокоения сети и паузу.
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(sel.chat.settleMs ?? 2000);
  if (agentName) await selectAgent(page, sel, agentName);
  assertNewChat(page);
  return page.url();
}

export function assertNewChat(page) {
  if (/\/sessions\/[^/]+/.test(new URL(page.url()).pathname)) {
    throw new Error('Вместо новой задачи открыт существующий чат — отправка остановлена');
  }
}

async function selectAgent(page, sel, agentName) {
  await click(page, sel.chat.agentPicker, 'Добавить агента');
  const dialog = await tryPick(page, [{ role: 'dialog' }], { timeout: 1000 });
  const item = await tryPick(dialog || page, withName(sel.chat.agentItem, agentName), { timeout: 8000 });
  if (!item) {
    await page.keyboard.press('Escape');
    throw new Error(`Агент «${agentName}» не найден в «Добавить агента» — плагин развёрнут в этом пространстве?`);
  }
  await item.click();
  await sleep(500);
  if (await anyVisible(page, [{ role: 'dialog' }])) await page.keyboard.press('Escape');
}

export async function attach(page, sel, files) {
  if (!files.length) return;
  log('вложения:', files.map((f) => path.basename(f)).join(', '));
  const input = await pick(page, sel.chat.attachInput, { attached: true, what: 'input вложений' });
  await input.setInputFiles(files);
  // Имя файла появляется сразу, а «Отправить» недоступна, пока идёт загрузка, — ждём конца прогресса.
  for (const f of files) {
    await page.getByText(path.basename(f), { exact: false }).first().waitFor({ timeout: 120000 })
      .catch(() => log(`! не дождался отображения ${path.basename(f)}`));
  }
  if (sel.chat.uploadProgress) {
    await toLocator(page, sel.chat.uploadProgress).first().waitFor({ state: 'hidden', timeout: 300000 })
      .catch(() => { throw new Error('Загрузка вложений не завершилась за 5 минут'); });
  }
  // Вложение должно пережить загрузку: чип файла на месте.
  if (sel.chat.attachmentChip) {
    await sleep(1000);
    for (const f of files) {
      const chip = toLocator(page, withName([sel.chat.attachmentChip], path.basename(f))[0]);
      if (!(await chip.first().isVisible().catch(() => false))) throw new Error(`Вложение ${path.basename(f)} пропало после загрузки`);
    }
  }
}

const turns = (page, sel) => (sel.chat.turn ? toLocator(page, sel.chat.turn).count().catch(() => 0) : Promise.resolve(0));

export async function transcript(page, sel) {
  const t = await tryPick(page, sel.chat.transcript, { timeout: 0 });
  return (t ? await t.innerText() : await page.locator('body').innerText()).trim();
}

async function lastAnswer(page, sel, before, after) {
  for (const c of sel.chat.assistantMessage || []) {
    const loc = toLocator(page, c);
    if ((await loc.count()) > 0) return (await loc.last().innerText()).trim();
  }
  // Без разметки сообщений — то, что добавилось к тексту ленты.
  return (after.startsWith(before) ? after.slice(before.length) : after).trim();
}

// Ответ готов: кнопки «Остановить» нет и лента не меняется stableMs. Открытый вопрос агента — тоже остановка.
// Начало ответа — «Остановить» или новый ход в ленте; одно лишь изменение текста (вложение, подсказки) не считается.
export async function waitIdle(page, sel, before, { timeoutMs = sel.chat.answerTimeoutMs, stableMs = sel.chat.stableMs, turnsBefore = 0, startOnChange = false } = {}) {
  const t0 = performance.now();
  let last = null;
  let changedAt = performance.now();
  let started = false;
  while (performance.now() - t0 < timeoutMs) {
    await sleep(1000);
    const text = await transcript(page, sel);
    const busy = await anyVisible(page, sel.chat.stop);
    if (text !== last) { last = text; changedAt = performance.now(); }
    if (busy || (await turns(page, sel)) > turnsBefore || ((startOnChange || !sel.chat.turn) && text !== before)) started = true;
    if (started && !busy && performance.now() - changedAt >= stableMs) return text;
  }
  throw new Error(`Ответ агента не завершился за ${Math.round(timeoutMs / 1000)} с`);
}

// «Отправить» недоступна, пока грузятся вложения или поле пусто, — ждём доступности, а не жмём Enter вслепую.
async function pressSend(page, sel, turnsBefore) {
  const btn = await pick(page, sel.chat.send, { what: 'Отправить' });
  const t0 = performance.now();
  while (!(await btn.isEnabled().catch(() => false))) {
    if (performance.now() - t0 > 120000) throw new Error('Кнопка «Отправить» недоступна 2 минуты — вложение не загрузилось?');
    await sleep(500);
  }
  const sentAt = performance.now();
  await btn.click();
  // Подтверждение отправки: ход в ленте или «Остановить».
  for (let i = 0; i < 60; i++) {
    if ((await turns(page, sel)) > turnsBefore || (await anyVisible(page, sel.chat.stop))) return sentAt;
    if (!sel.chat.turn) return sentAt;
    await sleep(500);
  }
  throw new Error('Сообщение не отправилось: за 30 с не появилось ни хода в ленте, ни «Остановить»');
}

export async function ask(page, sel, text, opts) {
  const before = await transcript(page, sel);
  const turnsBefore = await turns(page, sel);
  const input = await pick(page, sel.chat.input, { what: 'поле ввода чата' });
  await input.click();
  await input.fill(text);
  const sentAt = await pressSend(page, sel, turnsBefore);
  const after = await waitIdle(page, sel, before, { ...opts, turnsBefore });
  const responseMs = performance.now() - sentAt;
  return { answer: await lastAnswer(page, sel, before, after), transcript: after, responseMs };
}

// Вопрос агента (тул question) — карточка с вариантами (radio), полем «Свой вариант» и «Пропустить».
export async function pendingQuestion(page, sel, answer) {
  if (await anyVisible(page, sel.chat.question)) return true;
  return !!sel.chat.questionMarkHeuristic && /\?\s*$/.test(answer || '');
}

export async function questionText(page, sel) {
  const marker = await tryPick(page, sel.chat.question, { timeout: 0 });
  if (!marker) return '';
  // Карточка без своих атрибутов: поднимаемся от «Пропустить» до блока с вариантами или полем ответа.
  return marker.evaluate((el) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      if (e.querySelector('[role=radiogroup], textarea, input[type=text]')) return e.innerText.trim();
    }
    return '';
  });
}

// Canned-ответ: вариант, чьё название содержит текст, иначе — «Свой вариант».
export async function answerQuestion(page, sel, text, opts) {
  if (!(await anyVisible(page, sel.chat.question))) return ask(page, sel, text, opts);
  const before = await transcript(page, sel);
  const option = toLocator(page, { ...sel.chat.questionOption, name: text });
  if (await option.first().isVisible().catch(() => false)) await option.first().check();
  else await fill(page, sel.chat.questionFreeText, text);
  const submit = await pick(page, sel.chat.questionSubmit, { what: 'Отправить ответ на вопрос' });
  const sentAt = performance.now();
  await submit.click();
  // Агент продолжает тот же ход: началом считается смена ленты (карточка вопроса закрылась).
  const after = await waitIdle(page, sel, before, { ...opts, startOnChange: true });
  const responseMs = performance.now() - sentAt;
  return { answer: await lastAnswer(page, sel, before, after), transcript: after, responseMs };
}

async function fill(page, cands, value) {
  await (await pick(page, cands, { what: 'поле «Свой вариант»' })).fill(value);
}

// Команда стенда: «/» в поле → кнопка «/имя» в подсказках → аргументы → отправка.
export async function runCommand(page, sel, name, args = '', opts) {
  const before = await transcript(page, sel);
  const turnsBefore = await turns(page, sel);
  const input = await pick(page, sel.chat.input, { what: 'поле ввода чата' });
  await input.click();
  await input.fill('');
  await page.keyboard.type(sel.chat.commandPrefix, { delay: 40 });
  const item = await tryPick(page, withName(sel.chat.commandMenuItem, name), { timeout: 5000 });
  if (!item) {
    await input.fill('');
    throw new Error(`Команда «${name}» не найдена в подсказках «/» — она привязана к агенту или пространству?`);
  }
  await item.click();
  if (args) {
    await input.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' ' + args, { delay: 15 });
  }
  await pressSend(page, sel, turnsBefore);
  const after = await waitIdle(page, sel, before, { ...opts, turnsBefore });
  return { answer: await lastAnswer(page, sel, before, after), transcript: after };
}

// Скачивание «Документов» сессии: файл в панели → превью → «Действия» → «Скачать» → «Закрыть».
// Сбои не роняют прогон — они уходят в отчёт.
// skip — нормализованные имена вложенных входных файлов: чат показывает их в «Документах», но это не результат агента.
export async function downloadDocuments(page, sel, outDir, skip = new Set()) {
  const d = sel.documents;
  const tab = await tryPick(page, d.tab, { timeout: 1000 });
  if (tab) await tab.click();
  await sleep(1000);
  const items = toLocator(page, d.item[0]);
  const n = await items.count();
  if (!n) {
    const empty = d.emptyText && (await page.getByText(d.emptyText).first().isVisible().catch(() => false));
    return { files: [], errors: empty ? [] : ['панель «Документы» не найдена — сверьте documents в selectors.json'] };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const errors = [];
  for (let i = 0; i < n; i++) {
    const item = toLocator(page, d.item[0]).nth(i);
    const label = ((await item.getAttribute('aria-label').catch(() => null)) || `#${i}`).replace(/^Открыть\s+/, '');
    if (skip.has(normName(label))) continue;
    try {
      await item.click();
      await click(page, d.previewActions, 'Действия (превью)');
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        click(page, d.download, 'Скачать'),
      ]);
      if (skip.has(normName(dl.suggestedFilename()))) await dl.cancel().catch(() => {});
      else {
        const target = path.join(outDir, dl.suggestedFilename());
        await dl.saveAs(target);
        if (!files.includes(target)) files.push(target);
      }
    } catch (e) {
      errors.push(`${label}: ${e.message.split('\n')[0]}`);
      await page.keyboard.press('Escape').catch(() => {});
    }
    const close = await tryPick(page, d.previewClose, { timeout: 1500 });
    if (close) await close.click();
    await sleep(500);
  }
  return { files, errors };
}
