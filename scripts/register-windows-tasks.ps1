param(
  [int]$Port = 8787,
  [string]$TaskName = "HD-KnowledgeBase",
  [string]$BackupTaskName = "HD-KnowledgeBase-Backup",
  [string]$HealthTaskName = "HD-KnowledgeBase-Doctor",
  [string]$HostAddress = "0.0.0.0",
  [string]$DataDirectory = "",
  [string]$BackupDirectory = "",
  [string]$TlsCertificate = "",
  [string]$TlsKey = "",
  [switch]$TrustProxy
)
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source
$NodeMajor = [int]((& $Node --version).TrimStart('v').Split('.')[0])
if ($NodeMajor -ne 24) { throw "请安装 Node.js 24 LTS，当前版本：$(& $Node --version)" }
$PowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$ServerScript = Join-Path $PSScriptRoot "start-server.ps1"
$BackupScript = Join-Path $PSScriptRoot "backup.mjs"
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$ServerArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ServerScript`" -Port $Port -HostAddress `"$HostAddress`""
if ($DataDirectory) { $ServerArguments += " -DataDirectory `"$DataDirectory`"" }
if ($TlsCertificate) { $ServerArguments += " -TlsCertificate `"$TlsCertificate`"" }
if ($TlsKey) { $ServerArguments += " -TlsKey `"$TlsKey`"" }
if ($TrustProxy) { $ServerArguments += " -TrustProxy" }
$ServerAction = New-ScheduledTaskAction -Execute $PowerShell -Argument $ServerArguments -WorkingDirectory $ProjectRoot
$ServerTrigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName $TaskName -Action $ServerAction -Trigger $ServerTrigger -Principal $Principal -Settings $Settings -Force | Out-Null
$BackupArguments = "`"$BackupScript`""
if ($DataDirectory) { $BackupArguments += " `"--data=$DataDirectory`"" }
if ($BackupDirectory) { $BackupArguments += " `"--output=$BackupDirectory`"" }
$BackupAction = New-ScheduledTaskAction -Execute $Node -Argument $BackupArguments -WorkingDirectory $ProjectRoot
$BackupTrigger = New-ScheduledTaskTrigger -Daily -At 2:00AM
Register-ScheduledTask -TaskName $BackupTaskName -Action $BackupAction -Trigger $BackupTrigger -Principal $Principal -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew) -Force | Out-Null
$DoctorScript = Join-Path $PSScriptRoot "run-doctor.ps1"
$DoctorArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$DoctorScript`""
if ($DataDirectory) { $DoctorArguments += " -DataDirectory `"$DataDirectory`"" }
if ($BackupDirectory) { $DoctorArguments += " -BackupDirectory `"$BackupDirectory`"" }
$DoctorAction = New-ScheduledTaskAction -Execute $PowerShell -Argument $DoctorArguments -WorkingDirectory $ProjectRoot
$DoctorTrigger = New-ScheduledTaskTrigger -Daily -At 6:00AM
Register-ScheduledTask -TaskName $HealthTaskName -Action $DoctorAction -Trigger $DoctorTrigger -Principal $Principal -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew) -Force | Out-Null
if ($HostAddress -ne "127.0.0.1" -and -not (Get-NetFirewallRule -DisplayName "HD Knowledge Base $Port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "HD Knowledge Base $Port" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Domain,Private | Out-Null
}
Start-ScheduledTask -TaskName $TaskName
Write-Host "已注册并启动：$TaskName；每日备份任务：$BackupTaskName；每日巡检任务：$HealthTaskName；端口：$Port"
