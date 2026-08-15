#!/usr/bin/env bash
# ============================================================================
# Scribsy Listening Post — one-shot idempotent deploy (Azure Cloud Shell, bash)
# Workloads: AOAI account + Function app + storage + Static Web App
#
# NO CREDENTIALS REQUIRED. Two-frame ingestion:
#   Reddit history/depth via Arctic Shift (free archive, no key) +
#   Bluesky real-time via the open AppView API (no key).
# Reddit's official API is closed to self-serve (Responsible Builder Policy,
# 2025-11). If a registration at developers.reddit.com/app-registration is ever
# approved, set REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET and REDDIT_MODE=oauth —
# the dormant OAuth adapter takes over live Reddit ingestion.
# Run:  bash deploy.sh          (add BACKFILL=1 to kick historical backfill)
#
# Provisioning gotchas applied: Microsoft.Web provider registration; FLEX
# Consumption only (Linux Consumption 400s on this subscription — see
# claude/flex-recreate-method-2026-08-15.md); Core Tools publish with
# --javascript; SWA in eastus2 (not offered in eastus).
# NOTE: re-running reasserts SUBREDDITS/SUB_TAGS defaults unless you pass env
# overrides — if the live list has drifted, export SUBREDDITS first (see runbook).
# ============================================================================
set -euo pipefail

# ---- config ----------------------------------------------------------------
LOC="eastus"
SWA_LOC="eastus2"                        # SWA not offered in eastus
RG="scribsy-listening"
ST="scribsylisten2026"
FN="scribsy-listen-fn-2026"
AOAI="scribsy-aoai-2026"
SWA="scribsy-insights"
KV="scribsy-kv-2026"                     # existing vault in scribsy-core
CORE_RG="scribsy-core"
LOGS_WS="scribsy-logs"                   # existing Log Analytics workspace
CHAT_MODEL="${CHAT_MODEL:-gpt-5-mini}"   # verified available Aug 2026 (retires 2027-02-06)
CHAT_MODEL_VERSION="${CHAT_MODEL_VERSION:-2025-08-07}"  # alternatives: az cognitiveservices account list-models -n $AOAI -g $RG -o table
SUBREDDITS="${SUBREDDITS:-writing,writers,nanowrimo,WritingWithAI,selfpublish,fantasywriters,scifiwriting,PubTips,KeepWriting,writingadvice,AIWritingLounge,NewAuthor,FictionWriting}"
# Frame tags: skewed enclave subs are excluded from the population cohort and
# reported as comparison frames. JSON map sub → enclave-pro | enclave-anti.
SUB_TAGS_DEFAULT='{"WritingWithAI":"enclave-pro","AIWritingLounge":"enclave-pro"}'
SUB_TAGS="${SUB_TAGS:-$SUB_TAGS_DEFAULT}"

# Optional — only used if REDDIT_MODE=oauth after an approved registration
REDDIT_CLIENT_ID="${REDDIT_CLIENT_ID:-}"
REDDIT_CLIENT_SECRET="${REDDIT_CLIENT_SECRET:-}"
REDDIT_MODE="${REDDIT_MODE:-arctic}"

echo "== providers =="
for ns in Microsoft.Web Microsoft.CognitiveServices Microsoft.Storage Microsoft.Insights; do
  state=$(az provider show --namespace "$ns" --query registrationState -o tsv 2>/dev/null || echo NotRegistered)
  [ "$state" = "Registered" ] || az provider register --namespace "$ns" --wait
done

echo "== resource group =="
az group create -n "$RG" -l "$LOC" -o none

echo "== storage =="
az storage account show -n "$ST" -g "$RG" -o none 2>/dev/null || \
  az storage account create -n "$ST" -g "$RG" -l "$LOC" --sku Standard_LRS --kind StorageV2 -o none
STCONN=$(az storage account show-connection-string -n "$ST" -g "$RG" -o tsv)
az storage container create -n raw --connection-string "$STCONN" -o none
# tables + queue are created by the app on first run (ensureInfra), but pre-create anyway
az storage table create -n posts --connection-string "$STCONN" -o none || true
az storage table create -n aggregates --connection-string "$STCONN" -o none || true
az storage queue create -n analyze-jobs --connection-string "$STCONN" -o none || true

echo "== azure openai (AI Foundry) =="
az cognitiveservices account show -n "$AOAI" -g "$RG" -o none 2>/dev/null || \
  az cognitiveservices account create -n "$AOAI" -g "$RG" -l "$LOC" \
    --kind OpenAI --sku S0 --custom-domain "$AOAI" -o none
az cognitiveservices account deployment show -n "$AOAI" -g "$RG" --deployment-name chat -o none 2>/dev/null || \
  az cognitiveservices account deployment create -n "$AOAI" -g "$RG" \
    --deployment-name chat \
    --model-name "$CHAT_MODEL" --model-version "$CHAT_MODEL_VERSION" --model-format OpenAI \
    --sku-name GlobalStandard --sku-capacity 100 -o none || {
      echo "!! chat deployment failed — list available models with:"
      echo "   az cognitiveservices account list-models -n $AOAI -g $RG -o table"
      echo "   then re-run with CHAT_MODEL=<name> CHAT_MODEL_VERSION=<ver> bash deploy.sh"
      exit 1
    }
az cognitiveservices account deployment show -n "$AOAI" -g "$RG" --deployment-name embed -o none 2>/dev/null || \
  az cognitiveservices account deployment create -n "$AOAI" -g "$RG" \
    --deployment-name embed \
    --model-name text-embedding-3-small --model-version 1 --model-format OpenAI \
    --sku-name GlobalStandard --sku-capacity 100 -o none || \
    echo "!! embed deployment failed — semantic /api/ask will fall back to score ranking (non-fatal)"
AOAI_ENDPOINT=$(az cognitiveservices account show -n "$AOAI" -g "$RG" --query properties.endpoint -o tsv)
AOAI_KEY=$(az cognitiveservices account keys list -n "$AOAI" -g "$RG" --query key1 -o tsv)

echo "== app insights =="
WS_ID=$(az monitor log-analytics workspace show -g "$CORE_RG" -n "$LOGS_WS" --query id -o tsv 2>/dev/null || true)
az monitor app-insights component show --app "${FN}-ai" -g "$RG" -o none 2>/dev/null || \
  az monitor app-insights component create --app "${FN}-ai" -g "$RG" -l "$LOC" \
    ${WS_ID:+--workspace "$WS_ID"} -o none
AI_CONN=$(az monitor app-insights component show --app "${FN}-ai" -g "$RG" --query connectionString -o tsv)

echo "== function app (FLEX consumption, Node 22) =="
# NEVER Linux Consumption (--consumption-plan-location): on this subscription it
# consistently 400s from Kudu/config-zip, sync-triggers, keys list, and function
# list. Flex fixed it first try, twice (2026-08-15, see
# claude/flex-recreate-method-2026-08-15.md). Node 22 is the Flex-verified runtime.
az functionapp show -n "$FN" -g "$RG" -o none 2>/dev/null || \
  az functionapp create -n "$FN" -g "$RG" -s "$ST" \
    --flexconsumption-location "$LOC" \
    --runtime node --runtime-version 22 -o none

echo "== app settings =="
az functionapp config appsettings set -n "$FN" -g "$RG" -o none --settings \
  "APPLICATIONINSIGHTS_CONNECTION_STRING=$AI_CONN" \
  "REDDIT_MODE=$REDDIT_MODE" \
  "REDDIT_CLIENT_ID=$REDDIT_CLIENT_ID" \
  "REDDIT_CLIENT_SECRET=$REDDIT_CLIENT_SECRET" \
  "REDDIT_USER_AGENT=azure:scribsy-listening-post:1.0 (research contact steven@scribsy.ai)" \
  "ARCTIC_BASE=https://arctic-shift.photon-reddit.com" \
  "BSKY_SERVICE=https://bsky.social" \
  "BSKY_IDENTIFIER=${BSKY_IDENTIFIER:-}" \
  "BSKY_APP_PASSWORD=${BSKY_APP_PASSWORD:-}" \
  "AOAI_ENDPOINT=$AOAI_ENDPOINT" \
  "AOAI_KEY=$AOAI_KEY" \
  "AOAI_DEPLOYMENT=chat" \
  "EMBED_DEPLOYMENT=embed" \
  "SUBREDDITS=$SUBREDDITS" \
  "SUB_TAGS=$SUB_TAGS" \
  "DAILY_ANALYZE_CAP=1500" \
  "MIN_COMMENTS_FOR_FETCH=3" \
  "BRAIN_CAPTURE_URL=${BRAIN_CAPTURE_URL:-}"

echo "== keep secret copies in key vault (continuity) =="
az keyvault secret set --vault-name "$KV" -n aoai-listening-key --value "$AOAI_KEY" -o none || \
  echo "  (kv write skipped — vault $KV unreachable; key still lives in app settings)"
[ -n "$REDDIT_CLIENT_SECRET" ] && az keyvault secret set --vault-name "$KV" -n reddit-client-secret --value "$REDDIT_CLIENT_SECRET" -o none || true

echo "== publish code (Core Tools; Flex manages its own deployment container) =="
# Do NOT set WEBSITE_RUN_FROM_PACKAGE on Flex and do not manage a package blob —
# Flex provisions app-package-<name>-<id> itself. The --javascript flag is
# REQUIRED (no local.settings.json here => "Can't determine project language").
cd "$(dirname "$0")/fn"
npm install --omit=dev --no-audit --no-fund
ls node_modules/@azure >/dev/null || { echo "!! npm install produced no @azure deps — aborting publish"; exit 1; }
func azure functionapp publish "$FN" --javascript 2>&1 | tail -8
cd - >/dev/null
sleep 20
echo "== functions indexed (expect 12) =="
az functionapp function list -g "$RG" -n "$FN" --query "[].name" -o tsv || \
  echo "!! function list failed — investigate before proceeding"

echo "== static web app =="
az staticwebapp show -n "$SWA" -g "$RG" -o none 2>/dev/null || \
  az staticwebapp create -n "$SWA" -g "$RG" -l "$SWA_LOC" --sku Free -o none
SWA_HOST=$(az staticwebapp show -n "$SWA" -g "$RG" --query defaultHostname -o tsv)
SWA_TOKEN=$(az staticwebapp secrets list -n "$SWA" -g "$RG" --query properties.apiKey -o tsv)
npx --yes @azure/static-web-apps-cli@latest deploy "$(dirname "$0")/swa" \
  --deployment-token "$SWA_TOKEN" --env production

echo "== CORS: allow the dashboard origin =="
az functionapp cors add -n "$FN" -g "$RG" --allowed-origins "https://${SWA_HOST}" -o none || true

echo "== function key (for the dashboard connect screen) =="
sleep 20
HOST_KEY=$(az functionapp keys list -n "$FN" -g "$RG" --query functionKeys.default -o tsv 2>/dev/null || \
           az functionapp keys list -n "$FN" -g "$RG" --query masterKey -o tsv)

echo
echo "============================================================"
echo " DONE"
echo "  Dashboard:  https://${SWA_HOST}"
echo "  API base:   https://${FN}.azurewebsites.net"
echo "  Key:        ${HOST_KEY}"
echo "  Enter the API base + key on the dashboard's connect screen."
echo "============================================================"

if [ "${BACKFILL:-0}" = "1" ]; then
  echo "== kicking historical backfill =="
  sleep 30   # let the app warm
  echo "  bluesky streams ..."
  curl -sf -X POST "https://${FN}.azurewebsites.net/api/backfill?stream=all&code=${HOST_KEY}" || echo "  bluesky backfill call failed (rerun later)"
  echo
  IFS=',' read -ra SUBS <<< "$SUBREDDITS"
  for sub in "${SUBS[@]}"; do
    # Arctic backfill is resumable: each call walks ~7.5 min of archive from the
    # per-sub watermark. Re-run this loop until responses show "exhausted": true.
    echo "  backfill r/$sub (12 months via Arctic Shift) ..."
    curl -sf -X POST "https://${FN}.azurewebsites.net/api/backfill?sub=${sub}&months=12&code=${HOST_KEY}" \
      || echo "  r/$sub backfill call failed (rerun later: POST /api/backfill?sub=$sub&months=12)"
    echo
  done
  echo "Backfill running. Re-run the per-sub calls until each reports exhausted:true."
  echo "Analysis drains through the queue (capped at DAILY_ANALYZE_CAP/day)."
  echo "First rollup once the queue drains:"
  echo "  curl -X POST 'https://${FN}.azurewebsites.net/api/rollupNow?code=${HOST_KEY}'"
fi
