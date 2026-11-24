import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freeRuns, inputKeys, isInputName, normName, pickPrompt, pickSkill, runNumber } from '../lib/disk-case.mjs';
import { readEvals } from '../lib/plugin.mjs';

test('страницы входных PDF «<имя>_p1.png» — не артефакты, а настоящий результат — артефакт', () => {
  const skip = inputKeys(['/x/Входные данные/MGN-001-TD-22.pdf']);
  assert.ok(isInputName('MGN-001-TD-22.pdf', skip));
  assert.ok(isInputName('MGN-001-TD-22_p1.png', skip));
  assert.ok(!isInputName('MGN-001 результат проверки.xlsx', skip));
  assert.ok(!isInputName('MGN-001-TD-99_p1.png', skip));
});

test('промпт выбирается по треку, неоднозначность и отсутствие — ошибка', () => {
  const names = ['MGN-001_промпт_A.md', 'MGN-001_промпт_B.md', 'MGN-001_скилл_GigaCowork.md'];
  assert.equal(pickPrompt(names, 'A'), 'MGN-001_промпт_A.md');
  assert.equal(pickPrompt(names, 'B'), 'MGN-001_промпт_B.md');
  assert.throws(() => pickPrompt(['x.md'], 'A'), /нет файла промпта трека A/);
  assert.throws(() => pickPrompt([...names, 'копия_prompt_A.txt'], 'A'), /несколько/);
  assert.equal(pickSkill([...names, 'MGN-001_скилл_ClaudeCowork.md']), 'MGN-001_скилл_GigaCowork.md');
});

test('свободные номера прогонов пропускают занятые', () => {
  assert.deepEqual(freeRuns(new Set([1, 2, 3]), 3), [4, 5, 6]);
  assert.deepEqual(freeRuns(new Set([2]), 3), [1, 3, 4]);
  assert.equal(runNumber('12 прогон'), 12);
  assert.equal(runNumber('1'), null);
});

test('имена сверяются без знаков: вложение и скачанная копия совпадают', () => {
  assert.equal(normName('Компания 1 Приложение № 3 Тарифы.xlsx'), normName('Компания 1 Приложение _ 3 Тарифы.xlsx'));
  assert.notEqual(normName('Результат.xlsx'), normName('Тарифы.xlsx'));
});

test('prompt.txt читается как есть, заголовки «##» не режут промпт', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-prompt-'));
  try {
    fs.mkdirSync(path.join(dir, 'evals', 'кейс-тест'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evals', 'кейс-тест', 'prompt.txt'), 'Начало\n\n## Ответ\n\nКонец\n');
    assert.equal(readEvals(dir).cases[0].prompt, 'Начало\n\n## Ответ\n\nКонец');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
