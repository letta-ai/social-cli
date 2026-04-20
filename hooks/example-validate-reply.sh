#!/usr/bin/env bash
# Example pre-dispatch hook: validate reply content
#
# Blocks replies that are too short (likely low-effort) or contain
# certain patterns. Exit 0 = pass, 1 = block, 2 = abort.
#
# Install: copy to hooks/ and add to config.yaml:
#   hooks:
#     preDispatch:
#       - event: reply
#         command: "bash hooks/example-validate-reply.sh"

set -euo pipefail

TEXT="${SOCIAL_HOOK_TEXT:-}"
TARGET="${SOCIAL_HOOK_TARGET_ID:-}"
PLATFORM="${SOCIAL_HOOK_PLATFORM:-}"

# Block empty or very short replies (under 10 chars)
if [ ${#TEXT} -lt 10 ]; then
  echo "Reply too short (${#TEXT} chars): minimum 10"
  exit 1
fi

# Block replies that are just emoji
if [[ "$TEXT" =~ ^[[:space:][:emoji:]]+$ ]]; then
  echo "Reply is only emoji/spaces"
  exit 1
fi

# Pass
exit 0
