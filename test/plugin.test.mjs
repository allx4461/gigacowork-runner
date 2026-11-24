import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readPlugin } from '../lib/plugin.mjs';

test('пакет без агента разрешён только при явном отключении', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-no-agent-'));
  try {
    fs.writeFileSync(path.join(dir, 'plugin.yaml'), 'name: Тест\n');
    fs.mkdirSync(path.join(dir, 'skills', 'skill'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'skill', 'SKILL.md'), '---\nname: Навык\n---\nПравила');
    assert.throws(() => readPlugin(dir), /Нет agents\/\*\.md/);
    const plugin = readPlugin(dir, { requireAgent: false });
    assert.equal(plugin.agent, null);
    assert.equal(plugin.skills[0].name, 'Навык');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
