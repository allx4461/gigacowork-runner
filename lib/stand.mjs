// Браузер, сессия, настройки и поиск элементов для автоматизации стенда.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Сессия и состояние развёртываний — вне репозиториев: в них UUID пространств и куки.
export const HOME = process.env.SKILL_CRAFT_HOME || path.join(os.homedir(), '.skill-craft');
export const AUTH_FILE = path.join(HOME, 'storage-state.json');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.error('·', ...a);

// ---------- настройки ----------

// .skill-craft.json ищется вверх от cwd (корень cowork_hub), как в навыке skill-craft.
export function findConfig(explicit) {
  if (explicit) return JSON.parse(fs.readFileSync(explicit, 'utf8'));
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    const f = path.join(d, '.skill-craft.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    if (path.dirname(d) === d) return {};
  }
}

export function standUrl(opts) {
  const url = opts.stand || process.env.COWORK_URL || findConfig(opts.config).demo_stand_url;
  if (!url) throw new Error('Не задан адрес стенда: ключ demo_stand_url в .skill-craft.json, --stand или COWORK_URL');
  return url.replace(/\/+$/, '');
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}

// Калибровка без правки репозитория — ~/.skill-craft/selectors.local.json перекрывает поля.
export function loadSelectors() {
  const base = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'selectors.json'), 'utf8'));
  const local = path.join(HOME, 'selectors.local.json');
  return fs.existsSync(local) ? merge(base, JSON.parse(fs.readFileSync(local, 'utf8'))) : base;
}

// ---------- состояние развёртывания плагина ----------

const stateFile = (alias) => path.join(HOME, 'stand', `${alias}.json`);
export function loadState(alias) {
  const f = stateFile(alias);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}
export function saveState(alias, state) {
  fs.mkdirSync(path.dirname(stateFile(alias)), { recursive: true });
  fs.writeFileSync(stateFile(alias), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}

// ---------- браузер ----------

export async function openBrowser({ headless = false, slowMo = 0, auth = true } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright не установлен: в папке «Автоматизация стенда» выполните npm run setup');
  }
  const browser = await chromium.launch({ headless, slowMo });
  const ctx = await browser.newContext({
    storageState: auth && fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
    locale: 'ru-RU',
  });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  return {
    browser, ctx, page,
    async saveAuth() {
      fs.mkdirSync(HOME, { recursive: true });
      await ctx.storageState({ path: AUTH_FILE });
      try { fs.chmodSync(AUTH_FILE, 0o600); } catch {}
    },
    close: () => browser.close(),
  };
}

export async function ensureLoggedIn(page, base, sel) {
  if (!fs.existsSync(AUTH_FILE)) throw new Error('Нет сохранённой сессии: сначала node cowork.mjs login');
  await page.goto(base + '/workspaces');
  await page.waitForLoadState('networkidle').catch(() => {});
  if (new RegExp(sel.auth.loginUrlPattern, 'i').test(new URL(page.url()).pathname + new URL(page.url()).host)) {
    throw new Error('Сессия истекла: повторите node cowork.mjs login');
  }
}

// ---------- поиск элементов ----------

export function toLocator(scope, c) {
  if (typeof c === 'string') return scope.locator(c);
  if (c.role) return scope.getByRole(c.role, c.name ? { name: c.name, exact: !!c.exact } : {});
  if (c.label) return scope.getByLabel(c.label, { exact: !!c.exact });
  if (c.placeholder) return scope.getByPlaceholder(c.placeholder);
  if (c.text) return scope.getByText(c.text, { exact: !!c.exact });
  if (c.css) return scope.locator(c.css);
  throw new Error('Неизвестный формат селектора: ' + JSON.stringify(c));
}

const list = (c) => (Array.isArray(c) ? c : c ? [c] : []);

// Первый видимый кандидат (attached: true — достаточно наличия в DOM, для input[type=file]).
export async function pick(scope, candidates, { timeout = 10000, attached = false, what } = {}) {
  const cands = list(candidates);
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const c of cands) {
      const loc = toLocator(scope, c);
      if (attached) {
        if ((await loc.count().catch(() => 0)) > 0) return loc.last();
      } else {
        const n = await loc.count().catch(() => 0);
        for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`Не найден элемент${what ? ` «${what}»` : ''}: ${JSON.stringify(cands)} — сверьте selectors.json`);
    }
    await sleep(250);
  }
}

export async function tryPick(scope, candidates, opts = {}) {
  try { return await pick(scope, candidates, { timeout: 2500, ...opts }); } catch { return null; }
}

export async function anyVisible(scope, candidates) {
  return !!(await tryPick(scope, candidates, { timeout: 0 }));
}

export async function click(scope, candidates, what, opts) {
  await (await pick(scope, candidates, { what, ...opts })).click();
}

export async function fill(scope, candidates, value, what) {
  const el = await pick(scope, candidates, { what });
  await el.fill(value);
}

export const xpathLiteral = (s) =>
  !s.includes("'") ? `'${s}'` : !s.includes('"') ? `"${s}"` : `concat('${s.split("'").join(`', "'", '`)}')`;
