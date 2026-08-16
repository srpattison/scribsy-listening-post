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
# SETTINGS ARE PRESERVED, NOT CLOBBERED: a setting already present on the live
# app and absent from your environment is left untouched. Shipped defaults apply
# only when a setting exists in neither. You no longer need to pre-export
# SUBREDDITS / BSKY_APP_PASSWORD to avoid losing them.
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
# ---- shipped defaults ------------------------------------------------------
# These are FALLBACKS OF LAST RESORT, used only when a setting is absent from
# BOTH the environment and the live app. Existing live values are preserved (see
# "app settings" below) — deploy.sh no longer clobbers what it was not given.
#
# As-built sub list 2026-08-15 (23): the 22 of round 3 plus BetterOffline.
DEFAULT_SUBREDDITS_VALUE='writing,writers,nanowrimo,WritingWithAI,selfpublish,fantasywriters,scifiwriting,PubTips,KeepWriting,writingadvice,AIWritingLounge,NewAuthor,FictionWriting,FanFiction,AO3,eroticauthors,BetaReaders,DestructiveReaders,worldbuilding,Screenwriting,writingcirclejerk,selfpublishing,BetterOffline'
# Frame tags: skewed enclave subs are excluded from the population cohort and
# reported as comparison frames. JSON map sub → enclave-pro | enclave-anti | enclave-satire.
DEFAULT_SUB_TAGS_VALUE='{"WritingWithAI":"enclave-pro","AIWritingLounge":"enclave-pro","writingcirclejerk":"enclave-satire","BetterOffline":"enclave-anti"}'
# Bluesky streams. `topic` streams are keyword searches ON the subject under
# study; `community` streams are the UNFILTERED writer-population baseline and
# must never be keyword-gated or pooled with topic streams — a corpus selected
# on people discussing AI cannot measure how many writers discuss AI.
DEFAULT_BSKY_STREAMS_VALUE='[
{"name":"bsky-writing-ai","query":"writing AI novel","kind":"topic"},
{"name":"bsky-ai-ethics","query":"writers AI ethics","kind":"topic"},
{"name":"bsky-ai-slop","query":"AI slop writing","kind":"topic"},
{"name":"bsky-ai-accused","query":"accused AI writing","kind":"topic"},
{"name":"bsky-ai-disclosure","query":"author AI disclosure","kind":"topic"},
{"name":"bsky-nanowrimo","query":"nanowrimo","kind":"topic"},
{"name":"bsky-novel-november","query":"\"novel november\"","kind":"topic"},
{"name":"bsky-writersky","query":"#WriterSky","kind":"community"},
{"name":"bsky-booksky","query":"#BookSky","kind":"community"},
{"name":"bsky-writingcommunity","query":"#WritingCommunity","kind":"community"}
]'
DEFAULT_BSKY_STREAMS_VALUE=$(printf '%s' "$DEFAULT_BSKY_STREAMS_VALUE" | tr -d '\n')
# Comment analysis ships OFF. Comments are fetched and archived; zero comment
# analysis runs until this is explicitly changed. The comment:post ratio is
# unmeasured and plausible values span 10x-40x, which swings the comment line
# item too widely to commit against the remaining budget. Measure, then set.
DEFAULT_COMMENT_ANALYZE_POLICY='ingest-only'
DEFAULT_COMMENT_MIN_CHARS='400'
DEFAULT_DAILY_ANALYZE_CAP='12000'
# Bot/boilerplate detection. AutoModerator megathreads run on a schedule, so a
# 12-month backfill captures dozens of byte-identical copies per sub, each
# carrying the sub's rule text. MIN_CHARS is the false-positive floor: ordinary
# repeated human phrasing ("good luck with your draft") normalises to ~25 chars,
# real boilerplate to several hundred.
DEFAULT_BOILERPLATE_MIN_REPEATS='5'
DEFAULT_BOILERPLATE_MIN_CHARS='120'

# Optional — only used if REDDIT_MODE=oauth after an approved registration.
# Deliberately NOT defaulted here: `resolve` below must be able to tell "the
# operator did not pass this" from "the operator passed a value", or the
# preservation rule cannot work.
REDDIT_CLIENT_SECRET="${REDDIT_CLIENT_SECRET:-}"

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
# Both queues are pre-created so a cold deploy never depends on the app's own
# ensureInfra() to repair its infrastructure at runtime.
az storage queue create -n analyze-jobs --connection-string "$STCONN" -o none || true
az storage queue create -n backfill-jobs --connection-string "$STCONN" -o none || true

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
# --- BEGIN settings-preservation ---
# deploy.sh used to reassert every setting from the environment on each run, so
# anything not pre-exported was overwritten with empty. That has been a live
# hazard twice: SUBREDDITS (would revert the sub list to a hardcoded default)
# and BSKY_IDENTIFIER / BSKY_APP_PASSWORD (would silently dark the Bluesky
# frame on the next ingest). The only defence was an operator remembering.
#
# Precedence is now explicit:
#   1. a value given in the environment  -> written
#   2. otherwise a value already live    -> PRESERVED, never overwritten
#   3. otherwise the shipped default     -> written
SETTINGS_TO_WRITE=()
PRESERVED_SETTINGS=()

# Look up a setting on the live app. Overridable in tests.
live_get() {
  printf '%s' "$LIVE_SETTINGS_JSON" | jq -r --arg n "$1" \
    'map(select(.name == $n)) | if length > 0 then .[0].value else "" end' 2>/dev/null
}

# put NAME VALUE — unconditional write (values this script derives itself).
put() { SETTINGS_TO_WRITE+=("$1=$2"); }

# resolve NAME ENV_VALUE DEFAULT — apply the precedence above.
resolve() {
  local name="$1" envval="$2" def="$3" live
  if [ -n "$envval" ]; then
    SETTINGS_TO_WRITE+=("$name=$envval")
    return 0
  fi
  live=$(live_get "$name")
  if [ -n "$live" ] && [ "$live" != "null" ]; then
    PRESERVED_SETTINGS+=("$name")
    return 0
  fi
  SETTINGS_TO_WRITE+=("$name=$def")
}
# --- END settings-preservation ---

LIVE_SETTINGS_JSON=$(az functionapp config appsettings list -n "$FN" -g "$RG" -o json 2>/dev/null || echo '[]')

# Derived each run — always written.
put "APPLICATIONINSIGHTS_CONNECTION_STRING" "$AI_CONN"
put "AOAI_ENDPOINT" "$AOAI_ENDPOINT"
put "AOAI_KEY" "$AOAI_KEY"
put "AOAI_DEPLOYMENT" "chat"
put "EMBED_DEPLOYMENT" "embed"
put "REDDIT_USER_AGENT" "azure:scribsy-listening-post:1.0 (research contact steven@scribsy.ai)"
put "ARCTIC_BASE" "https://arctic-shift.photon-reddit.com"
put "BSKY_SERVICE" "https://bsky.social"

# Operator-owned — preserved when the environment is silent.
resolve "SUBREDDITS"             "${SUBREDDITS:-}"             "$DEFAULT_SUBREDDITS_VALUE"
resolve "SUB_TAGS"               "${SUB_TAGS:-}"               "$DEFAULT_SUB_TAGS_VALUE"
resolve "BSKY_STREAMS"           "${BSKY_STREAMS:-}"           "$DEFAULT_BSKY_STREAMS_VALUE"
resolve "BSKY_IDENTIFIER"        "${BSKY_IDENTIFIER:-}"        ""
resolve "BSKY_APP_PASSWORD"      "${BSKY_APP_PASSWORD:-}"      ""
resolve "BRAIN_CAPTURE_URL"      "${BRAIN_CAPTURE_URL:-}"      ""
resolve "DAILY_ANALYZE_CAP"      "${DAILY_ANALYZE_CAP:-}"      "$DEFAULT_DAILY_ANALYZE_CAP"
resolve "COMMENT_ANALYZE_POLICY" "${COMMENT_ANALYZE_POLICY:-}" "$DEFAULT_COMMENT_ANALYZE_POLICY"
resolve "COMMENT_MIN_CHARS"      "${COMMENT_MIN_CHARS:-}"      "$DEFAULT_COMMENT_MIN_CHARS"
resolve "BOILERPLATE_MIN_REPEATS" "${BOILERPLATE_MIN_REPEATS:-}" "$DEFAULT_BOILERPLATE_MIN_REPEATS"
resolve "BOILERPLATE_MIN_CHARS"   "${BOILERPLATE_MIN_CHARS:-}"   "$DEFAULT_BOILERPLATE_MIN_CHARS"
resolve "MIN_COMMENTS_FOR_FETCH" "${MIN_COMMENTS_FOR_FETCH:-}" "3"
resolve "REDDIT_MODE"            "${REDDIT_MODE:-}"            "arctic"
resolve "REDDIT_CLIENT_ID"       "${REDDIT_CLIENT_ID:-}"       ""
resolve "REDDIT_CLIENT_SECRET"   "${REDDIT_CLIENT_SECRET:-}"   ""

if [ ${#PRESERVED_SETTINGS[@]} -gt 0 ]; then
  echo "  preserving live values (not in environment): ${PRESERVED_SETTINGS[*]}"
fi
az functionapp config appsettings set -n "$FN" -g "$RG" -o none \
  --settings ${SETTINGS_TO_WRITE[@]+"${SETTINGS_TO_WRITE[@]}"}

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
# As-built inventory (verified 2026-08-16, round 5): analyze, ask, backfill,
# backfillWorker, export, ingestDaily, ingestNow, insights, ping, reanalyze,
# retag, rollupDaily, rollupNow.
EXPECTED_FUNCTIONS=13
echo "== functions indexed (expect $EXPECTED_FUNCTIONS) =="
if FN_LIST=$(az functionapp function list -g "$RG" -n "$FN" --query "[].name" -o tsv); then
  echo "$FN_LIST"
  FN_COUNT=$(printf '%s\n' "$FN_LIST" | grep -c . || true)
  if [ "$FN_COUNT" -ne "$EXPECTED_FUNCTIONS" ]; then
    echo "!! indexed $FN_COUNT functions, expected $EXPECTED_FUNCTIONS — indexing is incomplete or the inventory is stale; investigate before trusting this deploy"
  fi
else
  echo "!! function list failed — investigate before proceeding"
fi

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
# The key is NOT printed. It has leaked into two transcripts by being echoed
# here; a deploy log is not a secret store. Fetch it deliberately when needed:
echo "  Key:        (not printed — fetch with the command below)"
echo "    az functionapp keys list -n ${FN} -g ${RG} --query functionKeys.default -o tsv"
echo "  Enter the API base + key on the dashboard's connect screen."
echo "============================================================"

if [ "${BACKFILL:-0}" = "1" ]; then
  echo "== kicking historical backfill =="
  sleep 30   # let the app warm
  echo "  bluesky streams ..."
  curl -sf -X POST "https://${FN}.azurewebsites.net/api/backfill?stream=all&code=${HOST_KEY}" || echo "  bluesky backfill call failed (rerun later)"
  echo
  # Walk whatever the app is ACTUALLY configured with, not what this script
  # would have defaulted to — the two can legitimately differ now that live
  # settings are preserved.
  EFFECTIVE_SUBREDDITS=$(az functionapp config appsettings list -n "$FN" -g "$RG" \
    --query "[?name=='SUBREDDITS'].value" -o tsv 2>/dev/null || echo "")
  IFS=',' read -ra SUBS <<< "$EFFECTIVE_SUBREDDITS"
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
  echo "  KEY=\$(az functionapp keys list -n ${FN} -g ${RG} --query functionKeys.default -o tsv)"
  echo "  curl -X POST \"https://${FN}.azurewebsites.net/api/rollupNow?code=\$KEY\""
fi
