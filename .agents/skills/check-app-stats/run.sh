#!/opt/homebrew/bin/bash
set -e

REGION="us-east-1"
PROFILE_OLD="sandbox"
PROFILE_NEW="kag-sandbox"
PROFILE_MAIN="$PROFILE_OLD"
PROFILE_KAG="$PROFILE_NEW"
APP_NAME_MAIN="marp-agent"
APP_NAME_KAG="marp-agent-kag"
MAIN_NEW_PROJECT_TAG="pawapo-public"
KAG_NEW_PROJECT_TAG="pawapo-kag"
RUNTIME_MAIN_OLD="marp_agent_main"
RUNTIME_MAIN_NEW="pawapo_agent_main"
RUNTIME_KAG_OLD="marp_agent_kag"
RUNTIME_KAG_NEW="marp_agent_main"
RUNTIME_DEV_OLD="marp_agent_dev"
OUTPUT_DIR="/tmp/marp-stats"
mkdir -p "$OUTPUT_DIR"

echo "📊 Marp Agent 利用状況を取得中..."

empty_query_results() {
  echo '{"results":[]}'
}

empty_cost_results() {
  echo '{"ResultsByTime":[]}'
}

is_valid_value() {
  local value=${1:-}
  [ -n "$value" ] && [ "$value" != "None" ] && [ "$value" != "null" ]
}

get_amplify_app_id() {
  local profile=$1
  local app_name=$2
  aws amplify list-apps --region "$REGION" --profile "$profile" \
    --query "apps[?name=='${app_name}'].appId | [0]" --output text 2>/dev/null || true
}

get_user_pool_from_app() {
  local profile=$1
  local app_id=$2
  local branch_name=${3:-main}
  local stack_name

  if ! is_valid_value "$app_id"; then
    echo ""
    return
  fi

  stack_name=$(aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
    --region "$REGION" --profile "$profile" \
    --query "StackSummaries[?contains(StackName, '${app_id}-${branch_name}-branch') && contains(StackName, 'auth')].StackName | [0]" \
    --output text 2>/dev/null || true)

  if ! is_valid_value "$stack_name"; then
    echo ""
    return
  fi

  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --region "$REGION" --profile "$profile" \
    --query "Stacks[0].Outputs[?contains(OutputKey, 'UserPool') && !contains(OutputKey, 'AppClient')].OutputValue | [0]" \
    --output text 2>/dev/null || true
}

get_user_pool_by_name_contains() {
  local profile=$1
  local name_fragment=$2
  aws cognito-idp list-user-pools --max-results 60 --region "$REGION" --profile "$profile" \
    --query "UserPools[?contains(Name, '${name_fragment}')].Id | [0]" --output text 2>/dev/null || true
}

write_users_json() {
  local profile=$1
  local pool_id=$2
  local output_file=$3

  if is_valid_value "$pool_id"; then
    aws cognito-idp list-users \
      --user-pool-id "$pool_id" \
      --region "$REGION" --profile "$profile" \
      --output json > "$output_file" 2>/dev/null || echo '{"Users":[]}' > "$output_file"
  else
    echo '{"Users":[]}' > "$output_file"
  fi
}

unique_user_count() {
  jq -rs '
    [.[].Users[]? |
      ((.Attributes // [])[] | select(.Name == "email") | .Value) // "no-email-\(.Username)"
    ] | unique | length
  ' "$@"
}

get_runtime_log_group() {
  local profile=$1
  local runtime_name=$2
  local runtime_id
  local log_group

  runtime_id=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" --profile "$profile" \
    --query "agentRuntimes[?agentRuntimeName=='${runtime_name}'] | sort_by(@, &lastUpdatedAt)[-1].agentRuntimeId" \
    --output text 2>/dev/null || true)

  if is_valid_value "$runtime_id"; then
    log_group="/aws/bedrock-agentcore/runtimes/${runtime_id}-DEFAULT"
    if aws logs describe-log-groups --log-group-name-prefix "$log_group" \
      --region "$REGION" --profile "$profile" \
      --query "logGroups[?logGroupName=='${log_group}'].logGroupName | [0]" --output text 2>/dev/null | grep -q "$log_group"; then
      echo "$log_group"
      return
    fi
  fi

  aws logs describe-log-groups \
    --log-group-name-prefix "/aws/bedrock-agentcore/runtimes/${runtime_name}-" \
    --region "$REGION" --profile "$profile" \
    --query "logGroups[?ends_with(logGroupName, '-DEFAULT')].logGroupName | [0]" --output text 2>/dev/null || echo "None"
}

start_logs_query() {
  local profile=$1
  local log_group=$2
  local start_time=$3
  local end_time=$4
  local query_string=$5

  if ! is_valid_value "$log_group"; then
    echo ""
    return
  fi

  aws logs start-query \
    --log-group-name "$log_group" \
    --start-time "$start_time" --end-time "$end_time" \
    --query-string "$query_string" \
    --region "$REGION" --profile "$profile" --query 'queryId' --output text 2>/dev/null || true
}

write_query_results() {
  local profile=$1
  local query_id=$2
  local output_file=$3

  if is_valid_value "$query_id"; then
    aws logs get-query-results --query-id "$query_id" --region "$REGION" --profile "$profile" > "$output_file" 2>/dev/null || empty_query_results > "$output_file"
  else
    empty_query_results > "$output_file"
  fi
}

merge_session_results() {
  local output_file=$1
  shift
  jq -rs '
    [.[].results[]? |
      {
        hour: ((.[] | select(.field == "hour_utc") | .value) // ""),
        sessions: (((.[] | select(.field == "sessions") | .value) // "0") | tonumber)
      } |
      select(.hour != "")
    ] |
    group_by(.hour) |
    map([
      {"field": "hour_utc", "value": .[0].hour},
      {"field": "sessions", "value": (map(.sessions) | add | tostring)}
    ]) |
    {results: .}
  ' "$@" > "$output_file"
}

merge_request_results() {
  local output_file=$1
  shift
  jq -s '
    [.[].results[]? |
      {
        ts: ((.[] | select(.field == "ts") | .value) // ""),
        first_message: ((.[] | select(.field == "first_message") | .value) // "")
      } |
      select(.ts != "" and .first_message != "")
    ] |
    sort_by(.ts) | reverse | .[:20] |
    map([
      {"field": "first_message", "value": .first_message},
      {"field": "ts", "value": .ts}
    ]) |
    {results: .}
  ' "$@" > "$output_file"
}

sum_sessions_file() {
  local file=$1
  jq -r '[.results[]? | ((.[] | select(.field == "sessions") | .value) // "0" | tonumber)] | add // 0' "$file" 2>/dev/null
}

cost_total_by_service_file() {
  local file=$1
  jq -r '
    [.ResultsByTime[].Groups[]? |
      select(.Keys[0] | contains("Claude") or contains("Bedrock")) |
      .Metrics.UnblendedCost.Amount | tonumber
    ] | add // 0
  ' "$file" 2>/dev/null
}

cost_total_by_project_file() {
  local file=$1
  local project=$2
  jq -r --arg project "Project\$${project}" '
    [.ResultsByTime[].Groups[]? |
      select(.Keys[0] == $project and (.Keys[1] | contains("Claude") or contains("Bedrock"))) |
      .Metrics.UnblendedCost.Amount | tonumber
    ] | add // 0
  ' "$file" 2>/dev/null
}

model_cost_by_service_file() {
  local file=$1
  local model_pattern=$2
  jq -r --arg model_pattern "$model_pattern" '
    [.ResultsByTime[].Groups[]? |
      select(.Keys[0] | contains($model_pattern)) |
      .Metrics.UnblendedCost.Amount | tonumber
    ] | add // 0
  ' "$file" 2>/dev/null
}

model_cost_by_project_file() {
  local file=$1
  local project=$2
  local model_pattern=$3
  jq -r --arg project "Project\$${project}" --arg model_pattern "$model_pattern" '
    [.ResultsByTime[].Groups[]? |
      select(.Keys[0] == $project and (.Keys[1] | contains($model_pattern))) |
      .Metrics.UnblendedCost.Amount | tonumber
    ] | add // 0
  ' "$file" 2>/dev/null
}

other_cost_by_service_file() {
  local file=$1
  jq -r '
    [.ResultsByTime[].Groups[]? |
      select((.Keys[0] | contains("Bedrock") or contains("Claude")) and
        (.Keys[0] | contains("Claude Sonnet 4.6") | not) and
        (.Keys[0] | contains("Claude Opus") | not) and
        (.Keys[0] | contains("Kimi") | not)
      ) |
      .Metrics.UnblendedCost.Amount | tonumber
    ] | add // 0
  ' "$file" 2>/dev/null
}

other_cost_by_project_file() {
  local file=$1
  local project=$2
  jq -r --arg project "Project\$${project}" '
    [.ResultsByTime[].Groups[]? |
      select(.Keys[0] == $project and
        ((.Keys[1] | contains("Bedrock") or contains("Claude")) and
        (.Keys[1] | contains("Claude Sonnet 4.6") | not) and
        (.Keys[1] | contains("Claude Opus") | not) and
        (.Keys[1] | contains("Kimi") | not))
      ) |
      .Metrics.UnblendedCost.Amount | tonumber
    ] | add // 0
  ' "$file" 2>/dev/null
}

usage_cost_by_type_file() {
  local file=$1
  local usage_regex=$2
  jq -r --arg usage_regex "$usage_regex" '
    [.ResultsByTime[].Groups[]? |
      select(.Keys[0] | test($usage_regex)) |
      .Metrics.UnblendedCost.Amount | tonumber
    ] | add // 0
  ' "$file" 2>/dev/null
}

usage_input_cost_by_type_file() {
  local file=$1
  jq -r '
    [.ResultsByTime[].Groups[]? |
      select((.Keys[0] | test("InputToken")) and (.Keys[0] | test("Cache") | not)) |
      .Metrics.UnblendedCost.Amount | tonumber
    ] | add // 0
  ' "$file" 2>/dev/null
}

usage_cost_by_project_type_file() {
  local file=$1
  local project=$2
  local usage_regex=$3
  jq -r --arg project "Project\$${project}" --arg usage_regex "$usage_regex" '
    [.ResultsByTime[].Groups[]? |
      select(.Keys[0] == $project and (.Keys[1] | test($usage_regex))) |
      .Metrics.UnblendedCost.Amount | tonumber
    ] | add // 0
  ' "$file" 2>/dev/null
}

usage_input_cost_by_project_type_file() {
  local file=$1
  local project=$2
  jq -r --arg project "Project\$${project}" '
    [.ResultsByTime[].Groups[]? |
      select(.Keys[0] == $project and ((.Keys[1] | test("InputToken")) and (.Keys[1] | test("Cache") | not))) |
      .Metrics.UnblendedCost.Amount | tonumber
    ] | add // 0
  ' "$file" 2>/dev/null
}

allocate_cost() {
  local total_cost=${1:-0}
  local part_sessions=${2:-0}
  local total_sessions=${3:-0}
  if [ "$total_sessions" -gt 0 ] && [ "$part_sessions" -gt 0 ]; then
    echo "scale=10; $total_cost * $part_sessions / $total_sessions" | bc -l
  else
    echo "0"
  fi
}

# SSOセッション確認（切れていたら自動ログイン）
if ! aws sts get-caller-identity --profile "$PROFILE_OLD" > /dev/null 2>&1; then
  echo "🔑 $PROFILE_OLD のSSOセッションが無効です。ログインします..."
  aws sso login --profile "$PROFILE_OLD"
fi

KAG_AVAILABLE=true
if ! aws sts get-caller-identity --profile "$PROFILE_NEW" > /dev/null 2>&1; then
  echo "🔑 $PROFILE_NEW のSSOセッションが無効です。ログインします..."
  aws sso login --profile "$PROFILE_NEW" || true
  # ログイン後に再確認
  aws sts get-caller-identity --profile "$PROFILE_NEW" > /dev/null 2>&1 || KAG_AVAILABLE=false
  if [ "$KAG_AVAILABLE" = false ]; then
    echo "⚠️  $PROFILE_NEW のログインに失敗しました。移行後の main/kag データはスキップします。"
  fi
fi

# ========================================
# 1. リソースID取得
# ========================================
echo "🔍 リソースIDを取得中..."

# Amplify App ID取得（移行前/移行後）
APP_MAIN_OLD_ID=$(get_amplify_app_id "$PROFILE_OLD" "$APP_NAME_MAIN")
APP_MAIN_NEW_ID=""
APP_KAG_NEW_ID=""
if [ "$KAG_AVAILABLE" = true ]; then
  APP_MAIN_NEW_ID=$(get_amplify_app_id "$PROFILE_NEW" "$APP_NAME_MAIN")
  APP_KAG_NEW_ID=$(get_amplify_app_id "$PROFILE_NEW" "$APP_NAME_KAG")
fi

# Cognito User Pool ID取得
POOL_MAIN_OLD=$(get_user_pool_from_app "$PROFILE_OLD" "$APP_MAIN_OLD_ID" "main")
if ! is_valid_value "$POOL_MAIN_OLD"; then
  POOL_MAIN_OLD=$(get_user_pool_by_name_contains "$PROFILE_OLD" "marp-main")
fi

POOL_MAIN_NEW=""
POOL_KAG_NEW=""
if [ "$KAG_AVAILABLE" = true ]; then
  POOL_MAIN_NEW=$(get_user_pool_from_app "$PROFILE_NEW" "$APP_MAIN_NEW_ID" "main")
  POOL_KAG_NEW=$(get_user_pool_from_app "$PROFILE_NEW" "$APP_KAG_NEW_ID" "main")
fi

# 旧KAG環境のCognito Pool ID（sandbox内）
POOL_KAG_OLD=$(get_user_pool_by_name_contains "$PROFILE_OLD" "kag")

# AgentCore ロググループ名取得
LOG_MAIN_OLD=$(get_runtime_log_group "$PROFILE_OLD" "$RUNTIME_MAIN_OLD")
LOG_DEV=$(get_runtime_log_group "$PROFILE_OLD" "$RUNTIME_DEV_OLD")
LOG_KAG_OLD=$(get_runtime_log_group "$PROFILE_OLD" "$RUNTIME_KAG_OLD")

LOG_MAIN_NEW="None"
LOG_KAG_NEW="None"
if [ "$KAG_AVAILABLE" = true ]; then
  LOG_MAIN_NEW=$(get_runtime_log_group "$PROFILE_NEW" "$RUNTIME_MAIN_NEW")
  LOG_KAG_NEW=$(get_runtime_log_group "$PROFILE_NEW" "$RUNTIME_KAG_NEW")
fi

# ========================================
# 2. Cognitoユーザー数取得（前回値との比較用キャッシュ付き）
# ========================================
echo "👥 Cognitoユーザー数を取得中..."
echo "👤 Cognitoユーザー一覧を取得中..."

write_users_json "$PROFILE_OLD" "$POOL_MAIN_OLD" "$OUTPUT_DIR/main_old_users.json"
write_users_json "$PROFILE_NEW" "$POOL_MAIN_NEW" "$OUTPUT_DIR/main_new_users.json"
write_users_json "$PROFILE_OLD" "$POOL_KAG_OLD" "$OUTPUT_DIR/kag_old_users.json"
write_users_json "$PROFILE_NEW" "$POOL_KAG_NEW" "$OUTPUT_DIR/kag_users.json"

# 新旧ユーザーをメールで重複除外してユニーク数を算出
USERS_MAIN_OLD_ACTUAL=$(jq '.Users | length' "$OUTPUT_DIR/main_old_users.json")
USERS_MAIN_NEW_ACTUAL=$(jq '.Users | length' "$OUTPUT_DIR/main_new_users.json")
USERS_MAIN_UNIQUE=$(unique_user_count "$OUTPUT_DIR/main_old_users.json" "$OUTPUT_DIR/main_new_users.json")
USERS_MAIN_OVERLAP=$((USERS_MAIN_OLD_ACTUAL + USERS_MAIN_NEW_ACTUAL - USERS_MAIN_UNIQUE))

USERS_KAG_OLD_ACTUAL=$(jq '.Users | length' "$OUTPUT_DIR/kag_old_users.json")
USERS_KAG_NEW_ACTUAL=$(jq '.Users | length' "$OUTPUT_DIR/kag_users.json")
USERS_KAG_UNIQUE=$(unique_user_count "$OUTPUT_DIR/kag_old_users.json" "$OUTPUT_DIR/kag_users.json")
USERS_KAG_OVERLAP=$((USERS_KAG_OLD_ACTUAL + USERS_KAG_NEW_ACTUAL - USERS_KAG_UNIQUE))

# 前回値を読み込み（キャッシュファイルがあれば）
CACHE_FILE="$OUTPUT_DIR/cognito_cache.json"
PREV_MAIN=0
PREV_KAG=0
PREV_DATE=""
if [ -f "$CACHE_FILE" ]; then
  PREV_MAIN=$(jq -r '.main // 0' "$CACHE_FILE")
  PREV_KAG=$(jq -r '.kag // 0' "$CACHE_FILE")
  PREV_DATE=$(jq -r '.date // ""' "$CACHE_FILE")
fi

# 増加数を計算（main/kagとも新旧ユニーク数で比較）
DIFF_MAIN=$((USERS_MAIN_UNIQUE - PREV_MAIN))
DIFF_KAG=$((USERS_KAG_UNIQUE - PREV_KAG))

# 現在の値をキャッシュに保存（main/kagともユニーク数）
TODAY=$(TZ=Asia/Tokyo date +%Y-%m-%d)
echo "{\"main\": $USERS_MAIN_UNIQUE, \"kag\": $USERS_KAG_UNIQUE, \"date\": \"$TODAY\"}" > "$CACHE_FILE"

# ========================================
# 3. CloudWatch Logsクエリを並列開始
# ========================================
echo "📈 CloudWatch Logsクエリを並列開始..."
START_7D=$(date -v-7d +%s)
START_24H=$(date -v-24H +%s)
START_28D=$(date -v-28d +%s)  # 週次トレンド用（4週間）
END_NOW=$(date +%s)

# OTELログからsession.idをparseしてユニークカウント（UTCで集計）
OTEL_QUERY='parse @message /"session\.id":\s*"(?<sid>[^"]+)"/ | filter ispresent(sid)'

# セッション集計クエリ: 二段階statsでセッションの初回出現時刻を基準に集計（重複カウント防止）
SESSION_QUERY="$OTEL_QUERY | stats min(@timestamp) as first_seen by sid | stats count(*) as sessions by datefloor(first_seen, 1h) as hour_utc | sort hour_utc asc"

# 日次クエリ開始（移行前/移行後を環境ごとに後段で合算）
Q_DAILY_MAIN_OLD=$(start_logs_query "$PROFILE_OLD" "$LOG_MAIN_OLD" "$START_7D" "$END_NOW" "$SESSION_QUERY")
Q_DAILY_MAIN_NEW=$(start_logs_query "$PROFILE_NEW" "$LOG_MAIN_NEW" "$START_7D" "$END_NOW" "$SESSION_QUERY")
Q_DAILY_KAG_OLD=$(start_logs_query "$PROFILE_OLD" "$LOG_KAG_OLD" "$START_7D" "$END_NOW" "$SESSION_QUERY")
Q_DAILY_KAG_NEW=$(start_logs_query "$PROFILE_NEW" "$LOG_KAG_NEW" "$START_7D" "$END_NOW" "$SESSION_QUERY")
Q_DAILY_DEV=$(start_logs_query "$PROFILE_OLD" "$LOG_DEV" "$START_7D" "$END_NOW" "$SESSION_QUERY")

# 時間別クエリ開始（main/kag/dev並列）
Q_HOURLY_MAIN_OLD=$(start_logs_query "$PROFILE_OLD" "$LOG_MAIN_OLD" "$START_24H" "$END_NOW" "$SESSION_QUERY")
Q_HOURLY_MAIN_NEW=$(start_logs_query "$PROFILE_NEW" "$LOG_MAIN_NEW" "$START_24H" "$END_NOW" "$SESSION_QUERY")
Q_HOURLY_KAG_OLD=$(start_logs_query "$PROFILE_OLD" "$LOG_KAG_OLD" "$START_24H" "$END_NOW" "$SESSION_QUERY")
Q_HOURLY_KAG_NEW=$(start_logs_query "$PROFILE_NEW" "$LOG_KAG_NEW" "$START_24H" "$END_NOW" "$SESSION_QUERY")
Q_HOURLY_DEV=$(start_logs_query "$PROFILE_OLD" "$LOG_DEV" "$START_24H" "$END_NOW" "$SESSION_QUERY")

# 週次クエリ開始（過去4週間）
Q_WEEKLY_MAIN_OLD=$(start_logs_query "$PROFILE_OLD" "$LOG_MAIN_OLD" "$START_28D" "$END_NOW" "$SESSION_QUERY")
Q_WEEKLY_MAIN_NEW=$(start_logs_query "$PROFILE_NEW" "$LOG_MAIN_NEW" "$START_28D" "$END_NOW" "$SESSION_QUERY")
Q_WEEKLY_KAG_OLD=$(start_logs_query "$PROFILE_OLD" "$LOG_KAG_OLD" "$START_28D" "$END_NOW" "$SESSION_QUERY")
Q_WEEKLY_KAG_NEW=$(start_logs_query "$PROFILE_NEW" "$LOG_KAG_NEW" "$START_28D" "$END_NOW" "$SESSION_QUERY")

# ユーザー依頼内容クエリ開始（過去7日間）
USER_REQ_QUERY='parse @message /"session\.id":\s*"(?<sid>[^"]+)"/ | parse @message /"input":.*?\\"text\\":\s*\\"(?<user_msg>[^\\"]{1,200})/ | filter ispresent(sid) and ispresent(user_msg) | stats earliest(user_msg) as first_message, min(@timestamp) as ts by sid | sort ts desc | limit 20'

Q_REQUESTS_MAIN_OLD=$(start_logs_query "$PROFILE_OLD" "$LOG_MAIN_OLD" "$START_7D" "$END_NOW" "$USER_REQ_QUERY")
Q_REQUESTS_MAIN_NEW=$(start_logs_query "$PROFILE_NEW" "$LOG_MAIN_NEW" "$START_7D" "$END_NOW" "$USER_REQ_QUERY")
Q_REQUESTS_KAG_OLD=$(start_logs_query "$PROFILE_OLD" "$LOG_KAG_OLD" "$START_7D" "$END_NOW" "$USER_REQ_QUERY")
Q_REQUESTS_KAG_NEW=$(start_logs_query "$PROFILE_NEW" "$LOG_KAG_NEW" "$START_7D" "$END_NOW" "$USER_REQ_QUERY")

# ========================================
# 4. Bedrockコスト取得（クエリ待機中に並列実行）
# ========================================
echo "💰 Bedrockコストを取得中..."

# sandbox アカウント（移行前 main/kag/dev）のコスト（クレジット適用前）
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-7d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics "UnblendedCost" \
  --filter '{"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}}' \
  --group-by Type=DIMENSION,Key=SERVICE \
  --region $REGION --profile $PROFILE_MAIN \
  --output json > "$OUTPUT_DIR/cost.json"

# kag-sandbox アカウントのタグ別コスト（クレジット適用前）
if [ "$KAG_AVAILABLE" = true ]; then
  aws ce get-cost-and-usage \
    --time-period Start=$(date -v-7d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
    --granularity DAILY \
    --metrics "UnblendedCost" \
    --filter '{"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}}' \
    --group-by Type=TAG,Key=Project Type=DIMENSION,Key=SERVICE \
    --region $REGION --profile $PROFILE_KAG \
    --output json > "$OUTPUT_DIR/cost_kag.json"
else
  empty_cost_results > "$OUTPUT_DIR/cost_kag.json"
fi

# Claude Sonnet 4.6の使用タイプ別コスト（キャッシュ効果分析用）- sandbox
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-7d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics "UnblendedCost" \
  --filter '{
    "And": [
      {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}},
      {"Dimensions": {"Key": "SERVICE", "Values": ["Claude Sonnet 4.6 (Amazon Bedrock Edition)"]}}
    ]
  }' \
  --group-by Type=DIMENSION,Key=USAGE_TYPE \
  --region $REGION --profile $PROFILE_MAIN \
  --output json > "$OUTPUT_DIR/sonnet_usage.json"

# Claude Sonnet 4.6 - kag-sandbox（Projectタグ別）
if [ "$KAG_AVAILABLE" = true ]; then
  aws ce get-cost-and-usage \
    --time-period Start=$(date -v-7d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
    --granularity DAILY \
    --metrics "UnblendedCost" \
    --filter '{
      "And": [
        {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}},
        {"Dimensions": {"Key": "SERVICE", "Values": ["Claude Sonnet 4.6 (Amazon Bedrock Edition)"]}}
      ]
    }' \
    --group-by Type=TAG,Key=Project Type=DIMENSION,Key=USAGE_TYPE \
    --region $REGION --profile $PROFILE_KAG \
    --output json > "$OUTPUT_DIR/sonnet_usage_kag.json"
else
  empty_cost_results > "$OUTPUT_DIR/sonnet_usage_kag.json"
fi

# Claude Opus 4.6の使用タイプ別コスト - sandbox
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-7d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics "UnblendedCost" \
  --filter '{
    "And": [
      {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}},
      {"Dimensions": {"Key": "SERVICE", "Values": ["Claude Opus 4.6 (Amazon Bedrock Edition)"]}}
    ]
  }' \
  --group-by Type=DIMENSION,Key=USAGE_TYPE \
  --region $REGION --profile $PROFILE_MAIN \
  --output json > "$OUTPUT_DIR/opus_usage.json"

# Claude Opus 4.6 - kag-sandbox（Projectタグ別）
if [ "$KAG_AVAILABLE" = true ]; then
  aws ce get-cost-and-usage \
    --time-period Start=$(date -v-7d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
    --granularity DAILY \
    --metrics "UnblendedCost" \
    --filter '{
      "And": [
        {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}},
        {"Dimensions": {"Key": "SERVICE", "Values": ["Claude Opus 4.6 (Amazon Bedrock Edition)"]}}
      ]
    }' \
    --group-by Type=TAG,Key=Project Type=DIMENSION,Key=USAGE_TYPE \
    --region $REGION --profile $PROFILE_KAG \
    --output json > "$OUTPUT_DIR/opus_usage_kag.json"
else
  empty_cost_results > "$OUTPUT_DIR/opus_usage_kag.json"
fi

# 週次コスト取得（過去4週間）- sandbox
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-28d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics "UnblendedCost" \
  --filter '{"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}}' \
  --group-by Type=DIMENSION,Key=SERVICE \
  --region $REGION --profile $PROFILE_MAIN \
  --output json > "$OUTPUT_DIR/weekly_cost.json"

# 週次コスト - kag-sandbox（Projectタグ別）
if [ "$KAG_AVAILABLE" = true ]; then
  aws ce get-cost-and-usage \
    --time-period Start=$(date -v-28d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
    --granularity DAILY \
    --metrics "UnblendedCost" \
    --filter '{"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}}' \
    --group-by Type=TAG,Key=Project Type=DIMENSION,Key=SERVICE \
    --region $REGION --profile $PROFILE_KAG \
    --output json > "$OUTPUT_DIR/weekly_cost_kag.json"
else
  empty_cost_results > "$OUTPUT_DIR/weekly_cost_kag.json"
fi

# ========================================
# 4.5 Tavily API利用量取得
# ========================================
echo "🔍 Tavily API利用量を取得中..."

ENV_FILE="$PWD/.env"
TAVILY_KEYS=""
if [ -f "$ENV_FILE" ]; then
  TAVILY_KEYS=$(grep '^TAVILY_API_KEYS=' "$ENV_FILE" | cut -d'=' -f2)
fi

if [ -n "$TAVILY_KEYS" ]; then
  echo "$TAVILY_KEYS" | tr ',' '\n' > "$OUTPUT_DIR/tavily_keys.tmp"
  TAVILY_KEY_COUNT=0
  while IFS= read -r KEY; do
    [ -z "$KEY" ] && continue
    TAVILY_KEY_COUNT=$((TAVILY_KEY_COUNT + 1))
    curl -s --max-time 5 "https://api.tavily.com/usage" -H "Authorization: Bearer $KEY" \
      > "$OUTPUT_DIR/tavily_key${TAVILY_KEY_COUNT}.json" 2>/dev/null || echo '{}' > "$OUTPUT_DIR/tavily_key${TAVILY_KEY_COUNT}.json"
  done < "$OUTPUT_DIR/tavily_keys.tmp"
  rm -f "$OUTPUT_DIR/tavily_keys.tmp"
else
  TAVILY_KEY_COUNT=0
fi

# ========================================
# 5. クエリ結果取得（10秒待機後）
# ========================================
echo "⏳ クエリ完了を待機中..."
sleep 10

echo "📥 クエリ結果を取得中..."
write_query_results "$PROFILE_OLD" "$Q_DAILY_MAIN_OLD" "$OUTPUT_DIR/daily_main_old.json"
write_query_results "$PROFILE_NEW" "$Q_DAILY_MAIN_NEW" "$OUTPUT_DIR/daily_main_new.json"
write_query_results "$PROFILE_OLD" "$Q_DAILY_KAG_OLD" "$OUTPUT_DIR/daily_kag_old.json"
write_query_results "$PROFILE_NEW" "$Q_DAILY_KAG_NEW" "$OUTPUT_DIR/daily_kag_new.json"
write_query_results "$PROFILE_OLD" "$Q_DAILY_DEV" "$OUTPUT_DIR/daily_dev.json"

write_query_results "$PROFILE_OLD" "$Q_HOURLY_MAIN_OLD" "$OUTPUT_DIR/hourly_main_old.json"
write_query_results "$PROFILE_NEW" "$Q_HOURLY_MAIN_NEW" "$OUTPUT_DIR/hourly_main_new.json"
write_query_results "$PROFILE_OLD" "$Q_HOURLY_KAG_OLD" "$OUTPUT_DIR/hourly_kag_old.json"
write_query_results "$PROFILE_NEW" "$Q_HOURLY_KAG_NEW" "$OUTPUT_DIR/hourly_kag_new.json"
write_query_results "$PROFILE_OLD" "$Q_HOURLY_DEV" "$OUTPUT_DIR/hourly_dev.json"

write_query_results "$PROFILE_OLD" "$Q_WEEKLY_MAIN_OLD" "$OUTPUT_DIR/weekly_main_old.json"
write_query_results "$PROFILE_NEW" "$Q_WEEKLY_MAIN_NEW" "$OUTPUT_DIR/weekly_main_new.json"
write_query_results "$PROFILE_OLD" "$Q_WEEKLY_KAG_OLD" "$OUTPUT_DIR/weekly_kag_old.json"
write_query_results "$PROFILE_NEW" "$Q_WEEKLY_KAG_NEW" "$OUTPUT_DIR/weekly_kag_new.json"

write_query_results "$PROFILE_OLD" "$Q_REQUESTS_MAIN_OLD" "$OUTPUT_DIR/requests_main_old.json"
write_query_results "$PROFILE_NEW" "$Q_REQUESTS_MAIN_NEW" "$OUTPUT_DIR/requests_main_new.json"
write_query_results "$PROFILE_OLD" "$Q_REQUESTS_KAG_OLD" "$OUTPUT_DIR/requests_kag_old.json"
write_query_results "$PROFILE_NEW" "$Q_REQUESTS_KAG_NEW" "$OUTPUT_DIR/requests_kag_new.json"

merge_session_results "$OUTPUT_DIR/daily_main.json" "$OUTPUT_DIR/daily_main_old.json" "$OUTPUT_DIR/daily_main_new.json"
merge_session_results "$OUTPUT_DIR/hourly_main.json" "$OUTPUT_DIR/hourly_main_old.json" "$OUTPUT_DIR/hourly_main_new.json"
merge_session_results "$OUTPUT_DIR/weekly_main.json" "$OUTPUT_DIR/weekly_main_old.json" "$OUTPUT_DIR/weekly_main_new.json"

merge_session_results "$OUTPUT_DIR/daily_kag.json" "$OUTPUT_DIR/daily_kag_old.json" "$OUTPUT_DIR/daily_kag_new.json"
merge_session_results "$OUTPUT_DIR/hourly_kag.json" "$OUTPUT_DIR/hourly_kag_old.json" "$OUTPUT_DIR/hourly_kag_new.json"
merge_session_results "$OUTPUT_DIR/weekly_kag.json" "$OUTPUT_DIR/weekly_kag_old.json" "$OUTPUT_DIR/weekly_kag_new.json"

merge_request_results "$OUTPUT_DIR/requests_main.json" "$OUTPUT_DIR/requests_main_old.json" "$OUTPUT_DIR/requests_main_new.json"
merge_request_results "$OUTPUT_DIR/requests_kag.json" "$OUTPUT_DIR/requests_kag_old.json" "$OUTPUT_DIR/requests_kag_new.json"

TOTAL_MAIN_OLD=$(sum_sessions_file "$OUTPUT_DIR/daily_main_old.json")
TOTAL_MAIN_NEW=$(sum_sessions_file "$OUTPUT_DIR/daily_main_new.json")
TOTAL_KAG_OLD=$(sum_sessions_file "$OUTPUT_DIR/daily_kag_old.json")
TOTAL_KAG_NEW=$(sum_sessions_file "$OUTPUT_DIR/daily_kag_new.json")

# ========================================
# 6. 結果出力
# ========================================
echo ""
echo "=========================================="
echo "📊 MARP AGENT 利用状況レポート"
echo "=========================================="
echo ""

# ========================================
# 直近12時間のセッション数を表形式で表示
# ========================================
CURRENT_JST_HOUR=$(TZ=Asia/Tokyo date +%H)

# UTCの時刻をJSTに変換してマップを作成（直近12時間用）
declare -A MAIN_MAP_12H
declare -A KAG_MAP_12H
declare -A DEV_MAP_12H

# mainのデータをJST変換してマップに格納
while IFS= read -r line; do
  if [ -n "$line" ]; then
    UTC_HOUR=$(echo "$line" | cut -d'|' -f1)
    SESSIONS=$(echo "$line" | cut -d'|' -f2)
    JST_HOUR=$(( (10#$UTC_HOUR + 9) % 24 ))
    JST_HOUR_STR=$(printf "%02d" $JST_HOUR)
    MAIN_MAP_12H[$JST_HOUR_STR]=$((${MAIN_MAP_12H[$JST_HOUR_STR]:-0} + SESSIONS))
  fi
done < <(jq -r '.results[] |
  (.[] | select(.field == "hour_utc") | .value[11:13]) as $hour |
  (.[] | select(.field == "sessions") | .value) as $sessions |
  "\($hour)|\($sessions)"
' "$OUTPUT_DIR/hourly_main.json" 2>/dev/null)

# kagのデータをJST変換してマップに格納
while IFS= read -r line; do
  if [ -n "$line" ]; then
    UTC_HOUR=$(echo "$line" | cut -d'|' -f1)
    SESSIONS=$(echo "$line" | cut -d'|' -f2)
    JST_HOUR=$(( (10#$UTC_HOUR + 9) % 24 ))
    JST_HOUR_STR=$(printf "%02d" $JST_HOUR)
    KAG_MAP_12H[$JST_HOUR_STR]=$((${KAG_MAP_12H[$JST_HOUR_STR]:-0} + SESSIONS))
  fi
done < <(jq -r '.results[] |
  (.[] | select(.field == "hour_utc") | .value[11:13]) as $hour |
  (.[] | select(.field == "sessions") | .value) as $sessions |
  "\($hour)|\($sessions)"
' "$OUTPUT_DIR/hourly_kag.json" 2>/dev/null)

# devのデータをJST変換してマップに格納
while IFS= read -r line; do
  if [ -n "$line" ]; then
    UTC_HOUR=$(echo "$line" | cut -d'|' -f1)
    SESSIONS=$(echo "$line" | cut -d'|' -f2)
    JST_HOUR=$(( (10#$UTC_HOUR + 9) % 24 ))
    JST_HOUR_STR=$(printf "%02d" $JST_HOUR)
    DEV_MAP_12H[$JST_HOUR_STR]=$((${DEV_MAP_12H[$JST_HOUR_STR]:-0} + SESSIONS))
  fi
done < <(jq -r '.results[] |
  (.[] | select(.field == "hour_utc") | .value[11:13]) as $hour |
  (.[] | select(.field == "sessions") | .value) as $sessions |
  "\($hour)|\($sessions)"
' "$OUTPUT_DIR/hourly_dev.json" 2>/dev/null)

echo "🔥 直近12時間のセッション数（JST）"
echo ""
echo "  時刻   | main | kag  | dev  | 合計"
echo "  -------|------|------|------|------"

SUM_MAIN_12H=0
SUM_KAG_12H=0
SUM_DEV_12H=0

# 直近12時間を古い順に表示
for i in $(seq 11 -1 0); do
  HOUR=$(( (10#$CURRENT_JST_HOUR - i + 24) % 24 ))
  HOUR_STR=$(printf "%02d" $HOUR)

  MAIN_C=${MAIN_MAP_12H[$HOUR_STR]:-0}
  KAG_C=${KAG_MAP_12H[$HOUR_STR]:-0}
  DEV_C=${DEV_MAP_12H[$HOUR_STR]:-0}
  TOTAL_C=$((MAIN_C + KAG_C + DEV_C))

  SUM_MAIN_12H=$((SUM_MAIN_12H + MAIN_C))
  SUM_KAG_12H=$((SUM_KAG_12H + KAG_C))
  SUM_DEV_12H=$((SUM_DEV_12H + DEV_C))

  printf "  %s:00 | %4d | %4d | %4d | %4d\n" "$HOUR_STR" "$MAIN_C" "$KAG_C" "$DEV_C" "$TOTAL_C"
done

SUM_TOTAL_12H=$((SUM_MAIN_12H + SUM_KAG_12H + SUM_DEV_12H))
echo "  -------|------|------|------|------"
printf "  合計   | %4d | %4d | %4d | %4d\n" "$SUM_MAIN_12H" "$SUM_KAG_12H" "$SUM_DEV_12H" "$SUM_TOTAL_12H"
echo ""

echo "📝 直近のユーザー依頼内容（過去7日間）"
echo ""
echo "[main]"
MAIN_REQ_COUNT=$(jq '.results | length' "$OUTPUT_DIR/requests_main.json")
if [ "$MAIN_REQ_COUNT" -gt 0 ]; then
  echo "  日時(JST)      | 依頼内容"
  echo "  ---------------|--------------------------------------------------"
  jq -r '.results[] |
    (.[] | select(.field == "ts") | .value) as $ts |
    (.[] | select(.field == "first_message") | .value) as $msg |
    ($msg | if length > 50 then .[:50] + "..." else . end) as $truncated |
    "\($ts)\t\($truncated)"
  ' "$OUTPUT_DIR/requests_main.json" | while IFS=$'\t' read -r TS MSG; do
    UTC_TS=$(echo "$TS" | cut -c1-19)
    JST_TS=$(date -j -v+9H -f "%Y-%m-%d %H:%M:%S" "$UTC_TS" "+%m/%d %H:%M" 2>/dev/null || echo "$UTC_TS")
    printf "  %-14s | %s\n" "$JST_TS" "$MSG"
  done
else
  echo "  （依頼なし）"
fi
echo ""
echo "[kag]"
KAG_REQ_COUNT=$(jq '.results | length' "$OUTPUT_DIR/requests_kag.json")
if [ "$KAG_REQ_COUNT" -gt 0 ]; then
  echo "  日時(JST)      | 依頼内容"
  echo "  ---------------|--------------------------------------------------"
  jq -r '.results[] |
    (.[] | select(.field == "ts") | .value) as $ts |
    (.[] | select(.field == "first_message") | .value) as $msg |
    ($msg | if length > 50 then .[:50] + "..." else . end) as $truncated |
    "\($ts)\t\($truncated)"
  ' "$OUTPUT_DIR/requests_kag.json" | while IFS=$'\t' read -r TS MSG; do
    UTC_TS=$(echo "$TS" | cut -c1-19)
    JST_TS=$(date -j -v+9H -f "%Y-%m-%d %H:%M:%S" "$UTC_TS" "+%m/%d %H:%M" 2>/dev/null || echo "$UTC_TS")
    printf "  %-14s | %s\n" "$JST_TS" "$MSG"
  done
else
  echo "  （依頼なし）"
fi
echo ""

echo "👥 Cognitoユーザー数"
if [ -n "$PREV_DATE" ] && [ "$PREV_DATE" != "$TODAY" ]; then
  # 前回記録が別日の場合、増減を表示
  DIFF_MAIN_STR=""
  DIFF_KAG_STR=""
  DIFF_TOTAL=$((DIFF_MAIN + DIFF_KAG))
  if [ $DIFF_MAIN -gt 0 ]; then DIFF_MAIN_STR=" (+$DIFF_MAIN)"; elif [ $DIFF_MAIN -lt 0 ]; then DIFF_MAIN_STR=" ($DIFF_MAIN)"; fi
  if [ $DIFF_KAG -gt 0 ]; then DIFF_KAG_STR=" (+$DIFF_KAG)"; elif [ $DIFF_KAG -lt 0 ]; then DIFF_KAG_STR=" ($DIFF_KAG)"; fi
  DIFF_TOTAL_STR=""
  if [ $DIFF_TOTAL -gt 0 ]; then DIFF_TOTAL_STR=" (+$DIFF_TOTAL)"; elif [ $DIFF_TOTAL -lt 0 ]; then DIFF_TOTAL_STR=" ($DIFF_TOTAL)"; fi
  echo "  main: $USERS_MAIN_UNIQUE 人$DIFF_MAIN_STR（旧環境: ${USERS_MAIN_OLD_ACTUAL}人 / 新環境: ${USERS_MAIN_NEW_ACTUAL}人 / 重複: ${USERS_MAIN_OVERLAP}人）"
  echo "  kag:  $USERS_KAG_UNIQUE 人$DIFF_KAG_STR（旧環境: ${USERS_KAG_OLD_ACTUAL}人 / 新環境: ${USERS_KAG_NEW_ACTUAL}人 / 重複: ${USERS_KAG_OVERLAP}人）"
  echo "  合計: $((USERS_MAIN_UNIQUE + USERS_KAG_UNIQUE)) 人$DIFF_TOTAL_STR"
  echo "  （前回記録: $PREV_DATE）"
else
  # 初回または同日の場合は増減なし
  echo "  main: $USERS_MAIN_UNIQUE 人（旧環境: ${USERS_MAIN_OLD_ACTUAL}人 / 新環境: ${USERS_MAIN_NEW_ACTUAL}人 / 重複: ${USERS_MAIN_OVERLAP}人）"
  echo "  kag:  $USERS_KAG_UNIQUE 人（旧環境: ${USERS_KAG_OLD_ACTUAL}人 / 新環境: ${USERS_KAG_NEW_ACTUAL}人 / 重複: ${USERS_KAG_OVERLAP}人）"
  echo "  合計: $((USERS_MAIN_UNIQUE + USERS_KAG_UNIQUE)) 人"
  if [ -z "$PREV_DATE" ]; then
    echo "  （初回記録 - 次回以降増減を表示）"
  fi
fi

# kag ユーザー一覧（新旧マージ、重複除外済み）
KAG_ALL_USER_COUNT=$((USERS_KAG_OLD_ACTUAL + USERS_KAG_NEW_ACTUAL))
if [ "$KAG_ALL_USER_COUNT" -gt 0 ]; then
  echo ""
  echo "  [kag ユーザー一覧（新旧マージ）]"
  jq -s '
    [
      (.[0].Users[] | {
        date: (.UserCreateDate | split("T")[0]),
        email: (((.Attributes // [])[] | select(.Name == "email") | .Value) // "email未設定"),
        env: "旧"
      }),
      (.[1].Users[] | {
        date: (.UserCreateDate | split("T")[0]),
        email: (((.Attributes // [])[] | select(.Name == "email") | .Value) // "email未設定"),
        env: "新"
      })
    ] | group_by(.email) |
    map({
      email: .[0].email,
      date: ([.[].date] | max),
      envs: [.[].env] | unique | join("+")
    }) |
    sort_by(.date) | reverse |
    .[] | "  \(.date): \(.email) [\(.envs)]"
  ' "$OUTPUT_DIR/kag_old_users.json" "$OUTPUT_DIR/kag_users.json" 2>/dev/null | head -15
fi
echo ""

echo "📈 日次セッション数（過去7日間・JST）"

# UTC時間別データをJST日別に変換する共通処理
_utc_hourly_to_jst_daily() {
  local file=$1
  jq -r '.results[] |
    (.[] | select(.field == "hour_utc") | .value) as $hour |
    (.[] | select(.field == "sessions") | .value) as $sessions |
    "\($hour)|\($sessions)"
  ' "$file" 2>/dev/null | while IFS='|' read -r HOUR_UTC SESSIONS; do
    if [ -n "$HOUR_UTC" ] && [ -n "$SESSIONS" ]; then
      local UTC_DATE=${HOUR_UTC:0:10}
      local UTC_H=${HOUR_UTC:11:2}
      local JST_H=$((10#$UTC_H + 9))
      if [ $JST_H -ge 24 ]; then
        echo "$(date -j -v+1d -f "%Y-%m-%d" "$UTC_DATE" "+%Y-%m-%d" 2>/dev/null)|$SESSIONS"
      else
        echo "$UTC_DATE|$SESSIONS"
      fi
    fi
  done
}

# main: JST日別セッション数を集計
declare -A JST_DAILY_MAIN
while IFS='|' read -r JST_DATE SESSIONS; do
  JST_DAILY_MAIN[$JST_DATE]=$((${JST_DAILY_MAIN[$JST_DATE]:-0} + SESSIONS))
done < <(_utc_hourly_to_jst_daily "$OUTPUT_DIR/daily_main.json")

echo "[main]"
TOTAL_MAIN=0
for DATE in $(echo "${!JST_DAILY_MAIN[@]}" | tr ' ' '\n' | sort); do
  echo "  $DATE: ${JST_DAILY_MAIN[$DATE]} 回"
  TOTAL_MAIN=$((TOTAL_MAIN + ${JST_DAILY_MAIN[$DATE]}))
done
[ $TOTAL_MAIN -eq 0 ] && echo "  （セッションなし）"
echo "  合計: $TOTAL_MAIN 回"
echo "  （内訳: 旧環境 ${TOTAL_MAIN_OLD} 回 / 新環境 ${TOTAL_MAIN_NEW} 回）"
echo ""

# kag: JST日別セッション数を集計
declare -A JST_DAILY_KAG
while IFS='|' read -r JST_DATE SESSIONS; do
  JST_DAILY_KAG[$JST_DATE]=$((${JST_DAILY_KAG[$JST_DATE]:-0} + SESSIONS))
done < <(_utc_hourly_to_jst_daily "$OUTPUT_DIR/daily_kag.json")

echo "[kag]"
TOTAL_KAG=0
for DATE in $(echo "${!JST_DAILY_KAG[@]}" | tr ' ' '\n' | sort); do
  echo "  $DATE: ${JST_DAILY_KAG[$DATE]} 回"
  TOTAL_KAG=$((TOTAL_KAG + ${JST_DAILY_KAG[$DATE]}))
done
[ $TOTAL_KAG -eq 0 ] && echo "  （セッションなし）"
echo "  合計: $TOTAL_KAG 回"
echo "  （内訳: 旧環境 ${TOTAL_KAG_OLD} 回 / 新環境 ${TOTAL_KAG_NEW} 回）"
echo ""

# dev: JST日別セッション数を集計
declare -A JST_DAILY_DEV
while IFS='|' read -r JST_DATE SESSIONS; do
  JST_DAILY_DEV[$JST_DATE]=$((${JST_DAILY_DEV[$JST_DATE]:-0} + SESSIONS))
done < <(_utc_hourly_to_jst_daily "$OUTPUT_DIR/daily_dev.json")

echo "[dev]"
TOTAL_DEV=0
for DATE in $(echo "${!JST_DAILY_DEV[@]}" | tr ' ' '\n' | sort); do
  echo "  $DATE: ${JST_DAILY_DEV[$DATE]} 回"
  TOTAL_DEV=$((TOTAL_DEV + ${JST_DAILY_DEV[$DATE]}))
done
[ $TOTAL_DEV -eq 0 ] && echo "  （セッションなし）"
echo "  合計: $TOTAL_DEV 回"
echo ""

echo "⏰ 時間別セッション数（直近24時間・JST）"
echo ""
echo "        [main]              [kag]               [dev]"
echo "  時刻  |  グラフ     | 回数 |  グラフ     | 回数 |  グラフ     | 回数"
echo "  ------|-------------|------|-------------|------|-------------|------"

# UTCの時刻をJSTに変換してマップを作成
declare -A MAIN_MAP
declare -A KAG_MAP
declare -A DEV_MAP

# mainのデータをJST変換してマップに格納
while IFS= read -r line; do
  if [ -n "$line" ]; then
    UTC_HOUR=$(echo "$line" | cut -d'|' -f1)
    SESSIONS=$(echo "$line" | cut -d'|' -f2)
    JST_HOUR=$(( (10#$UTC_HOUR + 9) % 24 ))
    JST_HOUR_STR=$(printf "%02d" $JST_HOUR)
    MAIN_MAP[$JST_HOUR_STR]=$((${MAIN_MAP[$JST_HOUR_STR]:-0} + SESSIONS))
  fi
done < <(jq -r '.results[] |
  (.[] | select(.field == "hour_utc") | .value[11:13]) as $hour |
  (.[] | select(.field == "sessions") | .value) as $sessions |
  "\($hour)|\($sessions)"
' "$OUTPUT_DIR/hourly_main.json" 2>/dev/null)

# kagのデータをJST変換してマップに格納
while IFS= read -r line; do
  if [ -n "$line" ]; then
    UTC_HOUR=$(echo "$line" | cut -d'|' -f1)
    SESSIONS=$(echo "$line" | cut -d'|' -f2)
    JST_HOUR=$(( (10#$UTC_HOUR + 9) % 24 ))
    JST_HOUR_STR=$(printf "%02d" $JST_HOUR)
    KAG_MAP[$JST_HOUR_STR]=$((${KAG_MAP[$JST_HOUR_STR]:-0} + SESSIONS))
  fi
done < <(jq -r '.results[] |
  (.[] | select(.field == "hour_utc") | .value[11:13]) as $hour |
  (.[] | select(.field == "sessions") | .value) as $sessions |
  "\($hour)|\($sessions)"
' "$OUTPUT_DIR/hourly_kag.json" 2>/dev/null)

# devのデータをJST変換してマップに格納
while IFS= read -r line; do
  if [ -n "$line" ]; then
    UTC_HOUR=$(echo "$line" | cut -d'|' -f1)
    SESSIONS=$(echo "$line" | cut -d'|' -f2)
    JST_HOUR=$(( (10#$UTC_HOUR + 9) % 24 ))
    JST_HOUR_STR=$(printf "%02d" $JST_HOUR)
    DEV_MAP[$JST_HOUR_STR]=$((${DEV_MAP[$JST_HOUR_STR]:-0} + SESSIONS))
  fi
done < <(jq -r '.results[] |
  (.[] | select(.field == "hour_utc") | .value[11:13]) as $hour |
  (.[] | select(.field == "sessions") | .value) as $sessions |
  "\($hour)|\($sessions)"
' "$OUTPUT_DIR/hourly_dev.json" 2>/dev/null)

# 現在時刻（JST）から24時間分を古い順に表示
CURRENT_HOUR=$(TZ=Asia/Tokyo date +%H)
for i in $(seq 23 -1 0); do
  HOUR=$(( (10#$CURRENT_HOUR - i + 24) % 24 ))
  HOUR_STR=$(printf "%02d" $HOUR)

  # mainのカウント取得
  MAIN_COUNT=${MAIN_MAP[$HOUR_STR]:-0}
  MAIN_BARS=$(( MAIN_COUNT / 2 ))
  [ $MAIN_BARS -gt 10 ] && MAIN_BARS=10
  if [ $MAIN_BARS -gt 0 ]; then
    MAIN_BAR=$(printf '█%.0s' $(seq 1 $MAIN_BARS))
  else
    MAIN_BAR=""
  fi

  # kagのカウント取得
  KAG_COUNT=${KAG_MAP[$HOUR_STR]:-0}
  KAG_BARS=$(( KAG_COUNT / 2 ))
  [ $KAG_BARS -gt 10 ] && KAG_BARS=10
  if [ $KAG_BARS -gt 0 ]; then
    KAG_BAR=$(printf '█%.0s' $(seq 1 $KAG_BARS))
  else
    KAG_BAR=""
  fi

  # devのカウント取得
  DEV_COUNT=${DEV_MAP[$HOUR_STR]:-0}
  DEV_BARS=$(( DEV_COUNT / 2 ))
  [ $DEV_BARS -gt 10 ] && DEV_BARS=10
  if [ $DEV_BARS -gt 0 ]; then
    DEV_BAR=$(printf '█%.0s' $(seq 1 $DEV_BARS))
  else
    DEV_BAR=""
  fi

  printf "  %s:00 | %-11s | %4d | %-11s | %4d | %-11s | %4d\n" "$HOUR_STR" "$MAIN_BAR" "$MAIN_COUNT" "$KAG_BAR" "$KAG_COUNT" "$DEV_BAR" "$DEV_COUNT"
done
echo ""

# UTC時間別データをUTC日別に再集計する共通処理（Cost Explorerと整合）
_utc_hourly_to_utc_daily() {
  local file=$1
  jq -r '.results[]? |
    (.[] | select(.field == "hour_utc") | .value) as $hour |
    (.[] | select(.field == "sessions") | .value) as $sessions |
    "\($hour | split(" ")[0])|\($sessions)"
  ' "$file" 2>/dev/null
}

echo "💰 Bedrockコスト（過去7日間・日別・クレジット適用前）"
echo "  ※ 新環境のタグ付きインフラは Project タグ、タグが空のBedrockモデル料金は新main/kagのセッション比率で按分"
echo "  ※ 旧環境は旧アカウント内のセッション比率で按分"
echo ""
echo "  日付       | main   | kag    | dev    | 未配賦 | 合計"
echo "  -----------|--------|--------|--------|--------|--------"

declare -A DAILY_SESSIONS_MAIN_OLD_MAP
declare -A DAILY_SESSIONS_MAIN_NEW_MAP
declare -A DAILY_SESSIONS_KAG_OLD_MAP
declare -A DAILY_SESSIONS_KAG_NEW_MAP
declare -A DAILY_SESSIONS_DEV_MAP
declare -A DAILY_COST_MAIN_MAP
declare -A DAILY_COST_KAG_MAP
declare -A DAILY_COST_DEV_MAP
declare -A DAILY_COST_UNALLOCATED_MAP

while IFS='|' read -r DATE SESSIONS; do
  [ -n "$DATE" ] && DAILY_SESSIONS_MAIN_OLD_MAP[$DATE]=$((${DAILY_SESSIONS_MAIN_OLD_MAP[$DATE]:-0} + SESSIONS))
done < <(_utc_hourly_to_utc_daily "$OUTPUT_DIR/daily_main_old.json")

while IFS='|' read -r DATE SESSIONS; do
  [ -n "$DATE" ] && DAILY_SESSIONS_MAIN_NEW_MAP[$DATE]=$((${DAILY_SESSIONS_MAIN_NEW_MAP[$DATE]:-0} + SESSIONS))
done < <(_utc_hourly_to_utc_daily "$OUTPUT_DIR/daily_main_new.json")

while IFS='|' read -r DATE SESSIONS; do
  [ -n "$DATE" ] && DAILY_SESSIONS_KAG_OLD_MAP[$DATE]=$((${DAILY_SESSIONS_KAG_OLD_MAP[$DATE]:-0} + SESSIONS))
done < <(_utc_hourly_to_utc_daily "$OUTPUT_DIR/daily_kag_old.json")

while IFS='|' read -r DATE SESSIONS; do
  [ -n "$DATE" ] && DAILY_SESSIONS_KAG_NEW_MAP[$DATE]=$((${DAILY_SESSIONS_KAG_NEW_MAP[$DATE]:-0} + SESSIONS))
done < <(_utc_hourly_to_utc_daily "$OUTPUT_DIR/daily_kag_new.json")

while IFS='|' read -r DATE SESSIONS; do
  [ -n "$DATE" ] && DAILY_SESSIONS_DEV_MAP[$DATE]=$((${DAILY_SESSIONS_DEV_MAP[$DATE]:-0} + SESSIONS))
done < <(_utc_hourly_to_utc_daily "$OUTPUT_DIR/daily_dev.json")

# 旧 sandbox アカウントはProjectタグ未設定のため、旧環境セッション比率で配賦
while IFS='|' read -r DATE COST; do
  [ -z "$DATE" ] && continue
  S_MAIN_OLD=${DAILY_SESSIONS_MAIN_OLD_MAP[$DATE]:-0}
  S_KAG_OLD=${DAILY_SESSIONS_KAG_OLD_MAP[$DATE]:-0}
  S_DEV=${DAILY_SESSIONS_DEV_MAP[$DATE]:-0}
  S_OLD_TOTAL=$((S_MAIN_OLD + S_KAG_OLD + S_DEV))
  if [ "$S_OLD_TOTAL" -gt 0 ]; then
    DAILY_COST_MAIN_MAP[$DATE]=$(echo "${DAILY_COST_MAIN_MAP[$DATE]:-0} + $(allocate_cost "$COST" "$S_MAIN_OLD" "$S_OLD_TOTAL")" | bc -l)
    DAILY_COST_KAG_MAP[$DATE]=$(echo "${DAILY_COST_KAG_MAP[$DATE]:-0} + $(allocate_cost "$COST" "$S_KAG_OLD" "$S_OLD_TOTAL")" | bc -l)
    DAILY_COST_DEV_MAP[$DATE]=$(echo "${DAILY_COST_DEV_MAP[$DATE]:-0} + $(allocate_cost "$COST" "$S_DEV" "$S_OLD_TOTAL")" | bc -l)
  else
    DAILY_COST_UNALLOCATED_MAP[$DATE]=$(echo "${DAILY_COST_UNALLOCATED_MAP[$DATE]:-0} + $COST" | bc -l)
  fi
done < <(jq -r '
  .ResultsByTime[] |
  .TimePeriod.Start as $date |
  ([.Groups[]? | select(.Keys[0] | contains("Claude") or contains("Bedrock")) | .Metrics.UnblendedCost.Amount | tonumber] | add // 0) as $cost |
  "\($date)|\($cost)"
' "$OUTPUT_DIR/cost.json" 2>/dev/null)

# 新 kag-sandbox アカウントは Project タグで main/kag を直接集計
while IFS='|' read -r DATE COST; do
  [ -n "$DATE" ] && DAILY_COST_MAIN_MAP[$DATE]=$(echo "${DAILY_COST_MAIN_MAP[$DATE]:-0} + $COST" | bc -l)
done < <(jq -r --arg project "Project\$${MAIN_NEW_PROJECT_TAG}" '
  .ResultsByTime[] |
  .TimePeriod.Start as $date |
  ([.Groups[]? | select(.Keys[0] == $project and (.Keys[1] | contains("Claude") or contains("Bedrock"))) | .Metrics.UnblendedCost.Amount | tonumber] | add // 0) as $cost |
  "\($date)|\($cost)"
' "$OUTPUT_DIR/cost_kag.json" 2>/dev/null)

while IFS='|' read -r DATE COST; do
  [ -n "$DATE" ] && DAILY_COST_KAG_MAP[$DATE]=$(echo "${DAILY_COST_KAG_MAP[$DATE]:-0} + $COST" | bc -l)
done < <(jq -r --arg project "Project\$${KAG_NEW_PROJECT_TAG}" '
  .ResultsByTime[] |
  .TimePeriod.Start as $date |
  ([.Groups[]? | select(.Keys[0] == $project and (.Keys[1] | contains("Claude") or contains("Bedrock"))) | .Metrics.UnblendedCost.Amount | tonumber] | add // 0) as $cost |
  "\($date)|\($cost)"
' "$OUTPUT_DIR/cost_kag.json" 2>/dev/null)

# Bedrockモデル料金はProjectタグが空で出るため、新main/kagのセッション比率で配賦
while IFS='|' read -r DATE COST; do
  [ -z "$DATE" ] && continue
  S_MAIN_NEW=${DAILY_SESSIONS_MAIN_NEW_MAP[$DATE]:-0}
  S_KAG_NEW=${DAILY_SESSIONS_KAG_NEW_MAP[$DATE]:-0}
  S_NEW_TOTAL=$((S_MAIN_NEW + S_KAG_NEW))
  if [ "$S_NEW_TOTAL" -gt 0 ]; then
    DAILY_COST_MAIN_MAP[$DATE]=$(echo "${DAILY_COST_MAIN_MAP[$DATE]:-0} + $(allocate_cost "$COST" "$S_MAIN_NEW" "$S_NEW_TOTAL")" | bc -l)
    DAILY_COST_KAG_MAP[$DATE]=$(echo "${DAILY_COST_KAG_MAP[$DATE]:-0} + $(allocate_cost "$COST" "$S_KAG_NEW" "$S_NEW_TOTAL")" | bc -l)
  else
    DAILY_COST_UNALLOCATED_MAP[$DATE]=$(echo "${DAILY_COST_UNALLOCATED_MAP[$DATE]:-0} + $COST" | bc -l)
  fi
done < <(jq -r '
  .ResultsByTime[] |
  .TimePeriod.Start as $date |
  ([.Groups[]? | select(.Keys[0] == "Project$" and (.Keys[1] | contains("Claude") or contains("Bedrock"))) | .Metrics.UnblendedCost.Amount | tonumber] | add // 0) as $cost |
  "\($date)|\($cost)"
' "$OUTPUT_DIR/cost_kag.json" 2>/dev/null)

TOTAL_COST_MAIN=0
TOTAL_COST_KAG=0
TOTAL_COST_DEV=0
TOTAL_COST_UNALLOCATED=0

for DATE in $( (jq -r '.ResultsByTime[].TimePeriod.Start' "$OUTPUT_DIR/cost.json" 2>/dev/null; jq -r '.ResultsByTime[].TimePeriod.Start' "$OUTPUT_DIR/cost_kag.json" 2>/dev/null) | sort -u ); do
  C_MAIN=${DAILY_COST_MAIN_MAP[$DATE]:-0}
  C_KAG=${DAILY_COST_KAG_MAP[$DATE]:-0}
  C_DEV=${DAILY_COST_DEV_MAP[$DATE]:-0}
  C_UNALLOCATED=${DAILY_COST_UNALLOCATED_MAP[$DATE]:-0}
  C_TOTAL=$(echo "$C_MAIN + $C_KAG + $C_DEV + $C_UNALLOCATED" | bc -l)
  printf "  %s | $%6.2f | $%6.2f | $%6.2f | $%6.2f | $%6.2f\n" "$DATE" "$C_MAIN" "$C_KAG" "$C_DEV" "$C_UNALLOCATED" "$C_TOTAL"
  TOTAL_COST_MAIN=$(echo "$TOTAL_COST_MAIN + $C_MAIN" | bc -l)
  TOTAL_COST_KAG=$(echo "$TOTAL_COST_KAG + $C_KAG" | bc -l)
  TOTAL_COST_DEV=$(echo "$TOTAL_COST_DEV + $C_DEV" | bc -l)
  TOTAL_COST_UNALLOCATED=$(echo "$TOTAL_COST_UNALLOCATED + $C_UNALLOCATED" | bc -l)
done

TOTAL_COST=$(echo "$TOTAL_COST_MAIN + $TOTAL_COST_KAG + $TOTAL_COST_DEV + $TOTAL_COST_UNALLOCATED" | bc -l)
echo "  -----------|--------|--------|--------|--------|--------"
printf "  小計       | $%6.2f | $%6.2f | $%6.2f | $%6.2f | $%6.2f\n" "$TOTAL_COST_MAIN" "$TOTAL_COST_KAG" "$TOTAL_COST_DEV" "$TOTAL_COST_UNALLOCATED" "$TOTAL_COST"
echo ""

# ========================================
# 環境別 x モデル別コスト（実コスト）
# ========================================
echo "💰 Bedrockコスト内訳（過去7日間・クレジット適用前）"
echo ""

# 旧 sandbox は旧環境セッション比率で配賦、新 kag-sandbox はProjectタグで集計
SONNET_COST_SANDBOX=$(model_cost_by_service_file "$OUTPUT_DIR/cost.json" "Claude Sonnet 4.6")
OPUS_COST_SANDBOX=$(model_cost_by_service_file "$OUTPUT_DIR/cost.json" "Claude Opus")
KIMI_COST_SANDBOX=$(model_cost_by_service_file "$OUTPUT_DIR/cost.json" "Kimi")
OTHER_COST_SANDBOX=$(other_cost_by_service_file "$OUTPUT_DIR/cost.json")

OLD_ENV_SESSIONS=$((TOTAL_MAIN_OLD + TOTAL_KAG_OLD + TOTAL_DEV))

S_MAIN_OLD=$(allocate_cost "$SONNET_COST_SANDBOX" "$TOTAL_MAIN_OLD" "$OLD_ENV_SESSIONS")
S_KAG_OLD=$(allocate_cost "$SONNET_COST_SANDBOX" "$TOTAL_KAG_OLD" "$OLD_ENV_SESSIONS")
S_DEV_OLD=$(allocate_cost "$SONNET_COST_SANDBOX" "$TOTAL_DEV" "$OLD_ENV_SESSIONS")
O_MAIN_OLD=$(allocate_cost "$OPUS_COST_SANDBOX" "$TOTAL_MAIN_OLD" "$OLD_ENV_SESSIONS")
O_KAG_OLD=$(allocate_cost "$OPUS_COST_SANDBOX" "$TOTAL_KAG_OLD" "$OLD_ENV_SESSIONS")
O_DEV_OLD=$(allocate_cost "$OPUS_COST_SANDBOX" "$TOTAL_DEV" "$OLD_ENV_SESSIONS")
K_MAIN_OLD=$(allocate_cost "$KIMI_COST_SANDBOX" "$TOTAL_MAIN_OLD" "$OLD_ENV_SESSIONS")
K_KAG_OLD=$(allocate_cost "$KIMI_COST_SANDBOX" "$TOTAL_KAG_OLD" "$OLD_ENV_SESSIONS")
K_DEV_OLD=$(allocate_cost "$KIMI_COST_SANDBOX" "$TOTAL_DEV" "$OLD_ENV_SESSIONS")
OT_MAIN_OLD=$(allocate_cost "$OTHER_COST_SANDBOX" "$TOTAL_MAIN_OLD" "$OLD_ENV_SESSIONS")
OT_KAG_OLD=$(allocate_cost "$OTHER_COST_SANDBOX" "$TOTAL_KAG_OLD" "$OLD_ENV_SESSIONS")
OT_DEV_OLD=$(allocate_cost "$OTHER_COST_SANDBOX" "$TOTAL_DEV" "$OLD_ENV_SESSIONS")

if [ "$OLD_ENV_SESSIONS" -gt 0 ]; then
  S_UNALLOCATED="0"
  O_UNALLOCATED="0"
  K_UNALLOCATED="0"
  OT_UNALLOCATED="0"
else
  S_UNALLOCATED=$SONNET_COST_SANDBOX
  O_UNALLOCATED=$OPUS_COST_SANDBOX
  K_UNALLOCATED=$KIMI_COST_SANDBOX
  OT_UNALLOCATED=$OTHER_COST_SANDBOX
fi

NEW_ENV_SESSIONS=$((TOTAL_MAIN_NEW + TOTAL_KAG_NEW))

SONNET_COST_NEW_UNTAGGED=$(model_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "" "Claude Sonnet 4.6")
OPUS_COST_NEW_UNTAGGED=$(model_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "" "Claude Opus")
KIMI_COST_NEW_UNTAGGED=$(model_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "" "Kimi")
OTHER_COST_NEW_UNTAGGED=$(other_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "")

S_MAIN_NEW=$(echo "$(model_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "$MAIN_NEW_PROJECT_TAG" "Claude Sonnet 4.6") + $(allocate_cost "$SONNET_COST_NEW_UNTAGGED" "$TOTAL_MAIN_NEW" "$NEW_ENV_SESSIONS")" | bc -l)
S_KAG_NEW=$(echo "$(model_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "$KAG_NEW_PROJECT_TAG" "Claude Sonnet 4.6") + $(allocate_cost "$SONNET_COST_NEW_UNTAGGED" "$TOTAL_KAG_NEW" "$NEW_ENV_SESSIONS")" | bc -l)
O_MAIN_NEW=$(echo "$(model_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "$MAIN_NEW_PROJECT_TAG" "Claude Opus") + $(allocate_cost "$OPUS_COST_NEW_UNTAGGED" "$TOTAL_MAIN_NEW" "$NEW_ENV_SESSIONS")" | bc -l)
O_KAG_NEW=$(echo "$(model_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "$KAG_NEW_PROJECT_TAG" "Claude Opus") + $(allocate_cost "$OPUS_COST_NEW_UNTAGGED" "$TOTAL_KAG_NEW" "$NEW_ENV_SESSIONS")" | bc -l)
K_MAIN_NEW=$(echo "$(model_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "$MAIN_NEW_PROJECT_TAG" "Kimi") + $(allocate_cost "$KIMI_COST_NEW_UNTAGGED" "$TOTAL_MAIN_NEW" "$NEW_ENV_SESSIONS")" | bc -l)
K_KAG_NEW=$(echo "$(model_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "$KAG_NEW_PROJECT_TAG" "Kimi") + $(allocate_cost "$KIMI_COST_NEW_UNTAGGED" "$TOTAL_KAG_NEW" "$NEW_ENV_SESSIONS")" | bc -l)
OT_MAIN_NEW=$(other_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "$MAIN_NEW_PROJECT_TAG")
OT_KAG_NEW=$(other_cost_by_project_file "$OUTPUT_DIR/cost_kag.json" "$KAG_NEW_PROJECT_TAG")
OT_MAIN_NEW=$(echo "$OT_MAIN_NEW + $(allocate_cost "$OTHER_COST_NEW_UNTAGGED" "$TOTAL_MAIN_NEW" "$NEW_ENV_SESSIONS")" | bc -l)
OT_KAG_NEW=$(echo "$OT_KAG_NEW + $(allocate_cost "$OTHER_COST_NEW_UNTAGGED" "$TOTAL_KAG_NEW" "$NEW_ENV_SESSIONS")" | bc -l)

S_MAIN=$(printf "%.2f" "$(echo "$S_MAIN_OLD + $S_MAIN_NEW" | bc -l)")
S_KAG=$(printf "%.2f" "$(echo "$S_KAG_OLD + $S_KAG_NEW" | bc -l)")
S_DEV=$(printf "%.2f" "$S_DEV_OLD")
S_UNALLOCATED=$(printf "%.2f" "$S_UNALLOCATED")
O_MAIN=$(printf "%.2f" "$(echo "$O_MAIN_OLD + $O_MAIN_NEW" | bc -l)")
O_KAG=$(printf "%.2f" "$(echo "$O_KAG_OLD + $O_KAG_NEW" | bc -l)")
O_DEV=$(printf "%.2f" "$O_DEV_OLD")
O_UNALLOCATED=$(printf "%.2f" "$O_UNALLOCATED")
K_MAIN=$(printf "%.2f" "$(echo "$K_MAIN_OLD + $K_MAIN_NEW" | bc -l)")
K_KAG=$(printf "%.2f" "$(echo "$K_KAG_OLD + $K_KAG_NEW" | bc -l)")
K_DEV=$(printf "%.2f" "$K_DEV_OLD")
K_UNALLOCATED=$(printf "%.2f" "$K_UNALLOCATED")
OT_MAIN=$(printf "%.2f" "$(echo "$OT_MAIN_OLD + $OT_MAIN_NEW" | bc -l)")
OT_KAG=$(printf "%.2f" "$(echo "$OT_KAG_OLD + $OT_KAG_NEW" | bc -l)")
OT_DEV=$(printf "%.2f" "$OT_DEV_OLD")
OT_UNALLOCATED=$(printf "%.2f" "$OT_UNALLOCATED")

# 合計
S_TOTAL=$(printf "%.2f" "$(echo "$S_MAIN + $S_KAG + $S_DEV + $S_UNALLOCATED" | bc -l)")
O_TOTAL=$(printf "%.2f" "$(echo "$O_MAIN + $O_KAG + $O_DEV + $O_UNALLOCATED" | bc -l)")
K_TOTAL=$(printf "%.2f" "$(echo "$K_MAIN + $K_KAG + $K_DEV + $K_UNALLOCATED" | bc -l)")
OT_TOTAL=$(printf "%.2f" "$(echo "$OT_MAIN + $OT_KAG + $OT_DEV + $OT_UNALLOCATED" | bc -l)")
ENV_MAIN=$(printf "%.2f" "$TOTAL_COST_MAIN")
ENV_KAG=$(printf "%.2f" "$TOTAL_COST_KAG")
ENV_DEV=$(printf "%.2f" "$TOTAL_COST_DEV")
ENV_UNALLOCATED=$(printf "%.2f" "$TOTAL_COST_UNALLOCATED")
ENV_TOTAL=$(printf "%.2f" $(echo "$TOTAL_COST" | bc -l))

# 月間推定
M_MAIN=$(printf "%.0f" $(echo "$ENV_MAIN * 4" | bc -l))
M_KAG=$(printf "%.0f" $(echo "$ENV_KAG * 4" | bc -l))
M_DEV=$(printf "%.0f" $(echo "$ENV_DEV * 4" | bc -l))
M_UNALLOCATED=$(printf "%.0f" $(echo "$ENV_UNALLOCATED * 4" | bc -l))
M_TOTAL=$(printf "%.0f" $(echo "$ENV_TOTAL * 4" | bc -l))

echo "  ※ クレジット適用前の利用コスト（RECORD_TYPE=Usageでフィルタ）"
echo ""
printf "  %-16s | %8s | %8s | %8s | %8s | %8s\n" "モデル" "main" "kag" "dev" "未配賦" "合計"
printf "  %-16s-|----------|----------|----------|----------|----------\n" "----------------"
printf "  %-16s | %8s | %8s | %8s | %8s | %8s\n" "Sonnet 4.6" "\$$S_MAIN" "\$$S_KAG" "\$$S_DEV" "\$$S_UNALLOCATED" "\$$S_TOTAL"
printf "  %-16s | %8s | %8s | %8s | %8s | %8s\n" "Opus 4.6" "\$$O_MAIN" "\$$O_KAG" "\$$O_DEV" "\$$O_UNALLOCATED" "\$$O_TOTAL"
printf "  %-16s | %8s | %8s | %8s | %8s | %8s\n" "Kimi K2" "\$$K_MAIN" "\$$K_KAG" "\$$K_DEV" "\$$K_UNALLOCATED" "\$$K_TOTAL"
printf "  %-16s | %8s | %8s | %8s | %8s | %8s\n" "その他" "\$$OT_MAIN" "\$$OT_KAG" "\$$OT_DEV" "\$$OT_UNALLOCATED" "\$$OT_TOTAL"
printf "  %-16s-|----------|----------|----------|----------|----------\n" "----------------"
printf "  %-16s | %8s | %8s | %8s | %8s | %8s\n" "週間合計" "\$$ENV_MAIN" "\$$ENV_KAG" "\$$ENV_DEV" "\$$ENV_UNALLOCATED" "\$$ENV_TOTAL"
printf "  %-16s | %7s | %7s | %7s | %7s | %7s\n" "月間推定" "\$$M_MAIN" "\$$M_KAG" "\$$M_DEV" "\$$M_UNALLOCATED" "\$$M_TOTAL"
echo ""
echo "  ※ Kimi K2はクレジット適用で実質\$0"
echo ""

# ========================================
# 1セッションあたりのコスト分析
# ========================================
echo "💡 1セッションあたりのコスト（過去7日間・UTC基準）"
echo ""
echo "  日付       | main+dev | kag      | 全体"
echo "  -----------|----------|----------|----------"

declare -A DAILY_SESSIONS_MAIN_CPS_MAP
declare -A DAILY_SESSIONS_KAG_CPS_MAP
declare -A DAILY_SESSIONS_DEV_CPS_MAP

while IFS='|' read -r DATE SESSIONS; do
  [ -n "$DATE" ] && DAILY_SESSIONS_MAIN_CPS_MAP[$DATE]=$((${DAILY_SESSIONS_MAIN_CPS_MAP[$DATE]:-0} + SESSIONS))
done < <(_utc_hourly_to_utc_daily "$OUTPUT_DIR/daily_main.json")

while IFS='|' read -r DATE SESSIONS; do
  [ -n "$DATE" ] && DAILY_SESSIONS_DEV_CPS_MAP[$DATE]=$((${DAILY_SESSIONS_DEV_CPS_MAP[$DATE]:-0} + SESSIONS))
done < <(_utc_hourly_to_utc_daily "$OUTPUT_DIR/daily_dev.json")

while IFS='|' read -r DATE SESSIONS; do
  [ -n "$DATE" ] && DAILY_SESSIONS_KAG_CPS_MAP[$DATE]=$((${DAILY_SESSIONS_KAG_CPS_MAP[$DATE]:-0} + SESSIONS))
done < <(_utc_hourly_to_utc_daily "$OUTPUT_DIR/daily_kag.json")

# 日別セッション単価表示
CPS_SUM_COST_SB=0
CPS_SUM_COST_KG=0
CPS_SUM_SESS_SB=0
CPS_SUM_SESS_KG=0

for DATE in $( (jq -r '.ResultsByTime[].TimePeriod.Start' "$OUTPUT_DIR/cost.json" 2>/dev/null; jq -r '.ResultsByTime[].TimePeriod.Start' "$OUTPUT_DIR/cost_kag.json" 2>/dev/null) | sort -u ); do
  S_SB=$((${DAILY_SESSIONS_MAIN_CPS_MAP[$DATE]:-0} + ${DAILY_SESSIONS_DEV_CPS_MAP[$DATE]:-0}))
  S_KG=${DAILY_SESSIONS_KAG_CPS_MAP[$DATE]:-0}
  C_SB=$(echo "${DAILY_COST_MAIN_MAP[$DATE]:-0} + ${DAILY_COST_DEV_MAP[$DATE]:-0}" | bc -l)
  C_KG=${DAILY_COST_KAG_MAP[$DATE]:-0}
  S_ALL=$((S_SB + S_KG))
  C_ALL=$(echo "$C_SB + $C_KG" | bc -l)

  if [ "$S_SB" -gt 0 ]; then
    CPS_SB=$(printf "%.2f" $(echo "scale=4; $C_SB / $S_SB" | bc))
  else
    CPS_SB="-"
  fi
  if [ "$S_KG" -gt 0 ]; then
    CPS_KG=$(printf "%.2f" $(echo "scale=4; $C_KG / $S_KG" | bc))
  else
    CPS_KG="-"
  fi
  if [ "$S_ALL" -gt 0 ]; then
    CPS_ALL=$(printf "%.2f" $(echo "scale=4; $C_ALL / $S_ALL" | bc))
  else
    CPS_ALL="-"
  fi

  printf "  %s | \$%-6s | \$%-6s | \$%-6s\n" "$DATE" "$CPS_SB" "$CPS_KG" "$CPS_ALL"

  CPS_SUM_COST_SB=$(echo "$CPS_SUM_COST_SB + $C_SB" | bc)
  CPS_SUM_COST_KG=$(echo "$CPS_SUM_COST_KG + $C_KG" | bc)
  CPS_SUM_SESS_SB=$((CPS_SUM_SESS_SB + S_SB))
  CPS_SUM_SESS_KG=$((CPS_SUM_SESS_KG + S_KG))
done

echo "  -----------|----------|----------|----------"

CPS_SUM_SESS_ALL=$((CPS_SUM_SESS_SB + CPS_SUM_SESS_KG))
CPS_SUM_COST_ALL=$(echo "$CPS_SUM_COST_SB + $CPS_SUM_COST_KG" | bc)
if [ "$CPS_SUM_SESS_SB" -gt 0 ]; then
  AVG_SB=$(printf "%.2f" $(echo "scale=4; $CPS_SUM_COST_SB / $CPS_SUM_SESS_SB" | bc))
else
  AVG_SB="-"
fi
if [ "$CPS_SUM_SESS_KG" -gt 0 ]; then
  AVG_KG=$(printf "%.2f" $(echo "scale=4; $CPS_SUM_COST_KG / $CPS_SUM_SESS_KG" | bc))
else
  AVG_KG="-"
fi
if [ "$CPS_SUM_SESS_ALL" -gt 0 ]; then
  AVG_ALL=$(printf "%.2f" $(echo "scale=4; $CPS_SUM_COST_ALL / $CPS_SUM_SESS_ALL" | bc))
else
  AVG_ALL="-"
fi
printf "  平均       | \$%-6s | \$%-6s | \$%-6s\n" "$AVG_SB" "$AVG_KG" "$AVG_ALL"
echo ""
echo "  ※ 施策前参考値: \$0.58/回"
echo "  ※ 未配賦コストは単価計算から除外"
echo ""

# ========================================
# Claudeモデル キャッシュ効果（両アカウント合算）
# ========================================

# --- Sonnet 4.6 ---
echo "📊 Claude Sonnet 4.6 キャッシュ効果"

S_INPUT_COST=$(echo \
  "$(usage_input_cost_by_type_file "$OUTPUT_DIR/sonnet_usage.json")" \
  "+ $(usage_input_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "")" \
  "+ $(usage_input_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "$MAIN_NEW_PROJECT_TAG")" \
  "+ $(usage_input_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "$KAG_NEW_PROJECT_TAG")" \
  | bc)
S_OUTPUT_COST=$(echo \
  "$(usage_cost_by_type_file "$OUTPUT_DIR/sonnet_usage.json" "OutputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "" "OutputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "$MAIN_NEW_PROJECT_TAG" "OutputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "$KAG_NEW_PROJECT_TAG" "OutputToken")" \
  | bc)
S_CACHE_READ_COST=$(echo \
  "$(usage_cost_by_type_file "$OUTPUT_DIR/sonnet_usage.json" "CacheReadInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "" "CacheReadInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "$MAIN_NEW_PROJECT_TAG" "CacheReadInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "$KAG_NEW_PROJECT_TAG" "CacheReadInputToken")" \
  | bc)
S_CACHE_WRITE_COST=$(echo \
  "$(usage_cost_by_type_file "$OUTPUT_DIR/sonnet_usage.json" "CacheWriteInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "" "CacheWriteInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "$MAIN_NEW_PROJECT_TAG" "CacheWriteInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/sonnet_usage_kag.json" "$KAG_NEW_PROJECT_TAG" "CacheWriteInputToken")" \
  | bc)

printf "  通常Input:   \$%.2f\n" $S_INPUT_COST
printf "  Output:      \$%.2f\n" $S_OUTPUT_COST
printf "  CacheRead:   \$%.2f\n" $S_CACHE_READ_COST
printf "  CacheWrite:  \$%.2f\n" $S_CACHE_WRITE_COST

# Sonnet キャッシュヒット率計算（Input: $3/1M, CacheRead: $0.30/1M）
if (( $(echo "$S_INPUT_COST > 0 || $S_CACHE_READ_COST > 0" | bc -l) )); then
  S_INPUT_TOKENS=$(echo "scale=0; $S_INPUT_COST / 0.000003" | bc)
  S_CACHE_READ_TOKENS=$(echo "scale=0; $S_CACHE_READ_COST / 0.0000003" | bc)
  S_TOTAL_INPUT_TOKENS=$(echo "$S_INPUT_TOKENS + $S_CACHE_READ_TOKENS" | bc)
  if [ "$S_TOTAL_INPUT_TOKENS" != "0" ]; then
    S_CACHE_HIT_RATE=$(echo "scale=1; $S_CACHE_READ_TOKENS * 100 / $S_TOTAL_INPUT_TOKENS" | bc)
    echo "  📈 キャッシュヒット率: ${S_CACHE_HIT_RATE}%"
    S_WOULD_HAVE_COST=$(echo "scale=2; $S_CACHE_READ_TOKENS * 0.000003" | bc)
    S_SAVINGS=$(echo "scale=2; $S_WOULD_HAVE_COST - $S_CACHE_READ_COST" | bc)
    S_NET_SAVINGS=$(echo "scale=2; $S_SAVINGS - $S_CACHE_WRITE_COST" | bc)
    printf "  💰 キャッシュ節約額: \$%.2f（CacheWrite考慮後: \$%.2f）\n" $S_SAVINGS $S_NET_SAVINGS
  fi
fi
echo ""

# --- Opus 4.6 ---
O_INPUT_COST2=$(echo \
  "$(usage_input_cost_by_type_file "$OUTPUT_DIR/opus_usage.json")" \
  "+ $(usage_input_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "")" \
  "+ $(usage_input_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "$MAIN_NEW_PROJECT_TAG")" \
  "+ $(usage_input_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "$KAG_NEW_PROJECT_TAG")" \
  | bc)
O_OUTPUT_COST2=$(echo \
  "$(usage_cost_by_type_file "$OUTPUT_DIR/opus_usage.json" "OutputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "" "OutputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "$MAIN_NEW_PROJECT_TAG" "OutputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "$KAG_NEW_PROJECT_TAG" "OutputToken")" \
  | bc)
O_CACHE_READ_COST2=$(echo \
  "$(usage_cost_by_type_file "$OUTPUT_DIR/opus_usage.json" "CacheReadInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "" "CacheReadInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "$MAIN_NEW_PROJECT_TAG" "CacheReadInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "$KAG_NEW_PROJECT_TAG" "CacheReadInputToken")" \
  | bc)
O_CACHE_WRITE_COST2=$(echo \
  "$(usage_cost_by_type_file "$OUTPUT_DIR/opus_usage.json" "CacheWriteInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "" "CacheWriteInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "$MAIN_NEW_PROJECT_TAG" "CacheWriteInputToken")" \
  "+ $(usage_cost_by_project_type_file "$OUTPUT_DIR/opus_usage_kag.json" "$KAG_NEW_PROJECT_TAG" "CacheWriteInputToken")" \
  | bc)
O_TOTAL2=$(echo "$O_INPUT_COST2 + $O_OUTPUT_COST2 + $O_CACHE_READ_COST2 + $O_CACHE_WRITE_COST2" | bc)

if (( $(echo "$O_TOTAL2 > 0" | bc -l) )); then
  echo "📊 Claude Opus 4.6 キャッシュ効果"
  printf "  通常Input:   \$%.2f\n" $O_INPUT_COST2
  printf "  Output:      \$%.2f\n" $O_OUTPUT_COST2
  printf "  CacheRead:   \$%.2f\n" $O_CACHE_READ_COST2
  printf "  CacheWrite:  \$%.2f\n" $O_CACHE_WRITE_COST2

  # Opus キャッシュヒット率計算（Input: $15/1M, CacheRead: $1.50/1M）
  if (( $(echo "$O_INPUT_COST2 > 0 || $O_CACHE_READ_COST2 > 0" | bc -l) )); then
    O_INPUT_TOKENS=$(echo "scale=0; $O_INPUT_COST2 / 0.000015" | bc)
    O_CACHE_READ_TOKENS=$(echo "scale=0; $O_CACHE_READ_COST2 / 0.0000015" | bc)
    O_TOTAL_INPUT_TOKENS=$(echo "$O_INPUT_TOKENS + $O_CACHE_READ_TOKENS" | bc)
    if [ "$O_TOTAL_INPUT_TOKENS" != "0" ]; then
      O_CACHE_HIT_RATE=$(echo "scale=1; $O_CACHE_READ_TOKENS * 100 / $O_TOTAL_INPUT_TOKENS" | bc)
      echo "  📈 キャッシュヒット率: ${O_CACHE_HIT_RATE}%"
      O_WOULD_HAVE_COST=$(echo "scale=2; $O_CACHE_READ_TOKENS * 0.000015" | bc)
      O_SAVINGS=$(echo "scale=2; $O_WOULD_HAVE_COST - $O_CACHE_READ_COST2" | bc)
      O_NET_SAVINGS=$(echo "scale=2; $O_SAVINGS - $O_CACHE_WRITE_COST2" | bc)
      printf "  💰 キャッシュ節約額: \$%.2f（CacheWrite考慮後: \$%.2f）\n" $O_SAVINGS $O_NET_SAVINGS
    fi
  fi
  echo ""
fi

# ========================================
# 週次トレンド（v0.1リリース以降）
# ========================================
echo "📅 週次トレンド（リリース以降）"
echo ""

# UTC時間別データをJST日別に変換してから週番号を付けてファイルに保存
_utc_hourly_to_jst_daily "$OUTPUT_DIR/weekly_main.json" | while IFS='|' read -r JST_DATE SESSIONS; do
  if [ -n "$JST_DATE" ]; then
    WEEK=$(date -j -f "%Y-%m-%d" "$JST_DATE" "+%Y-W%W" 2>/dev/null)
    echo "$WEEK|main|$SESSIONS"
  fi
done > "$OUTPUT_DIR/weekly_sessions.tmp"

_utc_hourly_to_jst_daily "$OUTPUT_DIR/weekly_kag.json" | while IFS='|' read -r JST_DATE SESSIONS; do
  if [ -n "$JST_DATE" ]; then
    WEEK=$(date -j -f "%Y-%m-%d" "$JST_DATE" "+%Y-W%W" 2>/dev/null)
    echo "$WEEK|kag|$SESSIONS"
  fi
done >> "$OUTPUT_DIR/weekly_sessions.tmp"

# sandbox アカウントのコスト
jq -r '
  .ResultsByTime[] |
  .TimePeriod.Start as $date |
  ([.Groups[] | select(.Keys[0] | contains("Claude") or contains("Bedrock")) | .Metrics.UnblendedCost.Amount | tonumber] | add // 0) as $cost |
  "\($date)|\($cost)"
' "$OUTPUT_DIR/weekly_cost.json" 2>/dev/null | while read line; do
  DATE=$(echo "$line" | cut -d'|' -f1)
  COST=$(echo "$line" | cut -d'|' -f2)
  WEEK=$(date -j -f "%Y-%m-%d" "$DATE" "+%Y-W%W" 2>/dev/null)
  echo "$WEEK|cost|$COST"
done >> "$OUTPUT_DIR/weekly_sessions.tmp"

# kag-sandbox アカウントのコスト（タグ付きpawapo分 + タグ空のBedrockモデル料金）
jq -r --arg main_project "Project\$${MAIN_NEW_PROJECT_TAG}" --arg kag_project "Project\$${KAG_NEW_PROJECT_TAG}" '
  .ResultsByTime[] |
  .TimePeriod.Start as $date |
  ([.Groups[]? |
    select((.Keys[0] == $main_project or .Keys[0] == $kag_project or .Keys[0] == "Project$") and
      (.Keys[1] | contains("Claude") or contains("Bedrock"))
    ) |
    .Metrics.UnblendedCost.Amount | tonumber
  ] | add // 0) as $cost |
  "\($date)|\($cost)"
' "$OUTPUT_DIR/weekly_cost_kag.json" 2>/dev/null | while read line; do
  DATE=$(echo "$line" | cut -d'|' -f1)
  COST=$(echo "$line" | cut -d'|' -f2)
  WEEK=$(date -j -f "%Y-%m-%d" "$DATE" "+%Y-W%W" 2>/dev/null)
  echo "$WEEK|cost|$COST"
done >> "$OUTPUT_DIR/weekly_sessions.tmp"

echo "  週        | main | kag  | 合計 |  コスト"
echo "  ----------|------|------|------|--------"

# 週ごとに集計して表示
cat "$OUTPUT_DIR/weekly_sessions.tmp" | cut -d'|' -f1 | sort -u | while read WEEK; do
  if [ -n "$WEEK" ]; then
    W_MAIN=$(grep "^$WEEK|main|" "$OUTPUT_DIR/weekly_sessions.tmp" | cut -d'|' -f3 | tr '\n' '+' | sed 's/+$/\n/' | bc 2>/dev/null || echo 0)
    W_MAIN=${W_MAIN:-0}
    W_KAG=$(grep "^$WEEK|kag|" "$OUTPUT_DIR/weekly_sessions.tmp" | cut -d'|' -f3 | tr '\n' '+' | sed 's/+$/\n/' | bc 2>/dev/null || echo 0)
    W_KAG=${W_KAG:-0}
    W_COST=$(grep "^$WEEK|cost|" "$OUTPUT_DIR/weekly_sessions.tmp" | cut -d'|' -f3 | tr '\n' '+' | sed 's/+$/\n/' | bc 2>/dev/null || echo 0)
    W_COST=$(printf "%.0f" ${W_COST:-0})
    W_TOTAL=$((W_MAIN + W_KAG))
    printf "  %-9s | %4d | %4d | %4d | \$%s\n" "$WEEK" "$W_MAIN" "$W_KAG" "$W_TOTAL" "$W_COST"
  fi
done

rm -f "$OUTPUT_DIR/weekly_sessions.tmp"
echo ""

# ========================================
# Tavily API 利用状況
# ========================================
if [ "$TAVILY_KEY_COUNT" -gt 0 ]; then
  echo "🔍 Tavily API 利用状況"
  echo "  ※ 使用量・残量はアカウント全体ベース（キー単体ではなく紐づくアカウントの消費量）"
  echo ""
  echo "  キー  | キー使用量 | acct使用量 | acct上限 | 残り   | 状態"
  echo "  ------|------------|------------|----------|--------|------"

  TAVILY_TOTAL_USED=0
  TAVILY_TOTAL_LIMIT=0

  for i in $(seq 1 $TAVILY_KEY_COUNT); do
    FILE="$OUTPUT_DIR/tavily_key${i}.json"
    if [ -f "$FILE" ] && [ -s "$FILE" ]; then
      KEY_USED=$(jq -r '.key.usage // 0' "$FILE" 2>/dev/null)
      ACCT_USED=$(jq -r '.account.plan_usage // 0' "$FILE" 2>/dev/null)
      LIMIT=$(jq -r '.account.plan_limit // 0' "$FILE" 2>/dev/null)
      [ "$KEY_USED" = "null" ] && KEY_USED=0
      [ "$ACCT_USED" = "null" ] && ACCT_USED=0
      [ "$LIMIT" = "null" ] && LIMIT=1000
      REMAINING=$((LIMIT - ACCT_USED))
      [ $REMAINING -lt 0 ] && REMAINING=0

      if [ $REMAINING -le 0 ]; then
        STATUS="枯渇"
      elif [ $REMAINING -le 100 ]; then
        STATUS="残少"
      else
        STATUS="OK"
      fi

      printf "  KEY%-2d | %10d | %10d | %8d | %6d | %s\n" "$i" "$KEY_USED" "$ACCT_USED" "$LIMIT" "$REMAINING" "$STATUS"

      TAVILY_TOTAL_USED=$((TAVILY_TOTAL_USED + ACCT_USED))
      TAVILY_TOTAL_LIMIT=$((TAVILY_TOTAL_LIMIT + LIMIT))
    fi
  done

  TAVILY_TOTAL_REMAINING=$((TAVILY_TOTAL_LIMIT - TAVILY_TOTAL_USED))
  [ $TAVILY_TOTAL_REMAINING -lt 0 ] && TAVILY_TOTAL_REMAINING=0
  echo "  ------|------------|------------|----------|--------|------"
  printf "  合計  |            | %10d | %8d | %6d |\n" "$TAVILY_TOTAL_USED" "$TAVILY_TOTAL_LIMIT" "$TAVILY_TOTAL_REMAINING"

  # 日平均消費の推定（全体セッション数から逆算: セッション≒検索回数）
  TOTAL_SESSIONS_ALL=$((TOTAL_MAIN + TOTAL_KAG + TOTAL_DEV))
  if [ "$TOTAL_SESSIONS_ALL" -gt 0 ]; then
    DAYS_WITH_DATA=$(jq '.ResultsByTime | length' "$OUTPUT_DIR/cost.json")
    [ "$DAYS_WITH_DATA" -lt 1 ] && DAYS_WITH_DATA=1
    DAILY_CREDITS=$(echo "scale=0; $TOTAL_SESSIONS_ALL / $DAYS_WITH_DATA" | bc)
    [ "$DAILY_CREDITS" -lt 1 ] && DAILY_CREDITS=1
  else
    DAILY_CREDITS=53  # フォールバック値（最適化後実測値）
  fi

  if [ $TAVILY_TOTAL_REMAINING -gt 0 ] && [ "$DAILY_CREDITS" -gt 0 ]; then
    DAYS_LEFT=$((TAVILY_TOTAL_REMAINING / DAILY_CREDITS))
    EXHAUST_DATE=$(date -v+${DAYS_LEFT}d +%Y-%m-%d)
    echo ""
    echo "  日平均消費: ${DAILY_CREDITS}クレジット/日（直近7日間のセッション数ベース）"
    echo "  枯渇予測: 約${DAYS_LEFT}日後（${EXHAUST_DATE}頃）"
  elif [ $TAVILY_TOTAL_REMAINING -le 0 ]; then
    echo ""
    echo "  ⚠️  全キーが枯渇しています"
  fi
  echo ""

  # ========================================
  # Tavily 日次消費トラッキング（CSV記録）
  # ========================================
  TAVILY_CSV="$OUTPUT_DIR/tavily_daily.csv"

  # CSVヘッダーがなければ作成
  if [ ! -f "$TAVILY_CSV" ]; then
    echo "date,total_used,total_limit,total_remaining,key_usages" > "$TAVILY_CSV"
  fi

  # 本日のエントリが既にあるか確認（同日2回目以降は上書き）
  # KEY_USAGES はキー単体の使用量を記録（CSV参照用に残す）
  KEY_USAGES=""
  for i in $(seq 1 $TAVILY_KEY_COUNT); do
    FILE="$OUTPUT_DIR/tavily_key${i}.json"
    KEY_USED=$(jq -r '.key.usage // 0' "$FILE" 2>/dev/null)
    [ "$KEY_USED" = "null" ] && KEY_USED=0
    if [ -z "$KEY_USAGES" ]; then
      KEY_USAGES="$KEY_USED"
    else
      KEY_USAGES="$KEY_USAGES|$KEY_USED"
    fi
  done

  # 同日エントリを削除してから追記（上書き）
  if grep -q "^$TODAY," "$TAVILY_CSV" 2>/dev/null; then
    grep -v "^$TODAY," "$TAVILY_CSV" > "$TAVILY_CSV.tmp"
    mv "$TAVILY_CSV.tmp" "$TAVILY_CSV"
  fi
  echo "$TODAY,$TAVILY_TOTAL_USED,$TAVILY_TOTAL_LIMIT,$TAVILY_TOTAL_REMAINING,$KEY_USAGES" >> "$TAVILY_CSV"

  # 消費推移の表示（過去の記録があれば）
  CSV_LINES=$(tail -n +2 "$TAVILY_CSV" | wc -l | tr -d ' ')
  if [ "$CSV_LINES" -gt 1 ]; then
    echo "📉 Tavily 日次消費推移"
    echo ""
    echo "  日付       | 消費合計 | 残り   | 日次消費 | キー別使用量"
    echo "  -----------|----------|--------|----------|-------------"

    PREV_USED=""
    while IFS=',' read -r DATE USED LIMIT REMAINING KEY_DETAIL; do
      if [ -n "$PREV_USED" ]; then
        DAILY_DIFF=$((USED - PREV_USED))
        # 月初リセット検出（消費が大幅に減少した場合）
        if [ $DAILY_DIFF -lt 0 ]; then
          DAILY_DIFF_STR="(リセット)"
        else
          DAILY_DIFF_STR="$DAILY_DIFF"
        fi
      else
        DAILY_DIFF_STR="-"
      fi
      printf "  %s | %6d | %6d | %8s | %s\n" "$DATE" "$USED" "$REMAINING" "$DAILY_DIFF_STR" "$KEY_DETAIL"
      PREV_USED=$USED
    done < <(tail -n +2 "$TAVILY_CSV" | sort)

    # 月間必要キー数の推定
    echo ""
    # 記録日数が2日以上あれば日平均を算出
    FIRST_DATE=$(tail -n +2 "$TAVILY_CSV" | sort | head -1 | cut -d',' -f1)
    LAST_DATE=$(tail -n +2 "$TAVILY_CSV" | sort | tail -1 | cut -d',' -f1)
    FIRST_USED=$(tail -n +2 "$TAVILY_CSV" | sort | head -1 | cut -d',' -f2)
    LAST_USED=$(tail -n +2 "$TAVILY_CSV" | sort | tail -1 | cut -d',' -f2)
    DAYS_SPAN=$(( ( $(date -j -f "%Y-%m-%d" "$LAST_DATE" +%s) - $(date -j -f "%Y-%m-%d" "$FIRST_DATE" +%s) ) / 86400 ))

    if [ "$DAYS_SPAN" -gt 0 ]; then
      TOTAL_CONSUMED=$((LAST_USED - FIRST_USED))
      # リセットが含まれている場合はスキップ
      if [ $TOTAL_CONSUMED -ge 0 ]; then
        AVG_DAILY=$(echo "scale=1; $TOTAL_CONSUMED / $DAYS_SPAN" | bc)
        MONTHLY_EST=$(echo "scale=0; $AVG_DAILY * 30" | bc)
        KEYS_NEEDED=$(echo "scale=0; ($MONTHLY_EST + 999) / 1000" | bc)
        echo "  📊 必要キー数の推定（記録期間: ${DAYS_SPAN}日間）"
        echo "  日平均消費: ${AVG_DAILY}クレジット/日"
        echo "  月間推定: ${MONTHLY_EST}クレジット/月"
        echo "  必要キー数: ${KEYS_NEEDED}個（月1,000クレジット/キー × リセット毎月1日）"
      fi
    fi
    echo ""
  fi
fi

echo "✅ 完了！"
