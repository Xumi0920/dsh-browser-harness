# Install the DSH browser harness from GitHub Packages.
#
#   $env:GITHUB_TOKEN = "ghp_..."   # needs read:packages
#   .\scripts\install-github-packages.ps1
#
# The token is written only to a temporary npm userconfig that is deleted when
# the script exits; it is never persisted to your real ~/.npmrc.
# If you ran an older version of this script, remove the stored token with:
#   npm config delete "//npm.pkg.github.com/:_authToken"
# and revoke that token on GitHub.
param(
  [string]$Token = $env:GITHUB_TOKEN,
  [string]$Profile = "desktop"
)
$ErrorActionPreference = "Stop"
if (-not $Token) {
  throw "Set GITHUB_TOKEN (with read:packages) or pass -Token."
}
$dsh = Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
if (-not (Test-Path $dsh)) {
  $command = Get-Command dsh -ErrorAction SilentlyContinue
  if ($command) { $dsh = $command.Source } else { throw "DSH CLI not found; add dsh to PATH or pass it via the dsh plugin command." }
}
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-bh-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$previousUserConfig = $env:NPM_CONFIG_USERCONFIG
$previousAuthToken = $env:NODE_AUTH_TOKEN
try {
  $npmrc = Join-Path $tmpDir ".npmrc"
  $content = "@xumi0920:registry=https://npm.pkg.github.com" + [Environment]::NewLine +
    "//npm.pkg.github.com/:_authToken=" + $Token + [Environment]::NewLine
  [System.IO.File]::WriteAllText($npmrc, $content)
  $env:NPM_CONFIG_USERCONFIG = $npmrc
  $env:NODE_AUTH_TOKEN = $Token
  Write-Host "Installing @xumi0920/dsh-browser-harness into profile '$Profile'..."
  & $dsh plugin --profile $Profile add "@xumi0920/dsh-browser-harness"
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin install failed with exit code $LASTEXITCODE" }
} finally {
  $env:NPM_CONFIG_USERCONFIG = $previousUserConfig
  $env:NODE_AUTH_TOKEN = $previousAuthToken
  Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}
Write-Host "Done. Restart DeepSeek Harness, then check the plugin list."
