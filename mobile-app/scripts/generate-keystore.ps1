param(
  [string]$Alias = "eduplayer",
  [string]$Output = (Join-Path $PSScriptRoot "..\eduplayer-release.jks")
)

$keytool = Get-Command keytool -ErrorAction Stop
if (Test-Path -LiteralPath $Output) {
  throw "Keystore already exists: $Output"
}

& $keytool.Source -genkeypair -v `
  -keystore $Output `
  -alias $Alias `
  -keyalg RSA `
  -keysize 4096 `
  -validity 10000

if ($LASTEXITCODE -ne 0) {
  throw "Keystore generation failed"
}

Write-Host "Keystore created: $Output"
Write-Host "Keep this file and its passwords offline. Never commit them to Git."
