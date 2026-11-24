// Чтение плагина из Testing-папки и упаковка навыков (auto-test.md §2, §5).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeZip } from './zip.mjs';

// Frontmatter по стандарту skill-craft: плоские «ключ: значение», description — одна plain-строка.
export function parseFrontmatter(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: text.trim() };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv && kv[2] !== '') fm[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, '$2').trim();
  }
  return { fm, body: text.slice(m[0].length).trim() };
}

const readMd = (f) => ({ file: f, ...parseFrontmatter(fs.readFileSync(f, 'utf8')) });
const mdFiles = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(dir, f)) : [];

export function readPlugin(dir, { requireAgent = true } = {}) {
  dir = path.resolve(dir);
  const yamlFile = path.join(dir, 'plugin.yaml');
  if (!fs.existsSync(yamlFile)) throw new Error(`Нет plugin.yaml в ${dir}`);
  // plugin.yaml читается тем же плоским разбором: нужны только name и description.
  const { fm: manifest } = parseFrontmatter(`---\n${fs.readFileSync(yamlFile, 'utf8')}\n---\n`);

  const agents = mdFiles(path.join(dir, 'agents')).map(readMd);
  const alias = path.basename(dir);
  if (!agents.length && requireAgent) throw new Error('Нет agents/*.md: агент обязателен (AGENT-MD.md) — запустите review-plugin');
  const agent = agents.find((a) => path.basename(a.file, '.md') === alias) || agents[0];

  const skillsDir = path.join(dir, 'skills');
  const skills = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, 'SKILL.md'))).sort().map((d) => {
        const { fm } = readMd(path.join(skillsDir, d, 'SKILL.md'));
        return { alias: d, dir: path.join(skillsDir, d), name: fm.name || d, description: fm.description || '' };
      })
    : [];

  const commands = mdFiles(path.join(dir, 'commands')).map((f) => {
    const c = readMd(f);
    return { file: f, name: c.fm.name || path.basename(f, '.md'), description: c.fm.description || '', body: c.body };
  });

  return {
    dir, alias,
    name: manifest.name || alias,
    description: manifest.description || '',
    agent: agent ? { file: agent.file, name: agent.fm.name || alias, description: agent.fm.description || '', instruction: agent.body } : null,
    skills, commands,
  };
}

// Один навык = один ZIP с корнем <alias>/ (auto-test.md §5); служебные файлы ОС не пакуются.
export function packSkill(skill, outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-zip-'))) {
  const zip = path.join(outDir, `${skill.alias}.zip`);
  const root = path.dirname(skill.dir);
  const entries = walk(skill.dir)
    .filter((f) => !/(^|[\\/])(\.DS_Store|Thumbs\.db|__pycache__)([\\/]|$)/.test(f))
    .map((f) => ({ name: path.relative(root, f), file: f }));
  writeZip(zip, entries);
  return zip;
}

// ---------- evals ----------

// prompt.md: «## Промпт» — фраза пользователя, «## Canned-ответы» — список ответов на question.
// Без заголовков весь файл (кроме «# …» в первой строке) считается промптом.
export function parsePromptMd(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const sections = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) { cur = h[1].trim().toLowerCase(); sections[cur] = []; continue; }
    if (cur) sections[cur].push(line);
  }
  const find = (re) => Object.keys(sections).find((k) => re.test(k));
  const pk = find(/промпт|prompt|запрос/);
  const ak = find(/canned|ответ/);
  const prompt = pk ? sections[pk].join('\n').trim() : text.replace(/^#\s.*\n/, '').trim();
  const answers = ak
    ? sections[ak].join('\n').split(/\n(?=\s*(?:[-*]|\d+[.)])\s)/).map((s) => s.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).filter(Boolean)
    : [];
  return { prompt: prompt.replace(/^>\s?/gm, ''), answers };
}

export function readEvals(pluginDir) {
  const evalsDir = path.join(pluginDir, 'evals');
  if (!fs.existsSync(evalsDir)) throw new Error('Нет evals/: сначала test-plugin <alias> (режим сборки)');
  // prompt.txt — промпт как есть (с Диска): заголовки «##» внутри него не должны резать текст.
  const readPrompt = (d) => {
    const raw = path.join(evalsDir, d, 'prompt.txt');
    return fs.existsSync(raw)
      ? { prompt: fs.readFileSync(raw, 'utf8').replace(/^﻿/, '').trim(), answers: [] }
      : parsePromptMd(fs.readFileSync(path.join(evalsDir, d, 'prompt.md'), 'utf8'));
  };
  const cases = fs.readdirSync(evalsDir)
    .filter((d) => d.startsWith('кейс-') && ['prompt.txt', 'prompt.md'].some((f) => fs.existsSync(path.join(evalsDir, d, f))))
    .sort()
    .map((d) => ({ name: d, ...readPrompt(d) }));
  const gf = path.join(evalsDir, 'get-evals-result.md');
  const getEvals = fs.existsSync(gf) ? parseFrontmatter(fs.readFileSync(gf, 'utf8')).body : null;
  const fixtures = fs.readdirSync(pluginDir)
    .filter((d) => d.startsWith('Данные агента') && fs.statSync(path.join(pluginDir, d)).isDirectory())
    .flatMap((d) => walk(path.join(pluginDir, d)))
    .filter((f) => !/\.(py|pyc)$|(^|[\\/])\.|__pycache__/.test(path.relative(pluginDir, f)));
  return { evalsDir, cases, getEvals, fixtures };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
