#!/usr/bin/env bash
# Boots the BUILT app (dist/) against the configured database and walks the real user journey:
#   login (dev console OTP) -> protected catalog -> signed photo upload -> customer onboarding
#   -> worker onboarding + verification -> customer posts a job -> worker gets it live over the
#   WebSocket -> worker quotes -> customer compares and accepts -> job is ASSIGNED with an arrival code
#   -> customer issues a new code (arrival-code recovery) -> arrive, bill, approve, finish, pay, receipt
#   -> review, worker earnings, commission saved (Phase 6).
#
# Used by CI; also runnable locally after `npm run build`. It needs WORKER_VERIFICATION_MODE=auto
# (the development shortcut) so the test worker verifies itself. It creates two users (phones
# 9000000001 customer, 9000000002 worker), one job and some uploads. Remove them afterwards when
# running against a development database.
set -euo pipefail

PORT="${SMOKE_PORT:-3999}"
BASE="http://localhost:${PORT}"
CUSTOMER_PHONE="9000000001"
WORKER_PHONE="9000000002"
LOG="$(mktemp)"
WS_LOG="$(mktemp)"
JSON='Content-Type: application/json'

PORT="$PORT" node dist/main >"$LOG" 2>&1 &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT
fail() { echo "SMOKE FAILED: $1"; echo "--- app log"; cat "$LOG"; echo "--- websocket log"; cat "$WS_LOG" 2>/dev/null || true; exit 1; }

# Prints one value from a JSON document on stdin, e.g.:  echo "$R" | json 'v.accessToken'
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log($1)})"; }

# Logs in with the code the console sender printed and prints the access token.
login() {
  local phone="$1"
  curl -sf -X POST "$BASE/api/v1/auth/otp/request" -H "$JSON" -d "{\"phone\":\"$phone\"}" >/dev/null || fail "otp request for $phone"
  local code
  code="$(grep -o 'Code for .*: [0-9]\{6\}' "$LOG" | tail -1 | grep -o '[0-9]\{6\}$')"
  [ -n "$code" ] || fail "no OTP printed by the console sender for $phone"
  curl -sf -X POST "$BASE/api/v1/auth/otp/verify" -H "$JSON" -d "{\"phone\":\"$phone\",\"code\":\"$code\"}" | json 'v.accessToken' \
    || fail "otp verify for $phone"
}

# Presigns and uploads a small image straight to the signed URL; prints the storage key.
upload() {
  local token="$1" purpose="$2" presign url key
  presign="$(curl -sf -X POST "$BASE/api/v1/media/presign" -H "Authorization: Bearer $token" -H "$JSON" \
    -d "{\"purpose\":\"$purpose\",\"contentType\":\"image/jpeg\",\"sizeBytes\":16}")" || fail "presign $purpose"
  url="$(echo "$presign" | json 'v.uploadUrl')"
  key="$(echo "$presign" | json 'v.key')"
  printf '0123456789abcdef' | curl -sf -X PUT "$url" -H 'Content-Type: image/jpeg' --data-binary @- >/dev/null \
    || fail "upload $purpose to the signed URL"
  echo "$key"
}

for _ in $(seq 1 30); do
  curl -sf "$BASE/health" >/dev/null && break
  sleep 1
done
curl -sf "$BASE/health/ready" | grep -q '"db":"up"' || fail "database not ready"

# --- 1. Customer: login, protected catalog, onboarding with a photo ---
C_TOKEN="$(login "$CUSTOMER_PHONE")"
C_AUTH="Authorization: Bearer $C_TOKEN"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/service-categories")" = "401" ] || fail "catalog is not protected"
COUNT="$(curl -sf "$BASE/api/v1/service-categories" -H "$C_AUTH" | grep -o '"id"' | wc -l | tr -d ' ')"
# Keep in step with SERVICE_CATEGORIES in prisma/data/service-categories.ts (20 since the catalog expansion).
[ "$COUNT" = "20" ] || fail "expected 20 categories, got $COUNT"
AREA_ID="$(curl -sf "$BASE/api/v1/locations" -H "$C_AUTH" | json 'v[0].areas[0].id')"

PHOTO_KEY="$(upload "$C_TOKEN" PROFILE_PHOTO)"
PROFILE="$(curl -sf -X PUT "$BASE/api/v1/customers/me" -H "$C_AUTH" -H "$JSON" \
  -d "{\"fullName\":\"Smoke Customer\",\"photoKey\":\"$PHOTO_KEY\",\"address\":{\"areaId\":$AREA_ID,\"line\":\"House 1, Smoke Test Lane\"}}")" \
  || fail "customer onboarding"
echo "$PROFILE" | grep -q '"photoUrl":"http' || fail "customer profile has no photo link"
ADDRESS_ID="$(echo "$PROFILE" | json 'v.addresses[0].id')"

# --- 2. Worker: onboarding with both Aadhaar images; must end up VERIFIED (dev auto mode) ---
W_TOKEN="$(login "$WORKER_PHONE")"
W_AUTH="Authorization: Bearer $W_TOKEN"
curl -sf -X PUT "$BASE/api/v1/workers/me" -H "$W_AUTH" -H "$JSON" \
  -d "{\"fullName\":\"Smoke Worker\",\"trades\":[\"plumber\"],\"experienceYears\":5,\"languages\":[\"hi\"],\"baseAreaId\":$AREA_ID,\"radiusKm\":6,\"termsAccepted\":true}" >/dev/null \
  || fail "worker onboarding"
for side in AADHAAR_FRONT AADHAAR_BACK; do
  curl -sf -X PUT "$BASE/api/v1/workers/me/documents/$side" -H "$W_AUTH" -H "$JSON" \
    -d "{\"key\":\"$(upload "$W_TOKEN" AADHAAR)\"}" >/dev/null || fail "upload $side"
done
STATUS="$(curl -sf "$BASE/api/v1/workers/me" -H "$W_AUTH" | json 'v.verificationStatus')"
[ "$STATUS" = "VERIFIED" ] || fail "worker is $STATUS, expected VERIFIED (run the smoke test with WORKER_VERIFICATION_MODE=auto)"

# --- 3. The worker's phone listens live, then the customer posts a job ---
node scripts/ws-listen.mjs "$BASE" "$W_TOKEN" "$WS_LOG" 6000 &
WS_PID=$!
for _ in $(seq 1 20); do grep -q '__connected' "$WS_LOG" 2>/dev/null && break; sleep 0.25; done
grep -q '__connected' "$WS_LOG" || fail "websocket did not connect"

JOB="$(curl -sf -X POST "$BASE/api/v1/jobs" -H "$C_AUTH" -H "$JSON" \
  -d "{\"categoryId\":\"plumber\",\"title\":\"Smoke test leak\",\"timing\":\"IMMEDIATE\",\"addressId\":\"$ADDRESS_ID\"}")" || fail "post job"
JOB_ID="$(echo "$JOB" | json 'v.id')"
NOTIFIED="$(echo "$JOB" | json 'v.notifiedWorkers')"
[ "$NOTIFIED" -ge 1 ] || fail "no worker was notified of the new job"

# --- 4. Worker sees the lead (REST and pushed), without the address, and quotes ---
curl -sf "$BASE/api/v1/leads" -H "$W_AUTH" | grep -q "$JOB_ID" || fail "lead is not in the worker's feed"
LEAD="$(curl -sf "$BASE/api/v1/leads/$JOB_ID" -H "$W_AUTH")" || fail "lead detail"
echo "$LEAD" | grep -q 'House 1' && fail "the lead leaked the customer's address"
QUOTE="$(curl -sf -X POST "$BASE/api/v1/leads/$JOB_ID/offers" -H "$W_AUTH" -H "$JSON" -d '{"visitFee":250,"etaMinutes":15}')" \
  || fail "send quote"
QUOTE_ID="$(echo "$QUOTE" | json 'v.id')"

# --- 5. Customer compares and accepts ---
OFFERS="$(curl -sf "$BASE/api/v1/jobs/$JOB_ID/offers" -H "$C_AUTH")" || fail "list offers"
[ "$(echo "$OFFERS" | json 'v.length')" = "1" ] || fail "expected exactly one quote"
ACCEPTED="$(curl -sf -X POST "$BASE/api/v1/jobs/$JOB_ID/offers/$QUOTE_ID/accept" -H "$C_AUTH" -H "$JSON" -d '{}')" || fail "accept quote"
echo "$ACCEPTED" | grep -Eq '"arrivalCode":"[0-9]{4}"' || fail "no 4-digit arrival code"
[ "$(curl -sf "$BASE/api/v1/jobs/$JOB_ID" -H "$C_AUTH" | json 'v.status')" = "ASSIGNED" ] || fail "job is not ASSIGNED"

# --- 6. The push really arrived on the worker's phone ---
wait "$WS_PID" || true
grep -q '"event":"lead.new"' "$WS_LOG" || fail "worker did not receive lead.new over the WebSocket"
grep -q '"event":"offer.accepted"' "$WS_LOG" || fail "worker did not receive offer.accepted over the WebSocket"
grep -q 'House 1' "$WS_LOG" && fail "a pushed event leaked the customer's address"

# --- 7. Phase 5: arrive with the customer's code, bill, approve, finish, pay, receipt ---
ARRIVAL_CODE="$(echo "$ACCEPTED" | json 'v.arrivalCode')"
WRONG_CODE="0000"; [ "$ARRIVAL_CODE" = "0000" ] && WRONG_CODE="1111"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/jobs/$JOB_ID/arrival" -H "$W_AUTH" -H "$JSON" -d "{\"code\":\"$WRONG_CODE\"}")" = "422" ]   || fail "a wrong arrival code was not refused"
# Arrival-code recovery: the customer issues a new code; the old one stops working; a second reset is throttled.
RESET="$(curl -sf -X POST "$BASE/api/v1/jobs/$JOB_ID/arrival-code/reset" -H "$C_AUTH" -H "$JSON" -d '{}')" || fail "arrival-code reset"
NEW_CODE="$(echo "$RESET" | json 'v.arrivalCode')"
echo "$NEW_CODE" | grep -Eq '^[0-9]{4}$' || fail "the reset did not return a 4-digit code"
[ "$NEW_CODE" != "$ARRIVAL_CODE" ] || fail "the reset returned the same code"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/jobs/$JOB_ID/arrival-code/reset" -H "$C_AUTH" -H "$JSON" -d '{}')" = "429" ] || fail "a second reset straight away was not throttled"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/jobs/$JOB_ID/arrival" -H "$W_AUTH" -H "$JSON" -d "{\"code\":\"$ARRIVAL_CODE\"}")" = "422" ] || fail "the old arrival code still worked after the reset"
[ "$(curl -sf -X POST "$BASE/api/v1/jobs/$JOB_ID/arrival" -H "$W_AUTH" -H "$JSON" -d "{\"code\":\"$NEW_CODE\"}" | json 'v.status')" = "ARRIVED" ]   || fail "arrival with the right code did not reach ARRIVED"
BILL="$(curl -sf -X PUT "$BASE/api/v1/jobs/$JOB_ID/bill-items" -H "$W_AUTH" -H "$JSON"   -d '{"items":[{"kind":"PARTS","description":"PVC elbow","amount":300}]}')" || fail "bill items"
[ "$(echo "$BILL" | json 'v.total')" = "550" ] || fail "bill total is not 550"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/jobs/$JOB_ID/bill/approve" -H "$C_AUTH" -H "$JSON" -d '{"expectedTotal":250}')" = "409" ]   || fail "approving a stale total was not refused"
curl -sf -X POST "$BASE/api/v1/jobs/$JOB_ID/bill/approve" -H "$C_AUTH" -H "$JSON" -d '{"expectedTotal":550}' >/dev/null || fail "approve bill"
[ "$(curl -sf -X POST "$BASE/api/v1/jobs/$JOB_ID/complete-work" -H "$W_AUTH" -H "$JSON" -d '{}' | json 'v.status')" = "WORK_COMPLETED" ]   || fail "complete-work"
PAID="$(curl -sf -X POST "$BASE/api/v1/jobs/$JOB_ID/payment" -H "$C_AUTH" -H "$JSON" -d '{"method":"UPI"}')" || fail "payment"
[ "$(echo "$PAID" | json 'v.amount')" = "550" ] || fail "payment amount is not the bill total"
RECEIPT="$(curl -sf "$BASE/api/v1/jobs/$JOB_ID/receipt" -H "$C_AUTH")" || fail "receipt"
[ "$(echo "$RECEIPT" | json 'v.platformFee + "/" + v.total')" = "0/550" ] || fail "receipt does not show a zero platform fee and the right total"
[ "$(curl -sf "$BASE/api/v1/jobs/$JOB_ID" -H "$C_AUTH" | json 'v.status')" = "COMPLETED" ] || fail "job is not COMPLETED"

# --- 8. Phase 6: the customer rates the job; earnings and savings reflect it ---
REVIEW="$(curl -sf -X POST "$BASE/api/v1/jobs/$JOB_ID/review" -H "$C_AUTH" -H "$JSON" -d '{"rating":5,"tags":["PUNCTUAL"],"tipAmount":20}')" || fail "review"
[ "$(echo "$REVIEW" | json 'v.rating + "/" + v.tipAmount')" = "5/20" ] || fail "the review was not stored as sent"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/jobs/$JOB_ID/review" -H "$C_AUTH" -H "$JSON" -d '{"rating":1}')" = "409" ] || fail "a second review was not refused"
WORKER_ID="$(echo "$REVIEW" | json 'v.worker.id')"
PROFILE_CHECK='v.reviews.reviewsCount >= 1 && v.reviews.latest[0].rating === 5'
EARNINGS_CHECK='v.amount >= 550 && v.jobsDone >= 1 && v.platformFee === 0'
SAVINGS_CHECK='v.role === "customer" && v.jobsTotal >= 550 && v.commissionSaved === Math.round(v.jobsTotal * v.benchmarkRate)'
WORKER_VIEW="$(curl -sf "$BASE/api/v1/workers/$WORKER_ID" -H "$C_AUTH")" || fail "worker profile"
EARNINGS="$(curl -sf "$BASE/api/v1/workers/me/earnings" -H "$W_AUTH")" || fail "worker earnings"
SAVINGS="$(curl -sf "$BASE/api/v1/me/savings" -H "$C_AUTH")" || fail "savings"
[ "$(echo "$WORKER_VIEW" | json "$PROFILE_CHECK")" = "true" ] || fail "the worker profile does not show the review"
[ "$(echo "$EARNINGS" | json "$EARNINGS_CHECK")" = "true" ] || fail "worker earnings do not include the paid job"
[ "$(echo "$SAVINGS" | json "$SAVINGS_CHECK")" = "true" ] || fail "commission saved is not jobsTotal x benchmarkRate"

echo "SMOKE OK: login, catalog, uploads, onboarding, worker verification, job -> live lead -> quote -> accept -> arrive -> bill -> approve -> finish -> pay -> receipt -> COMPLETED -> review -> earnings -> savings, with an arrival-code reset on the way"
