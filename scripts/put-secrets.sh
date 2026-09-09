#!/bin/bash
set -euo pipefail

# Creates the three SecureString parameters the stack expects. CloudFormation cannot
# create SecureString parameters, so these live outside the stack and are only
# referenced by it. Re-run this any time a secret changes, then restart the server.
#
# Usage: ./scripts/put-secrets.sh [region]

REGION=${1:-us-east-1}

read -rsp "Valheim server password (min 5 chars, must not appear in the server or world name): " SERVER_PASSWORD
echo
read -rp  "Discord channel webhook URL: " DISCORD_WEBHOOK
read -rp  "Discord application public key: " DISCORD_PUBLIC_KEY

if [ ${#SERVER_PASSWORD} -lt 5 ]; then
    echo "Valheim rejects passwords shorter than 5 characters." >&2
    exit 1
fi

put() {
    aws ssm put-parameter \
        --name "$1" \
        --value "$2" \
        --type SecureString \
        --overwrite \
        --region "$REGION" \
        --output text --query Version > /dev/null
    echo "  wrote $1"
}

put /valheim/server-password  "$SERVER_PASSWORD"
put /valheim/discord-webhook  "$DISCORD_WEBHOOK"
put /valheim/discord-public-key "$DISCORD_PUBLIC_KEY"

echo "Done. All three parameters are in SSM in $REGION."
