#!/bin/zsh
# Двойной щелчок: заново войти на стенд GigaCowork (когда истекла сессия).
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -d "$HOME/.nvm" ] && source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
[ -d node_modules/playwright ] || npm run setup
echo "Откроется браузер: войдите в GigaCowork, затем вернитесь сюда и нажмите Enter."
node cowork.mjs login --stand https://demo.cowork.ru && echo "Вход сохранён."
echo; read "?Нажмите Enter, чтобы закрыть окно"
