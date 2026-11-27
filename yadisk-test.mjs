#!/usr/bin/env node
// Тест-кейс GigaCowork с Яндекс Диска (папка кейса по стандарту «Структура кейса» v1.2):
// 1) скачать промпт трека («Скиллы и промпты») и входные файлы («Входные данные»),
// 2) прогнать промпт N раз в пространстве (cowork.mjs evals, каждый прогон — новый чат),
// 3) выложить на Диск только артефакты, ленту и время замера:
//    артефакты завершённых прогонов — в «Результаты тестирования/track X/GigaCowork/<N> прогон/» (первые свободные номера),
//    ленты и время — в «Отчёты/Запуски раннера/<дата-ID>/».
//
// Токен Диска: переменная YADISK_TOKEN или файл ~/.skill-craft/yadisk-token (права 600).
//
// node yadisk-test.mjs [--disk-folder "Бенчмарк/MGN-001"] [--workspace <URL или название>] [--track A|B]
//   [--stand https://demo.cowork.ru] [--runs 3] [--timeout-min 45] [--report-folder "<папка отчётов>"] [--agent "Имя" | --no-agent] [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LAYOUT, freeRuns, isHiddenName, normName, pickPrompt, pickSkill, runFolder, runNumber } from './lib/disk-case.mjs';
// Без --disk-folder / --workspace скрипт спрашивает их при запуске.

const HERE = path.dirname(fileURLToPath(import.meta.url));
// cowork.mjs: рядом со скриптом (переносная сборка) или в репозитории skill-craft.
const COWORK = [
  process.env.COWORK_MJS,
  path.join(HERE, 'cowork.mjs'),
  path.join(HERE, '..', 'plugins', 'skill-craft', 'skills', 'skill-craft', 'Референсы', 'Автоматизация стенда', 'cowork.mjs'),
].find((f) => f && fs.existsSync(f));
const API = process.env.YADISK_API || 'https://cloud-api.yandex.net/v1/disk';
const ATTACH_NOTE = 'Все нужные файлы приложены к этому сообщению — используй их, ничего не скачивай с Яндекс Диска.';

const DEFAULT_STAND = 'https://demo.cowork.ru';
const AUTH_FILE = path.join(os.homedir(), '.skill-craft', 'storage-state.json');

const log = (...a) => console.error('·', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ввод: в терминале — интерактивно; если stdin — канал, строки читаются по порядку.
let lines;
async function input(question) {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try { return (await rl.question(question)).trim(); } finally { rl.close(); }
  }
  lines ??= fs.readFileSync(0, 'utf8').split(/\r?\n/);
  process.stderr.write(question + '\n');
  if (!lines.length) throw new Error('Ввод закончился');
  return lines.shift().trim();
}

function parseArgs(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    opt[key] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
  return opt;
}

function token() {
  if (process.env.YADISK_TOKEN) return process.env.YADISK_TOKEN.trim();
  const f = path.join(os.homedir(), '.skill-craft', 'yadisk-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('Нет токена Яндекс Диска: задайте YADISK_TOKEN или положите его в ~/.skill-craft/yadisk-token');
}

const diskPath = (p) => 'disk:/' + p.replace(/^disk:\/?/, '').replace(/^\/+/, '');

// Диск периодически отвечает 423 (ресурс занят), 429 и 5xx — такие ответы повторяем с паузой.
const RETRY = new Set([423, 429, 500, 502, 503, 504]);
async function withRetry(what, fn) {
  for (let attempt = 1; ; attempt++) {
    const res = await fn();
    if (!RETRY.has(res.status) || attempt === 6) return res;
    log(`Диск ${res.status} на «${what}», повтор ${attempt}/5…`);
    await sleep(attempt * 3000);
  }
}

async function api(method, url, params = {}, { okStatuses = [] } = {}) {
  const u = new URL(API + url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await withRetry(`${method} ${url}`, () => fetch(u, { method, headers: { Authorization: 'OAuth ' + token() } }));
  if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`Диск ${method} ${url}: ${res.status} ${await res.text()}`);
  return res.status === 204 || res.status === 409 ? null : res.json();
}

async function listFolder(folder) {
  const r = await api('GET', '/resources', { path: diskPath(folder), limit: 1000 });
  return r._embedded.items;
}

const listMaybe = (folder) => listFolder(folder).catch((e) => { if (/: 404 /.test(e.message)) return []; throw e; });

// Все файлы папки с вложенными, без скрытых и временных файлов Office.
async function listFiles(folder, rel = '') {
  const out = [];
  for (const i of await listFolder(folder)) {
    if (isHiddenName(i.name)) continue;
    if (i.type === 'dir') out.push(...await listFiles(`${folder}/${i.name}`, `${rel}${i.name}/`));
    else out.push({ item: i, rel: rel + i.name });
  }
  return out;
}

// Номера прогонов трека, где на Диске уже лежат файлы (пустые заготовки из шаблона кейса — свободны).
async function busyRuns(caseFolder, track) {
  const busy = new Set();
  const root = runFolder(caseFolder, track, 1).replace(/\/[^/]+$/, '');
  for (const d of (await listMaybe(root)).filter((i) => i.type === 'dir')) {
    const n = runNumber(d.name);
    if (n && (await listFiles(`${root}/${d.name}`)).length) busy.add(n);
  }
  return busy;
}

async function download(item, dest) {
  const { href } = await api('GET', '/resources/download', { path: item.path });
  const res = await withRetry(`скачивание ${item.name}`, () => fetch(href));
  if (!res.ok) throw new Error(`Скачивание ${item.name}: ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// Диск отвечает 423 на PUT уже существующей папки (вместо 409), поэтому сначала проверяем, что она есть.
async function dirExists(p) {
  return (await api('GET', '/resources', { path: p, limit: 0 }, { okStatuses: [404] }))?.type === 'dir';
}

async function mkdirs(folder) {
  const parts = folder.replace(/^disk:\/?/, '').split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const p = diskPath(parts.slice(0, i).join('/'));
    if (await dirExists(p)) continue;
    await api('PUT', '/resources', { path: p }, { okStatuses: [409] });
  }
}

async function uploadFile(local, remote) {
  const { href } = await api('GET', '/resources/upload', { path: diskPath(remote), overwrite: 'true' });
  const body = fs.readFileSync(local);
  const res = await withRetry(`загрузка ${remote}`, () => fetch(href, { method: 'PUT', body }));
  if (!res.ok) throw new Error(`Загрузка ${remote}: ${res.status}`);
}

async function uploadDir(localDir, remoteDir) {
  await mkdirs(remoteDir);
  for (const e of fs.readdirSync(localDir, { withFileTypes: true })) {
    const local = path.join(localDir, e.name);
    if (e.isDirectory()) await uploadDir(local, `${remoteDir}/${e.name}`);
    else await uploadFile(local, `${remoteDir}/${e.name}`);
  }
}

// ---------- выбор папки на Диске ----------

async function chooseDiskFolder() {
  let cur = '';
  for (;;) {
    const items = await listFolder(cur || '/');
    const dirs = items.filter((i) => i.type === 'dir');
    const files = items.filter((i) => i.type === 'file');
    console.error(`\nДиск: /${cur}`);
    dirs.forEach((d, i) => console.error(`  ${i + 1}. [папка] ${d.name}`));
    if (files.length) console.error(`  файлы здесь: ${files.map((f) => f.name).join(', ')}`);
    const a = await input('Номер папки — войти, Enter — выбрать эту, .. — назад, или путь целиком: ');
    if (a === '') {
      if (!cur) { console.error('  Корень Диска выбрать нельзя — войдите в папку.'); continue; }
      return cur;
    }
    if (a === '..') { cur = cur.split('/').slice(0, -1).join('/'); continue; }
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= dirs.length) { cur = cur ? `${cur}/${dirs[n - 1].name}` : dirs[n - 1].name; continue; }
    const p = a.replace(/^disk:\/?/, '').replace(/^\/+|\/+$/g, '');
    try { await listFolder(p); return p; } catch { console.error(`  Папка «${p}» не найдена.`); }
  }
}

// ---------- выбор пространства на стенде ----------

async function withStand(stand, fn) {
  if (!fs.existsSync(AUTH_FILE)) throw new Error('Нет входа на стенд: выполните node cowork.mjs login');
  const { chromium } = createRequire(COWORK)('playwright');
  const b = await chromium.launch({ headless: true });
  try {
    const page = await (await b.newContext({ storageState: AUTH_FILE })).newPage();
    await page.goto(stand + '/workspaces', { waitUntil: 'domcontentloaded' });
    if (/login|auth|sso/i.test(new URL(page.url()).pathname)) throw new Error('Сессия стенда истекла: выполните node cowork.mjs login');
    await page.getByText('Все пространства', { exact: true }).first().click({ timeout: 60000 });
    await page.locator('button.absolute.inset-0[aria-label]').first().waitFor({ timeout: 60000 });
    return await fn(page);
  } finally { await b.close(); }
}

const cards = (page) => page.locator('button.absolute.inset-0[aria-label]');

async function workspaceUrl(stand, name) {
  log(`Ищу пространство «${name}» на ${stand}…`);
  return withStand(stand, async (page) => {
    const names = await cards(page).evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
    const exact = names.filter((n) => n === name);
    const loose = names.filter((n) => n.toLowerCase().includes(name.toLowerCase()));
    const hit = exact.length ? exact : loose;
    if (hit.length !== 1) throw new Error(hit.length ? `Под «${name}» подходит несколько: ${hit.join(', ')}` : `Пространство «${name}» не найдено`);
    await cards(page).nth(names.indexOf(hit[0])).click();
    await page.waitForURL(/\/workspaces\/[0-9a-f-]{36}/, { timeout: 60000 });
    return page.url().match(/^.*\/workspaces\/[0-9a-f-]{36}/)[0];
  });
}

async function chooseWorkspace(stand) {
  log(`Загружаю список пространств с ${stand}…`);
  const names = await withStand(stand, (page) => cards(page).evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label'))));
  console.error('\nПространства:');
  names.forEach((n, i) => console.error(`  ${i + 1}. ${n}`));
  for (;;) {
    const a = await input('Номер или название пространства: ');
    const n = Number(a);
    const name = Number.isInteger(n) && n >= 1 && n <= names.length ? names[n - 1] : a;
    if (!name) continue;
    try { return await workspaceUrl(stand, name); } catch (e) { console.error('  ' + e.message); }
  }
}

function runCowork(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [COWORK, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (!line) return reject(new Error('cowork.mjs не вернул RESULT'));
      const r = JSON.parse(line.slice(7));
      r.error ? reject(new Error(r.error)) : resolve(r);
    });
  });
}

// Раскладывает результаты на Диск: артефакты завершённых прогонов — в стандартные папки кейса,
// ленты и время замера — в папку запуска раннера. Незавершённые прогоны в «Результаты тестирования» не попадают.
export async function publish({ resultsDir, caseFolder, track, reportFolder, meta }) {
  const runLog = JSON.parse(fs.readFileSync(path.join(resultsDir, 'run-log.json'), 'utf8'));
  const done = runLog.filter((e) => e.status === 'done');
  const numbers = freeRuns(await busyRuns(caseFolder, track), done.length);
  const timings = [];
  for (const e of runLog) {
    const artifacts = path.join(resultsDir, 'артефакты', e.case, `прогон-${e.run}`);
    const hasFiles = fs.existsSync(artifacts) && fs.readdirSync(artifacts).length > 0;
    const anomalies = [...e.anomalies];
    let diskRun = null;
    if (hasFiles && e.status === 'done') {
      diskRun = numbers[done.indexOf(e)];
      await uploadDir(artifacts, runFolder(caseFolder, track, diskRun));
    } else if (hasFiles) {
      await uploadDir(artifacts, `${reportFolder}/неполные-прогоны/прогон-${e.run}`);
    } else if (e.status === 'done') {
      anomalies.push('артефактов нет — папка прогона на Диске не создана');
    }
    const feed = path.join(resultsDir, 'прогоны', e.case, `прогон-${e.run}`, 'лента.md');
    if (fs.existsSync(feed)) { await mkdirs(`${reportFolder}/ленты`); await uploadFile(feed, `${reportFolder}/ленты/прогон-${e.run}.md`); }
    timings.push({
      run: e.run, diskRun, status: e.status, startedAt: e.startedAt, timingVersion: e.timingVersion,
      answerSec: e.answerSec ?? null, responseTimesSec: e.responseTimesSec ?? [], setupToAnswerSec: e.setupToAnswerSec ?? null, totalSec: e.totalSec ?? null,
      chat: e.chat ?? null, files: (e.files || []).map((f) => path.basename(f)), anomalies,
    });
  }
  const timeFile = path.join(resultsDir, 'время.json');
  fs.writeFileSync(timeFile, JSON.stringify({
    ...meta,
    note: 'answerSec — сумма времён ответов от отправки до подтверждённой остановки (включает ожидание стабильности ленты и задержку опроса); подготовка чата и ответы на уточнения не входят. diskRun — номер папки «<N> прогон» на Диске; null — артефакты в «Результаты тестирования» не выложены.',
    runs: timings,
  }, null, 2));
  await mkdirs(reportFolder);
  await uploadFile(timeFile, `${reportFolder}/время.json`);
  return timings;
}

// Повторная выкладка уже готового локального прогона (например, после сбоя Диска): стенд не запускается.
// Файлы с тем же именем перезаписываются, поэтому ленты и время.json лягут в ту же папку запуска.
async function republish(opt) {
  const resultsDir = path.resolve(String(opt.publishFrom));
  if (!fs.existsSync(path.join(resultsDir, 'run-log.json'))) throw new Error(`В «${resultsDir}» нет run-log.json`);
  if (!['A', 'B'].includes(String(opt.track).toUpperCase())) throw new Error('Укажите --track A или --track B');
  if (typeof opt.diskFolder !== 'string') throw new Error('Укажите --disk-folder, например "Бенчмарк/MGN-001"');
  const diskFolder = opt.diskFolder.replace(/^\/+|\/+$/g, '');
  const track = String(opt.track).toUpperCase();
  const stamp = path.basename(resultsDir);
  const reportFolder = `${opt.reportFolder || `${diskFolder}/${LAYOUT.runnerReports}`}/${stamp}`;
  const timings = await publish({ resultsDir, caseFolder: diskFolder, track, reportFolder,
    meta: { case: path.basename(diskFolder), track, platform: LAYOUT.platform, agent: opt.agent || null, skill: opt.skill || null, republished: true, runnerStamp: stamp } });
  for (const t of timings) log(`прогон ${t.run}: ${t.status}${t.diskRun ? ` → «${t.diskRun} прогон»` : ''}`);
  console.log('RESULT ' + JSON.stringify({ report: `${reportFolder}/время.json`, local: resultsDir, runs: timings.map(({ run, diskRun, status }) => ({ run, diskRun, status })) }));
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.publishFrom) return republish(opt);
  if (!COWORK) throw new Error('Не найден cowork.mjs: положите его рядом со скриптом или задайте COWORK_MJS');
  if (!opt.track) opt.track = await input('Трек A (без ролевого скилла) или B (со скиллом): ');
  if (typeof opt.track !== 'string' || !['A', 'B'].includes(opt.track.toUpperCase())) throw new Error('Укажите --track A или --track B');
  opt.track = opt.track.toUpperCase();
  if (opt.track === 'A' && (opt.agent || opt.skill)) throw new Error('Для трека A не указывайте --agent и --skill');
  const stand = (opt.stand || (/^https?:/.test(opt.workspace || '') ? new URL(opt.workspace).origin : DEFAULT_STAND)).replace(/\/+$/, '');
  const diskFolder = typeof opt.diskFolder === 'string' ? opt.diskFolder.replace(/^\/+|\/+$/g, '') : await chooseDiskFolder();
  log(`Папка Диска: ${diskFolder}`);

  // 1. Промпт трека и входные файлы по стандартной раскладке кейса.
  const promptItems = (await listMaybe(`${diskFolder}/${LAYOUT.prompts}`)).filter((i) => i.type === 'file' && !isHiddenName(i.name));
  if (!promptItems.length) throw new Error(`В «${diskFolder}» нет папки «${LAYOUT.prompts}» с промптами: кейс не в стандартной раскладке`);
  const promptItem = promptItems.find((i) => i.name === pickPrompt(promptItems.map((p) => p.name), opt.track));
  const inputs = await listFiles(`${diskFolder}/${LAYOUT.input}`).catch((e) => { throw new Error(`«${LAYOUT.input}» в «${diskFolder}» не прочитана: ${e.message}`); });
  if (!inputs.length) log(`! «${LAYOUT.input}» пуста: файлы к сообщению приложены не будут`);
  const clash = inputs.map((f) => normName(path.basename(f.rel))).filter((n, i, a) => a.indexOf(n) !== i);
  if (clash.length) throw new Error('Во «Входные данные» есть файлы с совпадающими именами в разных подпапках — чат их не различит');

  if (opt.track === 'B') {
    const skillName = pickSkill(promptItems.map((p) => p.name));
    // Скилл бывает без агента (привязан к пространству): --no-agent или пустое имя агента.
    if (opt.noAgent === true && opt.agent) throw new Error('--agent и --no-agent несовместимы');
    if (opt.noAgent !== true && !opt.agent) opt.agent = await input('Имя агента со скиллом в CoWork (пусто — без агента, скилл привязан к пространству): ');
    if (!opt.skill && skillName) { opt.skill = skillName.replace(/\.md$/i, ''); log(`Скилл (метка): ${skillName}`); }
    if (!opt.skill) opt.skill = await input('Название и версия скилла (проверьте привязку в CoWork): ');
    if (opt.agent !== undefined && typeof opt.agent !== 'string' || typeof opt.skill !== 'string' || !opt.skill.trim()) {
      throw new Error('Для трека B нужен --skill; агент — это --agent "Имя" или --no-agent');
    }
    opt.agent = (opt.agent || '').trim() || null;
    opt.skill = opt.skill.trim();
    log(opt.agent
      ? 'Проверьте в CoWork, что скилл привязан к агенту: раннер не проверяет это автоматически.'
      : 'Прогон БЕЗ агента: проверьте в CoWork, что скилл доступен в пространстве — раннер это не проверяет.');
  }
  if (!opt.dryRun) {
    if (typeof opt.workspace === 'string' && !/^https?:/.test(opt.workspace)) opt.workspace = await workspaceUrl(stand, opt.workspace);
    if (typeof opt.workspace !== 'string') opt.workspace = await chooseWorkspace(stand);
    log(`Пространство: ${opt.workspace}`);
  }
  const name = path.basename(diskFolder);
  const runs = Number(opt.runs) || 3;
  const stamp = `${new Date().toLocaleString('sv-SE').replace(' ', '_').replace(/:/g, '-').slice(0, 16)}-${randomUUID()}`;
  const reportFolder = `${opt.reportFolder || `${diskFolder}/${LAYOUT.runnerReports}`}/${stamp}`;

  // Данные с Диска → папка теста в формате, который понимает cowork.mjs evals.
  const work = path.join(HERE, 'runs', `${name}_${stamp}`);
  const dataDir = path.join(work, `Данные агента ${name}`);
  const caseDir = path.join(work, 'evals', 'кейс-тест');
  for (const d of [dataDir, caseDir, path.join(work, 'agents')]) fs.mkdirSync(d, { recursive: true });
  log(`Диск: промпт ${promptItem.name}, входных файлов: ${inputs.length}`);
  await download(promptItem, path.join(caseDir, 'prompt.src'));
  for (const f of inputs) await download(f.item, path.join(dataDir, f.rel));

  const prompt = fs.readFileSync(path.join(caseDir, 'prompt.src'), 'utf8').trim();
  fs.rmSync(path.join(caseDir, 'prompt.src'));
  fs.writeFileSync(path.join(caseDir, 'prompt.txt'), `${inputs.length ? ATTACH_NOTE + '\n\n' : ''}${prompt}\n`);
  fs.writeFileSync(path.join(work, 'plugin.yaml'), `name: ${name}\ndescription: Тест-кейс с Яндекс Диска\n`);
  fs.writeFileSync(path.join(work, 'agents', `${name}.md`), `---\nname: ${opt.agent || name}\ndescription: заглушка для раннера\n---\n`);
  if (opt.dryRun) return log(`dry-run: папка теста собрана в ${work}`);

  // 2. N прогонов, каждый в новом чате.
  const args = ['evals', work, '--url', opt.workspace, '--runs', String(runs), '--date', stamp,
    '--run-id', stamp, '--track', opt.track, '--timeout-min', String(opt.timeoutMin || 45), '--headless'];
  args.push('--stand', stand);
  if (opt.track === 'A') args.push('--no-agent');
  else args.push(...(opt.agent ? ['--agent', opt.agent] : ['--no-agent']), '--skill', opt.skill);
  log(`Стенд: ${runs} прогона(ов)…`);
  let resultsDir;
  try {
    resultsDir = (await runCowork(args)).resultsDir;
  } catch (e) {
    resultsDir = path.join(work, 'evals', 'results', stamp);
    log(`Раннер завершился с ошибкой: ${e.message}`);
    if (!fs.existsSync(path.join(resultsDir, 'run-log.json'))) throw e;
  }

  // 3. Артефакты, ленты и время → Диск.
  const timings = await publish({ resultsDir, caseFolder: diskFolder, track: opt.track, reportFolder, meta: { case: name, track: opt.track, platform: LAYOUT.platform, agent: opt.agent || null, skill: opt.skill || null, stand, workspace: opt.workspace, promptFile: promptItem.name, runnerStamp: stamp } });
  const web = 'https://disk.yandex.ru/client/disk/' + reportFolder.split('/').map(encodeURIComponent).join('/');
  log(`Готово. Время и ленты на Диске: ${web}`);
  for (const t of timings) log(`прогон ${t.run}: ${t.status}${t.diskRun ? ` → «${t.diskRun} прогон»` : ''}`);
  console.log('RESULT ' + JSON.stringify({ report: `${reportFolder}/время.json`, web, local: resultsDir, runs: timings.map(({ run, diskRun, status }) => ({ run, diskRun, status })) }));
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('✗', e.message); console.log('RESULT ' + JSON.stringify({ error: e.message })); process.exit(1); });
}
