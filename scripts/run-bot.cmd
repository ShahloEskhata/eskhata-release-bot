@echo off
rem Запасной запуск бота с автоперезапуском - если политика компьютера запрещает скрипты PowerShell.
rem Положите ярлык на этот файл в папку автозагрузки (Win+R -> shell:startup): бот будет стартовать при входе в Windows.
cd /d "%~dp0.."
if not exist logs mkdir logs
:loop
node --use-system-ca --env-file=.env src/bot.js >> logs\bot.log 2>&1
echo [%date% %time%] bot stopped, restarting in 10 s >> logs\bot.log
timeout /t 10 /nobreak >nul
goto loop
