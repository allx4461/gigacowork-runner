#!/bin/zsh
# Двойной щелчок: запустить локальный тест или тест с Яндекс Диска.
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -d "$HOME/.nvm" ] && source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
pause() { echo; read "?Нажмите Enter, чтобы закрыть окно"; exit ${1:-0}; }

echo "=== Тест GigaCowork ==="
if (( $# )); then
  mode=2
else
  echo "1 — локальный кейс"
  echo "2 — кейс на Яндекс Диске"
  read "mode?Выберите режим (1 или 2): "
  [[ "$mode" == 1 || "$mode" == 2 ]] || { echo "Неизвестный режим."; pause 1; }
fi
if ! command -v node >/dev/null; then
  echo "Не установлен Node.js. Скачайте LTS-версию с https://nodejs.org, установите и запустите снова."
  open "https://nodejs.org"; pause 1
fi

if [ ! -d node_modules/playwright ]; then
  echo "Первый запуск: устанавливаю нужные компоненты (несколько минут)…"
  npm run setup || { echo "Установка не удалась — пришлите текст выше тому, кто настраивал раннер."; pause 1; }
fi

if [ ! -f "$HOME/.skill-craft/storage-state.json" ]; then
  echo "Нет входа на стенд. Сейчас откроется браузер: войдите в GigaCowork, затем вернитесь сюда и нажмите Enter."
  node cowork.mjs login --stand https://demo.cowork.ru || pause 1
fi

if [[ "$mode" == 1 ]]; then
  echo "Выберите папку подготовленного трека с plugin.yaml и evals."
  CASE_DIR=$(osascript -e 'POSIX path of (choose folder with prompt "Выберите папку трека с plugin.yaml и evals")') || {
    echo "Выбор папки отменён."; pause 1
  }
  [[ -f "$CASE_DIR/plugin.yaml" && -d "$CASE_DIR/evals" ]] || {
    echo "В выбранной папке нужны plugin.yaml и папка evals."; pause 1
  }
  read "track?Трек A или B: "
  track="${track:u}"
  [[ "$track" == A || "$track" == B ]] || { echo "Укажите A или B."; pause 1; }
  read "workspace?Вставьте ссылку на пространство GigaCowork: "
  [[ "$workspace" =~ '^https://demo\.cowork\.ru/workspaces/[0-9a-fA-F-]{36}([/?#].*)?$' ]] || {
    echo "Нужна ссылка на пространство demo.cowork.ru/workspaces/…"; pause 1
  }
  read "runs?Сколько прогонов (Enter = 3): "
  runs="${runs:-3}"
  [[ "$runs" =~ '^[1-9][0-9]*$' ]] || { echo "Укажите целое число больше нуля."; pause 1; }
  args=(evals "$CASE_DIR" --stand https://demo.cowork.ru --url "$workspace" --track "$track" --runs "$runs" --timeout-min 45 --headless)
  if [[ "$track" == B ]]; then
    echo "Навык должен быть заранее доступен в пространстве: раннер не устанавливает и не проверяет его."
    read "agent?Имя агента, если он нужен (иначе Enter): "
    if [[ -n "$agent" ]]; then args+=(--agent "$agent"); else args+=(--no-agent); fi
  else
    args+=(--no-agent)
  fi
  output=$(mktemp "${TMPDIR:-/tmp}/cowork-local.XXXXXXXX") || { echo "Не удалось создать временный файл."; pause 1; }
  trap 'rm -f -- "$output"' EXIT
  echo "Начинаю локальный тест. Не закрывайте окно; браузер работает в скрытом режиме."
  caffeinate -i node cowork.mjs "${args[@]}" | tee "$output"
  run_status=${pipestatus[1]}
  if (( run_status != 0 )); then
    echo "Запуск завершился с ошибкой. Проверьте сообщение выше."; pause 1
  fi
  result_dir=$(node -e '
    const fs = require("node:fs");
    const line = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).reverse().find(x => x.startsWith("RESULT "));
    if (!line) { console.error("Раннер не вернул результат."); process.exit(1); }
    const result = JSON.parse(line.slice(7));
    if (result.error || !result.resultsDir || !Array.isArray(result.runs)) {
      console.error(result.error || "В результате нет папки или списка прогонов."); process.exit(1);
    }
    for (const run of result.runs) console.error(`${run.case}, прогон ${run.run}: ${run.status}${run.anomalies?.length ? " — " + run.anomalies.join("; ") : ""}`);
    console.log(result.resultsDir);
  ' "$output") || { echo "Не удалось прочитать результат запуска."; pause 1; }
  echo "Результаты сохранены: $result_dir"
  echo "Проверьте статусы прогонов выше: ошибки и незавершённые прогоны не являются успешными."
  open "$result_dir" || echo "Не удалось открыть папку автоматически."
  pause
fi

TOKEN_FILE="$HOME/.skill-craft/yadisk-token"
if [ ! -s "$TOKEN_FILE" ]; then
  mkdir -p "$HOME/.skill-craft"
  echo "Нужен токен Яндекс Диска (его выдаёт тот, кто настраивал раннер)."
  read -s "T?Вставьте токен и нажмите Enter (символы не отображаются): "; echo
  printf %s "$T" > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"
fi

echo
echo "Сейчас нужно выбрать папку теста на Яндекс Диске и пространство."
echo "Пока идёт тест (до 2 часов), не закрывайте это окно. Mac не уснёт сам."
echo
caffeinate -i node yadisk-test.mjs "$@" | tee .last-result.txt
URL=$(grep -o '"web":"[^"]*"' .last-result.txt | cut -d'"' -f4)
if [[ "$*" == *--dry-run* ]]; then
  echo; echo "Проверка завершена: файлы с Диска скачаны, на стенд ничего не отправлялось."
elif [ -n "$URL" ]; then
  echo; echo "Тест завершён. Открываю отчёт на Яндекс Диске…"; open "$URL"
else
  echo; echo "Тест завершился с ошибкой. Подсказки:"
  echo " • «повторите login» / «Сессия стенда истекла» — запустите «Войти на стенд» и затем тест снова."
  echo " • «401» от Диска — токен не подходит: удалите файл ~/.skill-craft/yadisk-token и запустите тест снова."
  echo " • Иное — сделайте снимок этого окна и отправьте тому, кто настраивал раннер."
fi
rm -f .last-result.txt
pause
