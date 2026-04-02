#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Update credentials in an existing portable package
# Usage: ./update-credentials.sh <path-to-portable-dir>
# Example: ./update-credentials.sh /mnt/usb/claude-portable-win-x64
# =============================================================================

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <path-to-portable-dir>"
    echo "Example: $0 ./dist/claude-portable-win-x64"
    exit 1
fi

TARGET_DIR="$1"

if [[ ! -d "${TARGET_DIR}/data" ]]; then
    echo -e "${RED}Error: ${TARGET_DIR} is not a valid portable package${NC}"
    exit 1
fi

if [[ ! -f "${HOME}/.claude/.credentials.json" ]]; then
    echo -e "${RED}Error: No credentials found at ~/.claude/.credentials.json${NC}"
    echo "Run 'claude auth login' first on this machine."
    exit 1
fi

# Update credentials
mkdir -p "${TARGET_DIR}/data/.claude"
cp "${HOME}/.claude/.credentials.json" "${TARGET_DIR}/data/.claude/.credentials.json"

# Update state file
if [[ -f "${HOME}/.claude.json" ]]; then
    python3 -c "
import json
with open('${HOME}/.claude.json') as f:
    d = json.load(f)
minimal = {
    'hasCompletedOnboarding': True,
    'numStartups': 1,
    'installMethod': 'global',
}
if 'oauthAccount' in d:
    minimal['oauthAccount'] = d['oauthAccount']
with open('${TARGET_DIR}/data/.claude/.claude.json', 'w') as f:
    json.dump(minimal, f, indent=2)
"
fi

# Show result
echo -e "${GREEN}Credentials updated!${NC}"
python3 -c "
import json, time
with open('${TARGET_DIR}/data/.claude/.credentials.json') as f:
    d = json.load(f)['claudeAiOauth']
exp = d['expiresAt'] / 1000
print(f'  Token expires: {time.strftime(\"%Y-%m-%d %H:%M\", time.localtime(exp))}')
print(f'  Scopes: {\", \".join(d[\"scopes\"])}')
"
