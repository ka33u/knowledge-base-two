param(
  [int]$Port = 8787,
  [string]$TaskName = "HD-KnowledgeBase",
  [string]$BackupTaskName = "HD-KnowledgeBase-Backup",
  [string]$HealthTaskName = "HD-KnowledgeBase-Doctor",
  [string]$WatchdogTaskName = "HD-KnowledgeBase-Watchdog",
  [string]$HostAddress = "0.0.0.0",
  [string]$DataDirectory = "",
  [string]$BackupDirectory = "",
  [string]$TlsCertificate = "",
  [string]$TlsKey = "",
  [switch]$TrustProxy,
  [switch]$AllowPublicNetwork,
  [switch]$ConfigureNoAutoRestart
)
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source
$NodeMajor = [int]((& $Node --version).TrimStart('v').Split('.')[0])
if ($NodeMajor -ne 24) { throw "请安装 Node.js 24 LTS，当前版本：$(& $Node --version)" }
$FirewallProfiles = "Domain,Private"
if ($HostAddress -ne "127.0.0.1") {
  $PublicProfiles = @(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq "Public" -and ($_.IPv4Connectivity -ne "Disconnected" -or $_.IPv6Connectivity -ne "Disconnected") })
  if ($PublicProfiles.Count -gt 0 -and -not $AllowPublicNetwork) {
    $Names = ($PublicProfiles | ForEach-Object Name) -join "、"
    throw "检测到活动的 Public 网络（$Names）。请先由管理员改为 Private/Domain；确需在隔离的 Public 网络开放时，显式添加 -AllowPublicNetwork。"
  }
  if ($PublicProfiles.Count -gt 0) { $FirewallProfiles = "Domain,Private,Public" }
}
if ($ConfigureNoAutoRestart) {
  $UpdatePolicy = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU"
  New-Item -Path $UpdatePolicy -Force | Out-Null
  Set-ItemProperty -Path $UpdatePolicy -Name NoAutoRebootWithLoggedOnUsers -Value 1 -Type DWord
}
$PowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$ServerScript = Join-Path $PSScriptRoot "start-server.ps1"
$BackupScript = Join-Path $PSScriptRoot "backup.mjs"
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$ServerArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ServerScript`" -Port $Port -HostAddress `"$HostAddress`""
if ($DataDirectory) { $ServerArguments += " -DataDirectory `"$DataDirectory`"" }
if ($TlsCertificate) { $ServerArguments += " -TlsCertificate `"$TlsCertificate`"" }
if ($TlsKey) { $ServerArguments += " -TlsKey `"$TlsKey`"" }
if ($TrustProxy) { $ServerArguments += " -TrustProxy" }
$ServerAction = New-ScheduledTaskAction -Execute $PowerShell -Argument $ServerArguments -WorkingDirectory $ProjectRoot
$ServerTrigger = New-ScheduledTaskTrigger -AtStartup
$ServerTrigger.Delay = "PT30S"
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
$WatchdogScript = Join-Path $PSScriptRoot "watchdog.ps1"
$WatchdogArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$WatchdogScript`" -Port $Port -ServiceTaskName `"$TaskName`""
$WatchdogAction = New-ScheduledTaskAction -Execute $PowerShell -Argument $WatchdogArguments -WorkingDirectory $ProjectRoot
$WatchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $WatchdogTaskName -Action $WatchdogAction -Trigger $WatchdogTrigger -Principal $Principal -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew -StartWhenAvailable) -Force | Out-Null
if ($HostAddress -ne "127.0.0.1") {
  $FirewallName = "HD Knowledge Base $Port"
  $FirewallRule = Get-NetFirewallRule -DisplayName $FirewallName -ErrorAction SilentlyContinue
  if ($FirewallRule) { Set-NetFirewallRule -DisplayName $FirewallName -Enabled True -Profile $FirewallProfiles | Out-Null }
  else { New-NetFirewallRule -DisplayName $FirewallName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile $FirewallProfiles | Out-Null }
}
Start-ScheduledTask -TaskName $TaskName
Write-Host "已注册并启动：$TaskName；每日备份：$BackupTaskName；每日巡检：$HealthTaskName；5 分钟自愈：$WatchdogTaskName；端口：$Port；防火墙配置：$FirewallProfiles"
