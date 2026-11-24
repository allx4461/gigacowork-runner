import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../Запустить тест.command', import.meta.url));

test('локальный запуск передаёт выбранный трек и не скрывает незавершённый прогон', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-launcher-'));
  try {
    const bin = path.join(tmp, '.local/bin');
    const track = path.join(tmp, 'трек B');
    const result = path.join(tmp, 'результаты');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.skill-craft'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.skill-craft/storage-state.json'), '{}');
    fs.mkdirSync(path.join(track, 'evals'), { recursive: true });
    fs.writeFileSync(path.join(track, 'plugin.yaml'), 'name: test');
    fs.mkdirSync(result);
    const executable = (name, body) => {
      const file = path.join(bin, name);
      fs.writeFileSync(file, body, { mode: 0o755 });
    };
    executable('osascript', '#!/bin/sh\nprintf "%s\\n" "$CASE_DIR"\n');
    executable('caffeinate', '#!/bin/sh\nshift\nexec "$@"\n');
    executable('open', '#!/bin/sh\nprintf "%s" "$1" > "$OPENED"\n');
    executable('node', `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
if (process.argv[2] === '-e') {
  const r = cp.spawnSync(${JSON.stringify(process.execPath)}, process.argv.slice(2), {stdio:'inherit'});
  process.exit(r.status);
}
fs.writeFileSync(process.env.ARGS, JSON.stringify(process.argv.slice(2)));
console.log('RESULT ' + JSON.stringify({resultsDir: process.env.RESULT_DIR, runs: [{case:'кейс-тест',run:1,status:'incomplete',anomalies:['нет ответа']}]}));
`);
    const env = {
      ...process.env, HOME: tmp, CASE_DIR: track, RESULT_DIR: result,
      ARGS: path.join(tmp, 'args.json'), OPENED: path.join(tmp, 'opened'),
    };
    const url = 'https://demo.cowork.ru/workspaces/7f17382d-45d9-4622-8ca6-62019b790e6f';
    const run = spawnSync('/bin/zsh', [launcher], {
      env, input: `1\nB\n${url}\n1\nАгент тест\n\n`, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const args = JSON.parse(fs.readFileSync(env.ARGS, 'utf8'));
    assert.deepEqual(args.slice(0, 3), ['cowork.mjs', 'evals', track]);
    assert.ok(args.includes('--headless'));
    assert.equal(args[args.indexOf('--agent') + 1], 'Агент тест');
    assert.equal(args[args.indexOf('--runs') + 1], '1');
    assert.match(run.stderr, /incomplete.*нет ответа/);
    assert.equal(fs.readFileSync(env.OPENED, 'utf8'), result);

    const runA = spawnSync('/bin/zsh', [launcher], {
      env, input: `1\nA\n${url}\n\n\n`, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(runA.status, 0, `${runA.stdout}\n${runA.stderr}`);
    const argsA = JSON.parse(fs.readFileSync(env.ARGS, 'utf8'));
    assert.ok(argsA.includes('--no-agent'));
    assert.equal(argsA[argsA.indexOf('--runs') + 1], '3');

    const runB = spawnSync('/bin/zsh', [launcher], {
      env, input: `1\nB\n${url}\n1\n\n\n`, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(runB.status, 0, `${runB.stdout}\n${runB.stderr}`);
    assert.ok(JSON.parse(fs.readFileSync(env.ARGS, 'utf8')).includes('--no-agent'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
