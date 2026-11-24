// Раскладка кейса на Яндекс Диске по стандарту «Структура кейса» v1.2 (см. layout.py в evaluation/ кейсов).
export const LAYOUT = {
  prompts: 'Скиллы и промпты',
  input: 'Входные данные',
  results: 'Результаты тестирования',
  platform: 'GigaCowork',
  runnerReports: 'Отчёты/Запуски раннера',
};

// Имена вложений в чате и скачанных файлов отличаются знаками («№» → «_»), поэтому сравниваются без них.
export const normName = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// skip — нормализованные имена входных файлов и их основы (без расширения). Платформа показывает страницы
// входных PDF в «Документах» как «<имя>_p1.png»: это не результат агента.
export function isInputName(name, skip) {
  if (skip.has(normName(name))) return true;
  const page = /^(.*)_p\d+\.(png|jpe?g)$/i.exec(name);
  return !!page && skip.has(normName(page[1]));
}

export const inputKeys = (paths) => new Set(paths.flatMap((p) => {
  const base = p.split(/[\\/]/).pop();
  return [normName(base), normName(base.replace(/\.[^.]+$/, ''))];
}));

export const isHiddenName = (name) => name.startsWith('.') || name.startsWith('~$');

// <КОД>_промпт_A.md / <КОД>_промпт_B.md: ровно один файл на трек.
export function pickPrompt(names, track) {
  const re = new RegExp(`(промпт|промт|prompt)[\\s_-]*${track}\\.(md|txt)$`, 'i');
  const hits = names.filter((n) => re.test(n));
  if (hits.length !== 1) {
    throw new Error(hits.length ? `Для трека ${track} подходит несколько промптов: ${hits.join(', ')}` : `В «${LAYOUT.prompts}» нет файла промпта трека ${track} (ожидается <КОД>_промпт_${track}.md)`);
  }
  return hits[0];
}

// Скилл нужен только как метка в отчёте: раннер не привязывает его к агенту.
export const pickSkill = (names) => names.find((n) => /(скилл|skill)/i.test(n) && /giga/i.test(n) && /\.md$/i.test(n)) || null;

export const runFolder = (caseFolder, track, n) => `${caseFolder}/${LAYOUT.results}/track ${track}/${LAYOUT.platform}/${n} прогон`;

export const runNumber = (dirName) => Number(dirName.match(/^(\d+)\s*прогон$/i)?.[1]) || null;

// Первые `count` номеров прогонов, чьи папки на Диске отсутствуют или пусты; занятые (с файлами) не трогаем.
export function freeRuns(busy, count) {
  const out = [];
  for (let n = 1; out.length < count; n++) if (!busy.has(n)) out.push(n);
  return out;
}
