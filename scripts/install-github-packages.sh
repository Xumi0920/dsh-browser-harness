#!/usr/bin/env bash
# Install the DSH browser harness from GitHub Packages.
#
#   export GITHUB_TOKEN=ghp_...   # needs read:packages
#   ./scripts/install-github-packages.sh [profile] [dsh-binary]
#
# Never commit the token. The script only writes npm registry/auth config and
# runs the DSH CLI plugin install.
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
npm config set "@xumi0920:registry" "https://npm.pkg.github.com"
npm config set "//npm.pkg.github.com/:_authToken" "${token}"
echo "Installing @xumi0920/dsh-browser-harness into profile '${profile}'..."
"${dsh}" plugin --profile "${profile}" add "@xumi0920/dsh-browser-harness"
echo "Done. Restart DeepSeek Harness, then check the plugin list."
