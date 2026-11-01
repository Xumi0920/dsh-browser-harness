# Install the DSH browser harness from GitHub Packages.
#
#   $env:GITHUB_TOKEN = "ghp_..."   # needs read:packages
#   .\scripts\install-github-packages.ps1
#
# Never commit the token. The script only writes npm registry/auth config and
# runs the DSH CLI plugin install.
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
  if ($command) { $dsh = $command.Source } else { throw "DSH CLI not found; pass the path via dsh.cmd or add dsh to PATH." }
}
npm config set "@xumi0920:registry" "https://npm.pkg.github.com"
npm config set "//npm.pkg.github.com/:_authToken" $Token
Write-Host "Installing @xumi0920/dsh-browser-harness into profile '$Profile'..."
& $dsh plugin --profile $Profile add "@xumi0920/dsh-browser-harness"
Write-Host "Done. Restart DeepSeek Harness, then check: plugin_manager { action: \"list_plugins\" }"
