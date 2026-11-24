// Прогон evals по ПРОТОКОЛ_DEMO.md (EVALUATION.md §5): свежий чат на прогон, fixtures,
// промпт, canned-ответы на question, факт-отчёт get-evals-result.md, скачивание артефактов.
// Грейдинг и вердикт — отдельно: test-plugin <alias> grade <дата>.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ask, answerQuestion, assertNewChat, attach, downloadDocuments, newChat, pendingQuestion, questionText } from './chat.mjs';
import { log } from './stand.mjs';
import { readEvals } from './plugin.mjs';
import { normName } from './disk-case.mjs';

export async function runEvals(page, sel, plugin, { chatUrl, agentName, track, skill, runs = 2, date, runId = `${date}-${randomUUID()}`, only, fixtures = true, download = true, maxQuestions = 3 }) {
  const ev = readEvals(plugin.dir);
  const cases = only ? ev.cases.filter((c) => c.name === only || c.name === `кейс-${only}`) : ev.cases;
  if (!cases.length) throw new Error(only ? `Кейс ${only} не найден в evals/` : 'В evals/ нет кейс-*/prompt.md');
  if (!ev.getEvals) log('! нет evals/get-evals-result.md — факт-отчёт собран не будет');

  if (path.basename(runId) !== runId || runId === '.' || runId === '..') throw new Error('Некорректный ID запуска');
  const resultsRoot = path.join(ev.evalsDir, 'results');
  fs.mkdirSync(resultsRoot, { recursive: true });
  const resultsDir = path.join(resultsRoot, runId);
  fs.mkdirSync(resultsDir);
  const factsFile = path.join(resultsDir, 'факты.md');
  const facts = [`# Факты прогона ${date}, стенд ${new URL(chatUrl).host}`, ''];
  const runLog = [];

  for (const c of cases) {
    for (let r = 1; r <= runs; r++) {
      log(`${c.name}, прогон ${r}/${runs}`);
      const runDir = path.join(resultsDir, 'прогоны', c.name, `прогон-${r}`);
      fs.mkdirSync(runDir, { recursive: true });
      const entry = { case: c.name, run: r, track: track || null, agent: agentName || null, skill: skill || null, startedAt: new Date().toISOString(), timingVersion: 2, questions: [], anomalies: [] };
      const t0 = performance.now();
      try {
        await newChat(page, sel, chatUrl, { agentName });
        if (fixtures) await attach(page, sel, ev.fixtures);
        assertNewChat(page);
        let res = await ask(page, sel, c.prompt);
        const responseTimesMs = [res.responseMs];
        entry.responseTimesSec = [Math.round(res.responseMs / 100) / 10];
        entry.chat = page.url(); // /sessions/<uuid> появляется после первой отправки
        const answers = [...c.answers];
        let q = 0;
        while (await pendingQuestion(page, sel, res.answer)) {
          const question = (await questionText(page, sel)) || res.answer.slice(-600);
          if (!answers.length || q >= maxQuestions) {
            entry.questions.push({ question, answer: null });
            entry.anomalies.push(q >= maxQuestions ? 'достигнут лимит вопросов — прогон не завершён' : 'вопрос агента без canned-ответа — прогон не завершён');
            entry.status = 'incomplete';
            break;
          }
          const a = answers.shift();
          entry.questions.push({ question, answer: a });
          res = await answerQuestion(page, sel, a);
          responseTimesMs.push(res.responseMs);
          entry.responseTimesSec.push(Math.round(res.responseMs / 100) / 10);
          q++;
        }
        entry.answerSec = Math.round(responseTimesMs.reduce((sum, ms) => sum + ms, 0) / 1000);
        entry.setupToAnswerSec = Math.round((performance.now() - t0) / 1000);
        fs.writeFileSync(path.join(runDir, 'ответ.md'), res.answer + '\n');
        fs.writeFileSync(path.join(runDir, 'лента.md'), res.transcript + '\n');

        let report = null;
        if (ev.getEvals && entry.status !== 'incomplete') {
          report = (await ask(page, sel, ev.getEvals)).answer;
          fs.writeFileSync(path.join(runDir, 'факт-отчёт.md'), report + '\n');
        }
        if (download) {
          const d = await downloadDocuments(page, sel, path.join(resultsDir, 'артефакты', c.name, `прогон-${r}`), new Set(ev.fixtures.map((f) => normName(path.basename(f)))));
          entry.files = d.files.map((f) => path.relative(resultsDir, f));
          entry.anomalies.push(...d.errors.map((e) => `скачивание: ${e}`));
        }
        facts.push(`## Кейс ${c.name.replace(/^кейс-/, '')}, прогон ${r}`, `- Чат: ${entry.chat}`, `- Статус: ${entry.status || 'done'}`, `- Время ответов от отправки до подтверждённой остановки: ${entry.answerSec} с (по ответам: ${entry.responseTimesSec.join(', ')} с)`, `- От начала прогона до последнего ответа: ${entry.setupToAnswerSec} с`, `- Промпт: ${c.prompt.replace(/\n+/g, ' ')}`);
        for (const q of entry.questions) facts.push(`- Вопрос агента / ответ: «${q.question.replace(/\n+/g, ' ').slice(0, 300)}» → ${q.answer ? `«${q.answer}»` : 'без ответа'}`);
        facts.push(`- Скачанные файлы: ${entry.files?.length ? entry.files.join(', ') : 'нет'}`);
        facts.push(`- Аномалии раннера: ${entry.anomalies.length ? entry.anomalies.join('; ') : 'нет'}`, '');
        if (report) facts.push('### Факт-отчёт агента', '', report, '');
        entry.status ||= 'done';
      } catch (e) {
        entry.status = 'error';
        entry.anomalies.push(e.message.split('\n')[0]);
        facts.push(`## Кейс ${c.name.replace(/^кейс-/, '')}, прогон ${r}`, `- Аномалии раннера: ${entry.anomalies.join('; ')}`, '');
        await page.screenshot({ path: path.join(runDir, 'ошибка.png'), fullPage: true }).catch(() => {});
      }
      entry.totalSec = Math.round((performance.now() - t0) / 1000);
      runLog.push(entry);
      fs.writeFileSync(factsFile, facts.join('\n'));
      fs.writeFileSync(path.join(resultsDir, 'run-log.json'), JSON.stringify(runLog, null, 2));
    }
  }
  return { resultsDir, facts: factsFile, runs: runLog.map(({ case: k, run, status, answerSec, responseTimesSec, setupToAnswerSec, totalSec, anomalies }) => ({ case: k, run, status, answerSec, responseTimesSec, setupToAnswerSec, totalSec, anomalies })) };
}
