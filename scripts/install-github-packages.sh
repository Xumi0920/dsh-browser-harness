#!/usr/bin/env bash
# Install the DSH browser harness from GitHub Packages.
#
#   export GITHUB_TOKEN=ghp_...   # needs read:packages
#   ./scripts/install-github-packages.sh [profile] [dsh-binary]
#
# The token is written only to a temporary npm userconfig that is deleted on
# exit; it is never persisted to your real ~/.npmrc.
# If you ran an older version of this script, remove the stored token with:
#   npm config delete "//npm.pkg.github.com/:_authToken"
# and revoke that token on GitHub.
set -euo pipefail
profile="${1:-desktop}"
token="${GITHUB_TOKEN:-${NPM_TOKEN:-}}"
if [ -z "${token}" ]; then
  echo "Set GITHUB_TOKEN (with read:packages) or NPM_TOKEN." >&2
  exit 1
fi
if [ -n "${2:-}" ]; then
  dsh="${2}"
elif command -v dsh >/dev/null 2>&1; then
  dsh="$(command -v dsh)"
else
  echo "DSH CLI not found. Pass it as the second argument, e.g.:" >&2
  echo "  ./scripts/install-github-packages.sh desktop /path/to/dsh" >&2
  exit 1
fi
tmpdir="$(mktemp -d)"
cleanup() { rm -rf "${tmpdir}"; }
trap cleanup EXIT
umask 077
npmrc="${tmpdir}/.npmrc"
printf '@xumi0920:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "${token}" > "${npmrc}"
echo "Installing @xumi0920/dsh-browser-harness into profile '${profile}'..."
NPM_CONFIG_USERCONFIG="${npmrc}" NODE_AUTH_TOKEN="${token}" "${dsh}" plugin --profile "${profile}" add "@xumi0920/dsh-browser-harness"
echo "Done. Restart DeepSeek Harness, then check the plugin list."
