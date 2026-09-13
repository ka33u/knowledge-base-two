param(
  [int]$Port = 8787,
  [string]$ServiceTaskName = "HD-KnowledgeBase"
)
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDirectory = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogFile = Join-Path $LogDirectory "watchdog.log"
$Client = New-Object System.Net.Sockets.TcpClient
try {
  $Connect = $Client.BeginConnect("127.0.0.1", $Port, $null, $null)
  if (-not $Connect.AsyncWaitHandle.WaitOne(5000)) { throw "端口连接超时" }
  $Client.EndConnect($Connect)
  exit 0
} catch {
  $Message = "{0} 服务端口 {1} 不可用，正在启动计划任务 {2}。原因：{3}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Port, $ServiceTaskName, $_.Exception.Message
  Add-Content -Path $LogFile -Encoding UTF8 -Value $Message
  Start-ScheduledTask -TaskName $ServiceTaskName
  exit 1
} finally {
  $Client.Dispose()
}
