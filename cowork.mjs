#!/usr/bin/env node
// Автоматизация демо-стенда GigaCowork через Playwright (STAND-AUTOMATION.md).
// Логи — в stderr, итог — одной строкой «RESULT {json}» в stdout (для агента).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { AUTH_FILE, ensureLoggedIn, loadSelectors, loadState, log, openBrowser, standUrl } from './lib/stand.mjs';
import { readPlugin } from './lib/plugin.mjs';
import { deploy } from './lib/deploy.mjs';
import { ask, attach, newChat, runCommand } from './lib/chat.mjs';
import { runEvals } from './lib/evals.mjs';

const USAGE = `Использование: node cowork.mjs <команда> [параметры]

  login                              вход вручную в открытом браузере, сессия → ${AUTH_FILE}
  inspect [url]                      открыть стенд с Playwright Inspector для калибровки selectors.json
  plugin <папка-плагина>             разбор плагина без браузера: что будет развёрнуто
  deploy <папка-плагина>             развёртывание (auto-test.md §3–8), возобновляемое
        [--fresh] [--workspace-url U] [--agent-url U]
  chat new   (--plugin P | --url U)  открыть новую задачу (URL сессии — после первого сообщения)
  chat send  (--plugin P | --url U | --chat U) (--text T | --file F) [--attach f1,f2] [--out F]
  chat command <имя> (--plugin P | --url U | --chat U) [--args T] [--out F]
  evals <папка-плагина> [--runs 2] [--date ГГГГ-ММ-ДД] [--case имя] [--no-fixtures] [--no-download]

Чат: --url — пространство, --agent "имя" или --no-agent (по умолчанию агент плагина при --plugin).
Общие: --stand URL (иначе demo_stand_url из .skill-craft.json или COWORK_URL),
       --config путь, --headless, --slow-mo мс, --timeout-min N (ожидание ответа агента, по умолчанию 15)`;

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key.startsWith('no') && key.length > 2) { opt[key[2].toLowerCase() + key.slice(3)] = false; continue; }
    const next = argv[i + 1];
    opt[key] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
  return { pos, opt };
}

const result = (obj) => console.log('RESULT ' + JSON.stringify(obj));
const today = () => new Date().toLocaleDateString('sv-SE');

// Где открывать новую задачу: --url пространства или пространство из состояния deploy.
// С --plugin агент плагина выбирается в «Добавить агента»; --no-agent — чат без агента.
function chatTarget(opt) {
  const plugin = opt.plugin ? readPlugin(opt.plugin, { requireAgent: opt.agent === undefined }) : null;
  const url = opt.url || (plugin && loadState(plugin.alias).workspaceUrl);
  if (!url) {
    throw new Error(plugin
      ? `Плагин ${plugin.alias} ещё не развёрнут: сначала deploy или укажите --url пространства`
      : 'Укажите --plugin <папка> (после deploy) или --url <URL пространства>');
  }
  const agentName = opt.agent === false ? undefined : typeof opt.agent === 'string' ? opt.agent : plugin?.agent?.name;
  return { url, plugin, agentName };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  if (!cmd || cmd === 'help' || opt.help) return console.log(USAGE);

  if (cmd === 'plugin') {
    const p = readPlugin(pos[0] || '.');
    return result({ alias: p.alias, name: p.name, agent: p.agent.name, skills: p.skills.map((s) => s.alias), commands: p.commands.map((c) => c.name) });
  }

  const base = standUrl(opt);
  const sel = loadSelectors();
  if (opt.timeoutMin) sel.chat.answerTimeoutMs = Number(opt.timeoutMin) * 60000;
  const b = await openBrowser({ headless: !!opt.headless && cmd !== 'login', slowMo: Number(opt.slowMo) || 0, auth: cmd !== 'login' });
  const { page } = b;
  try {
    if (cmd === 'login') {
      // Креды вводит только пользователь — скрипт лишь сохраняет получившуюся сессию.
      // Сессия сохраняется после каждой навигации: закрыть окно после входа — то же, что Enter
      // (Enter может не дойти, если терминал не передаёт stdin).
      await page.goto(base);
      let saved = false;
      const snapshot = async () => {
        const u = new URL(page.url());
        if (u.origin === new URL(base).origin && !new RegExp(sel.auth.loginUrlPattern, 'i').test(u.pathname)) {
          await b.saveAuth().then(() => { saved = true; }).catch(() => {});
        }
      };
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) snapshot(); });
      log('Войдите на стенд в открытом окне браузера, затем нажмите Enter здесь или просто закройте окно.');
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      // Без stdin (EOF) question не завершается или падает — тогда ждём только закрытия окна.
      const enter = rl.question('').catch(() => new Promise(() => {}));
      await Promise.race([enter, new Promise((r) => page.on('close', r))]);
      rl.close();
      if (!page.isClosed()) await snapshot();
      if (!saved) throw new Error('Вход не завершён: сессия не сохранена — повторите login');
      return result({ saved: AUTH_FILE });
    }

    await ensureLoggedIn(page, base, sel);

    if (cmd === 'inspect') {
      await page.goto(pos[0] || base + '/workspaces');
      log('Inspector: кнопка Pick locator показывает селектор элемента. Закройте окно, чтобы выйти.');
      await page.pause();
      return result({ ok: true });
    }

    if (cmd === 'deploy') {
      const plugin = readPlugin(pos[0] || '.');
      const r = await deploy(page, sel, base, plugin, opt);
      return result(r);
    }

    if (cmd === 'chat') {
      const [sub, name] = pos;
      let chatUrl = opt.chat;
      let target = null;
      if (!chatUrl) {
        target = chatTarget(opt);
        chatUrl = await newChat(page, sel, target.url, { agentName: target.agentName });
        log('чат:', chatUrl);
      } else {
        await page.goto(chatUrl);
      }
      if (sub === 'new') return result({ chat: chatUrl });

      let res;
      if (sub === 'send') {
        const text = opt.file ? fs.readFileSync(opt.file, 'utf8') : opt.text;
        if (!text) throw new Error('Нужен --text или --file');
        if (opt.attach) await attach(page, sel, String(opt.attach).split(',').map((f) => path.resolve(f.trim())));
        res = await ask(page, sel, text);
      } else if (sub === 'command') {
        if (!name) throw new Error('Укажите имя команды: chat command <имя>');
        res = await runCommand(page, sel, name, opt.args === true ? '' : opt.args || '');
      } else throw new Error(`Неизвестная подкоманда chat ${sub}`);

      if (opt.out) fs.writeFileSync(opt.out, res.answer + '\n');
      return result({ chat: page.url(), answer: opt.out ? undefined : res.answer, out: opt.out });
    }

    if (cmd === 'evals') {
      const plugin = readPlugin(pos[0] || '.', { requireAgent: opt.agent === undefined });
      const { url, agentName } = chatTarget({ ...opt, plugin: plugin.dir });
      const r = await runEvals(page, sel, plugin, {
        chatUrl: url,
        agentName,
        track: opt.track,
        skill: opt.skill,
        runs: Number(opt.runs) || 2,
        date: opt.date || today(),
        runId: opt.runId,
        only: opt.case,
        fixtures: opt.fixtures !== false,
        download: opt.download !== false,
      });
      return result(r);
    }

    throw new Error(`Неизвестная команда ${cmd}\n\n${USAGE}`);
  } finally {
    if (cmd !== 'login') await b.saveAuth().catch(() => {});
    await b.close();
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  result({ error: e.message.split('\n')[0] });
  process.exit(1);
});
