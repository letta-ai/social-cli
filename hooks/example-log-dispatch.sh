#!/usr/bin/env bash
# Example post-dispatch hook: log all dispatched actions
#
# Appends a line to a dispatch log file. Fire-and-forget — errors
# are logged but don't affect dispatch.
#
# Install: copy to hooks/ and add to config.yaml:
#   hooks:
#     postDispatch:
#       - event: "*"
#         command: "bash hooks/example-log-dispatch.sh"

set -euo pipefail

LOG_FILE="${SOCIAL_HOOK_LOG_FILE:-/tmp/social-cli-dispatch.log}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "${TIMESTAMP} event=${SOCIAL_HOOK_EVENT} platform=${SOCIAL_HOOK_PLATFORM} action_id=${SOCIAL_HOOK_ACTION_ID} target_id=${SOCIAL_HOOK_TARGET_ID}" >> "$LOG_FILE"
