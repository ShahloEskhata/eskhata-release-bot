# Автозапуск бота на Windows без pm2: задача планировщика с перезапуском при падении.
# Запуск от администратора: бот стартует вместе с Windows, даже если никто не вошёл в систему (рекомендуется).
# Без прав администратора: бот стартует при входе текущего пользователя.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 [-StartNow]
#
# Логи бота: logs\bot.log. Удалить задачу: Unregister-ScheduledTask -TaskName ReleaseBot -Confirm:$false
param([switch]$StartNow)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source

if (-not (Test-Path (Join-Path $root '.env'))) { throw "Не найден .env в $root - сначала создайте его из .env.example" }

# У фоновой задачи нет консоли, поэтому вывод бота пишем в файл
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null
$cmdArgs = "/c `"`"$node`" --use-system-ca --env-file=.env src/bot.js >> logs\bot.log 2>&1`""
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdArgs -WorkingDirectory $root

$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $mode = 'вместе с Windows (без входа пользователя)'
    # SYSTEM не видит файлы в профиле пользователя, например node из nvm
    if ($node -like "$env:USERPROFILE*") { Write-Warning "node установлен в профиле пользователя ($node): под SYSTEM он может быть недоступен. Установите Node.js для всех пользователей." }
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
    $mode = 'при входе пользователя (запустите скрипт от администратора, чтобы бот стартовал и без входа)'
}

Register-ScheduledTask -TaskName 'ReleaseBot' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Готово: задача ReleaseBot создана, бот стартует $mode."
Write-Host "Логи: $root\logs\bot.log"

if ($StartNow) {
    Start-ScheduledTask -TaskName 'ReleaseBot'
    Write-Host 'Бот запущен.'
} else {
    Write-Host 'Запустить сейчас: Start-ScheduledTask -TaskName ReleaseBot'
}
