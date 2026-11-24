// Развёртывание плагина на стенде по auto-test.md §3–8.
// Возобновляемо: пройденные шаги пишутся в ~/.skill-craft/stand/<alias>.json и при повторе пропускаются.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { click, fill, log, pick, saveState, loadState, sleep, tryPick, xpathLiteral } from './stand.mjs';
import { packSkill } from './plugin.mjs';

const uuidUrl = (page, pattern) => {
  const m = page.url().match(new RegExp(pattern));
  return m ? page.url().slice(0, page.url().indexOf(m[0]) + m[0].length) : null;
};

// Вкладки пространства — ссылки ?tab=<имя> (UI 2026-10); клик по вкладке — запасной путь.
async function openTab(page, sel, wsUrl, block) {
  if (block.tabQuery) {
    await page.goto(wsUrl + block.tabQuery);
    await page.waitForLoadState('networkidle').catch(() => {});
    return;
  }
  await page.goto(wsUrl);
  if (await tryPick(page, block.tab)) return click(page, block.tab, 'вкладка');
  await click(page, sel.commands.moreTabs, 'Ещё вкладки');
  await click(page, block.tab, 'вкладка');
}

// Первая из кнопок main, что есть на странице: на пустой вкладке — «Создать …», иначе — «Добавить».
async function clickFirst(page, groups, what) {
  for (const g of groups) {
    const el = await tryPick(page.locator('main'), g, { timeout: 4000 });
    if (el) return el.click();
  }
  throw new Error(`Не найдена кнопка «${what}» — сверьте selectors.json`);
}

export async function deploy(page, sel, base, plugin, opts = {}) {
  const state = opts.fresh ? {} : loadState(plugin.alias);
  if (opts.workspaceUrl) state.workspaceUrl = opts.workspaceUrl;
  if (opts.agentUrl) state.agentUrl = opts.agentUrl;
  state.skills ||= {};
  state.commands ||= {};
  state.bound ||= {};
  const save = () => saveState(plugin.alias, state);
  const report = { alias: plugin.alias, skipped: [], discrepancies: [] };

  // §3 Пространство
  if (!state.workspaceUrl) {
    log('пространство:', plugin.name);
    await page.goto(base + sel.workspace.newPath);
    await fill(page, sel.workspace.name, plugin.name, 'Название пространства');
    await fill(page, sel.workspace.description, plugin.description, 'Описание пространства');
    await click(page, sel.workspace.submit, 'Создать');
    await page.waitForURL((u) => new RegExp(sel.workspace.urlPattern).test(u.href));
    state.workspaceUrl = uuidUrl(page, sel.workspace.urlPattern);
    save();
  } else report.skipped.push('пространство');

  // §4 Агент
  if (!state.agentUrl) {
    log('агент:', plugin.agent.name);
    await openTab(page, sel, state.workspaceUrl, sel.agent);
    await clickFirst(page, [sel.agent.create], 'Создать агента');
    await fill(page, sel.agent.name, plugin.agent.name, 'Название агента');
    await fill(page, sel.agent.description, plugin.agent.description, 'Описание агента');
    await fill(page, sel.agent.instruction, plugin.agent.instruction, 'Инструкция агента');
    await click(page, sel.agent.submit, 'Сохранить агента');
    await page.waitForURL((u) => new RegExp(sel.agent.urlPattern).test(u.href));
    state.agentUrl = uuidUrl(page, sel.agent.urlPattern) + '/settings';
    save();
  } else report.skipped.push('агент');

  // §5 Навыки — по одному ZIP до статуса «Добавлено»
  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-zip-'));
  try {
    for (const skill of plugin.skills) {
      if (state.skills[skill.alias] === 'added') { report.skipped.push(`навык ${skill.alias}`); continue; }
      log('навык:', skill.alias);
      const zip = packSkill(skill, zipDir);
      await openTab(page, sel, state.workspaceUrl, sel.skills);
      // Пустая вкладка: «Создать навык»; иначе «Добавить» → каталог «Навыки» → «Добавить навык».
      const create = await tryPick(page.locator('main'), sel.skills.create, { timeout: 4000 });
      if (create) await create.click();
      else {
        await click(page.locator('main'), sel.skills.add, 'Добавить (навыки)');
        await click(page.getByRole('dialog').last(), sel.skills.addInCatalog, 'Добавить навык');
      }
      await click(page, sel.skills.uploadOption, 'Загрузить файл навыка');
      const clear = await tryPick(page, sel.skills.clearFile, { timeout: 1000 });
      if (clear) await clear.click(); // «Можно загрузить только один файл»
      await (await pick(page, sel.skills.fileInput, { attached: true, what: 'input файла навыка' })).setInputFiles(zip);
      await click(page, sel.skills.next, 'Далее');
      await page.getByText(sel.skills.addedText).first().waitFor({ timeout: 60000 });
      state.skills[skill.alias] = 'added';
      save();
    }
  } finally {
    fs.rmSync(zipDir, { recursive: true, force: true });
  }

  // §6 Команды — диалог по одной
  for (const cmd of plugin.commands) {
    if (state.commands[cmd.name] === 'created') { report.skipped.push(`команда ${cmd.name}`); continue; }
    log('команда:', cmd.name);
    await openTab(page, sel, state.workspaceUrl, sel.commands);
    const manage = await tryPick(page, sel.commands.manage, { timeout: 1000 });
    if (manage) await manage.click();
    await clickFirst(page, [sel.commands.create], 'Создать команду');
    const dialog = page.getByRole('dialog').last();
    await dialog.waitFor();
    await fill(dialog, sel.commands.name, cmd.name, 'Имя команды');
    await fill(dialog, sel.commands.description, cmd.description, 'Описание команды');
    await fill(dialog, sel.commands.instruction, cmd.body, 'Инструкции команды');
    await click(dialog, sel.commands.submit, 'Создать команду (в диалоге)');
    await dialog.waitFor({ state: 'hidden', timeout: 30000 });
    state.commands[cmd.name] = 'created';
    save();
  }

  // §7 Привязка к агенту
  await page.goto(state.agentUrl);
  await bindAll(page, sel, sel.binding.addSkills, plugin.skills.map((s) => s.name), 'навыки');
  if (plugin.commands.length) await bindAll(page, sel, sel.binding.addCommands, plugin.commands.map((c) => c.name), 'команды');
  await click(page, sel.binding.save, 'Сохранить');
  await sleep(2000);
  state.bound = { skills: plugin.skills.length, commands: plugin.commands.length };
  save();

  // §8 Верификация по счётчикам
  await page.reload();
  await page.waitForLoadState('networkidle').catch(() => {});
  const text = await page.locator('body').innerText();
  const counters = {};
  for (const m of text.matchAll(new RegExp(sel.binding.counterRegex, 'g'))) counters[m[1]] ??= Number(m[2]);
  const expected = { 'Навыки': sel.binding.systemSkills + plugin.skills.length, 'Команды': plugin.commands.length };
  for (const [k, v] of Object.entries(expected)) {
    if (counters[k] !== v) report.discrepancies.push(`счётчик «${k}»: ожидалось ${v}, на странице ${counters[k] ?? 'не найден'}`);
  }

  return {
    ...report,
    workspaceUrl: state.workspaceUrl,
    agentUrl: state.agentUrl,
    skills: plugin.skills.map((s) => ({ alias: s.alias, status: state.skills[s.alias] || 'нет' })),
    commands: plugin.commands.map((c) => ({ name: c.name, status: state.commands[c.name] || 'нет' })),
    counters, expected,
    ok: report.discrepancies.length === 0,
  };
}

// В каталоге — «Добавить» у строки элемента; «Убрать» значит, что уже привязан.
async function bindAll(page, sel, opener, names, what) {
  if (!names.length) return;
  log('привязка:', what);
  await click(page, opener, `Добавить в «${what}»`);
  const dialog = (await tryPick(page, [{ role: 'dialog' }], { timeout: 5000 })) || page;
  for (const name of names) {
    const row = dialog.locator(
      `xpath=.//*[normalize-space(text())=${xpathLiteral(name)}]/ancestor::*[.//button][1]`).first();
    await row.waitFor({ timeout: 15000 }).catch(() => { throw new Error(`В каталоге нет «${name}» (${what})`); });
    const remove = row.getByRole('button', { name: sel.binding.removeButton, exact: true });
    if (await remove.isVisible().catch(() => false)) continue;
    await row.getByRole('button', { name: sel.binding.addButton, exact: true }).click();
    await remove.waitFor({ timeout: 10000 });
  }
  const close = await tryPick(dialog, sel.binding.closeDialog, { timeout: 1500 });
  if (close) await close.click(); else await page.keyboard.press('Escape');
}
