#!/bin/sh
# One-time setup for automatic deploys. Run it on your own computer, from the repo:
#
#     deploy/setup-deploy-key.sh <ssh-host-alias> [github-owner/repo]
#     deploy/setup-deploy-key.sh lab
#
# It needs: `ssh <alias>` working, `gh` logged in, and deploy.sh already on the server
# in ~/contest-bot (copy it with: scp deploy/deploy.sh <alias>:contest-bot/).
#
# What it does:
#   1. Makes a new SSH key pair just for GitHub Actions, in a temporary folder.
#   2. Adds the public key to the server's ~/.ssh/authorized_keys with
#      command="…/deploy.sh",restrict  — the key can run deploy.sh and nothing else:
#      no shell, no other commands, no port forwarding.
#   3. Stores the private key, the server's host key, and the address as repository
#      secrets (DEPLOY_*), then deletes the private key from this computer.
#
# To undo: delete the line ending in "contest-bot-deploy@github-actions" from the
# server's ~/.ssh/authorized_keys, and the DEPLOY_* secrets in the repo settings.
set -eu

ALIAS=${1:?usage: deploy/setup-deploy-key.sh <ssh-host-alias> [owner/repo]}
REPO=${2:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
COMMENT=contest-bot-deploy@github-actions

host=$(ssh -G "$ALIAS" | awk '$1=="hostname"{print $2}')
user=$(ssh -G "$ALIAS" | awk '$1=="user"{print $2}')
port=$(ssh -G "$ALIAS" | awk '$1=="port"{print $2}')
home=$(ssh "$ALIAS" 'printf %s "$HOME"')
script="$home/contest-bot/deploy.sh"

ssh "$ALIAS" "test -x '$script'" || { echo "Not found or not executable on the server: $script" >&2; exit 1; }

# The host key comes from your known_hosts (you already trust it), not from a fresh scan.
lookup=$host
[ "$port" = 22 ] || lookup="[$host]:$port"
known=$(ssh-keygen -F "$lookup" | grep -v '^#' || true)
[ -n "$known" ] || { echo "No known_hosts entry for $lookup. Connect once with: ssh $ALIAS" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
ssh-keygen -q -t ed25519 -N "" -C "$COMMENT" -f "$tmp/key"

echo "Server: allowing the new key to run only $script"
printf 'command="%s",restrict %s\n' "$script" "$(cat "$tmp/key.pub")" | ssh "$ALIAS" "
  set -e
  line=\$(cat)
  touch ~/.ssh/authorized_keys
  grep -v '$COMMENT' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp || true
  printf '%s\n' \"\$line\" >> ~/.ssh/authorized_keys.tmp
  chmod 600 ~/.ssh/authorized_keys.tmp
  mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys
"

echo "Check: the key must refuse anything but a deploy"
out=$(ssh -i "$tmp/key" -o IdentitiesOnly=yes -o BatchMode=yes -p "$port" "$user@$host" "id" 2>&1 || true)
case "$out" in
  *usage:\ deploy*) echo "  ok: '$out'" ;;
  *) echo "  unexpected answer, stopping: $out" >&2; exit 1 ;;
esac

echo "GitHub: setting secrets on $REPO"
gh secret set DEPLOY_SSH_KEY --repo "$REPO" < "$tmp/key"
printf '%s\n' "$known" | gh secret set DEPLOY_KNOWN_HOSTS --repo "$REPO"
printf '%s' "$host" | gh secret set DEPLOY_HOST --repo "$REPO"
printf '%s' "$user" | gh secret set DEPLOY_USER --repo "$REPO"
printf '%s' "$port" | gh secret set DEPLOY_PORT --repo "$REPO"

echo "Done. The private key now exists only in GitHub's secret store."
echo "Trigger a deploy: gh workflow run CI --repo $REPO --ref main"
