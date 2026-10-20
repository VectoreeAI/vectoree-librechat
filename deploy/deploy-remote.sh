#!/usr/bin/env bash
# 服务器上拉 GitLab 镜像并重启 compose。不在服务器上构建，也不删数据卷。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.deploy.yml}"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  if [[ ! -f deploy/env.example ]]; then
    echo "Missing .env"
    exit 1
  fi
  cp deploy/env.example .env
  chmod 600 .env
  echo "[remote] Created .env from deploy/env.example"
fi

read_dotenv() {
  local key="$1"
  local line value
  line="$(grep -E "^[[:space:]]*${key}=" .env | tail -n 1 || true)"
  [[ -z "$line" ]] && return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\"(.*)\"$ ]]; then
    value="${BASH_REMATCH[1]}"
  elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

upsert_env() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  if [[ -f .env ]]; then
    grep -vE "^[[:space:]]*${key}=" .env >"$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  mv "$tmp" .env
  chmod 600 .env
}

ensure_secret() {
  local key="$1" bytes="$2" current value
  current="$(read_dotenv "$key")"
  if [[ -n "$current" ]]; then
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    value="$(openssl rand -hex "$bytes")"
  else
    value="$(python3 -c 'import secrets,sys; print(secrets.token_hex(int(sys.argv[1])))' "$bytes")"
  fi
  upsert_env "$key" "$value"
}

if [[ -n "${LIBRECHAT_IMAGE:-}" ]]; then
  upsert_env LIBRECHAT_IMAGE "$LIBRECHAT_IMAGE"
fi
if [[ -n "${VECTOREE_API_URL:-}" ]]; then
  upsert_env VECTOREE_API_URL "$VECTOREE_API_URL"
fi
if [[ -n "${DEPLOY_MODE:-}" ]]; then
  upsert_env DEPLOY_MODE "$DEPLOY_MODE"
fi

ensure_secret JWT_SECRET 32
ensure_secret JWT_REFRESH_SECRET 32
ensure_secret CREDS_KEY 32
ensure_secret CREDS_IV 16

# The image runs as uid 1000. A root-owned mode 600 mount is visible but not readable.
if [[ "$(id -u)" -eq 0 ]]; then
  chown 1000:1000 .env
  if [[ -f librechat.example.yaml ]]; then
    chown 1000:1000 librechat.example.yaml
    chmod 644 librechat.example.yaml
  fi
fi
chmod 600 .env

if [[ -z "$(read_dotenv LIBRECHAT_IMAGE)" ]]; then
  echo "Set LIBRECHAT_IMAGE in .env"
  exit 1
fi

COMPOSE_BIN=()
setup_compose() {
  export DOCKER_CLI_PLUGIN_EXTRA_DIRS="${DOCKER_CLI_PLUGIN_EXTRA_DIRS:-/usr/libexec/docker/cli-plugins:/usr/lib/docker/cli-plugins}"
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_BIN=(docker compose)
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_BIN=(docker-compose)
    return
  fi
  echo "[remote] ERROR: Docker Compose is not installed."
  exit 1
}
dc() {
  "${COMPOSE_BIN[@]}" -f "$COMPOSE_FILE" "$@"
}

setup_compose
echo "[remote] Using: ${COMPOSE_BIN[*]}"

for svc in mongodb api; do
  attempt=1
  max=5
  while true; do
    echo "[remote] Pull ${svc} (${attempt}/${max})..."
    if dc pull "$svc"; then
      break
    fi
    if [[ "$attempt" -ge "$max" ]]; then
      echo "[remote] ERROR: pull ${svc} failed after ${max} attempts"
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 15
  done
done

echo "[remote] Starting stack..."
dc up -d --remove-orphans --no-build

port="$(read_dotenv LIBRECHAT_PORT)"
port="${port:-5175}"
echo "[remote] Waiting for http://127.0.0.1:${port}/health ..."
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "[remote] OK — http://127.0.0.1:${port}/health"
    exit 0
  fi
  sleep 5
done

echo "[remote] Health check failed:"
dc logs --tail=80 api mongodb || true
exit 1
