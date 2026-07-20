param(
  [string]$DataDirectory = "",
  [string]$BackupDirectory = ""
)
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if ($DataDirectory) { $env:DATA_DIR = $DataDirectory }
if ($BackupDirectory) { $env:BACKUP_DIR = $BackupDirectory }
$LogDirectory = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogFile = Join-Path $LogDirectory "doctor.log"
if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 5MB) {
  Move-Item $LogFile (Join-Path $LogDirectory ("doctor-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log"))
}
$Output = (& node (Join-Path $PSScriptRoot "system-check.mjs") 2>&1 | Out-String).Trim()
$ExitCode = $LASTEXITCODE
Add-Content -Path $LogFile -Encoding UTF8 -Value ("`r`n===== " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " =====`r`n" + $Output)
exit $ExitCode
