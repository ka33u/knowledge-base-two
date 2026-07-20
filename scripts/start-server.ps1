param(
  [int]$Port = 8787,
  [string]$HostAddress = "0.0.0.0",
  [string]$DataDirectory = "",
  [string]$TlsCertificate = "",
  [string]$TlsKey = "",
  [switch]$TrustProxy
)
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$env:PORT = [string]$Port
$env:HOST = $HostAddress
if ($DataDirectory) { $env:DATA_DIR = $DataDirectory }
if ($TlsCertificate) { $env:TLS_CERT = $TlsCertificate }
if ($TlsKey) { $env:TLS_KEY = $TlsKey }
if ($TrustProxy) { $env:TRUST_PROXY = "1" }
$LogDirectory = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogFile = Join-Path $LogDirectory "server.log"
if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 10MB) {
  Move-Item $LogFile (Join-Path $LogDirectory ("server-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log"))
}
& node "$ProjectRoot\server.mjs" *>> $LogFile
exit $LASTEXITCODE
