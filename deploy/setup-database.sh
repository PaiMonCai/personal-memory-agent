#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
BASELINE_SQL="$ROOT_DIR/database/001_baseline.sql"
REPAIR_SQL="$ROOT_DIR/database/repair_ownership.sql"
GENERATED_COMPOSE="$ROOT_DIR/.pma-db-compose.yml"
APP_NETWORK="pma-app-link"
DB_LINK_NETWORK="pma-db-link"
POSTGRES_CLIENT_IMAGE="postgres:16-alpine"

log() { printf '\033[1;34m[PMA DB]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[PMA DB]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[PMA DB]\033[0m %s\n' "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"; }

as_root() {
  if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die "该操作需要 root 权限，请使用 sudo 重新运行脚本。"
  fi
}

prompt_default() {
  local prompt="$1" default="$2" value
  read -r -p "$prompt [$default]: " value
  printf '%s' "${value:-$default}"
}

prompt_secret() {
  local prompt="$1" value
  read -r -s -p "$prompt: " value
  printf '\n' >&2
  printf '%s' "$value"
}

validate_ident() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "数据库名/用户名仅支持字母、数字、下划线，且不能以数字开头：$1"
}

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then return; fi
  [[ -f "$ENV_EXAMPLE" ]] || die "找不到 $ENV_EXAMPLE"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  log "已从 .env.example 创建 .env"
}

set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v key="$key" 'index($0, key "=") != 1 { print }' "$ENV_FILE" > "$tmp"
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

generate_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

list_postgres_containers() {
  docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}' | awk 'BEGIN{IGNORECASE=1} $2 ~ /postgres/ || $3 ~ /postgres/ {print}'
}

container_env() {
  local container="$1" key="$2"
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" \
    | sed -n "s/^${key}=//p" | head -n1
}

create_role_and_db_with_psql() {
  local runner="$1" app_user="$2" app_db="$3" app_password="$4"
  eval "$runner" -v ON_ERROR_STOP=1 -v app_user="$app_user" -v app_db="$app_db" -v app_password="$app_password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_db') \gexec
SQL
}

prepare_db_objects_with_psql() {
  local runner="$1" app_user="$2"
  eval "$runner" -v ON_ERROR_STOP=1 -v app_user="$app_user" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'app_user') \gexec
SQL
}

ensure_app_network() {
  docker network inspect "$APP_NETWORK" >/dev/null 2>&1 || docker network create "$APP_NETWORK" >/dev/null
}

ensure_link_network() {
  docker network inspect "$DB_LINK_NETWORK" >/dev/null 2>&1 || docker network create "$DB_LINK_NETWORK" >/dev/null
}

connect_container_network() {
  local container="$1"
  ensure_link_network
  if ! docker inspect -f '{{json .NetworkSettings.Networks}}' "$container" | grep -q '"'"$DB_LINK_NETWORK"'"'; then
    docker network connect "$DB_LINK_NETWORK" "$container"
  fi
}

init_baseline_via_docker() {
  local database_url="$1" extra_args=() arg
  shift || true
  for arg in "$@"; do
    case "$arg" in
      host-gateway) extra_args+=(--add-host host.docker.internal:host-gateway) ;;
      network:*) extra_args+=(--network "${arg#network:}") ;;
    esac
  done

  log "从 Docker 网络验证数据库连接并初始化基线 SQL..."
  docker run --rm \
    "${extra_args[@]}" \
    -e DATABASE_URL="$database_url" \
    -v "$BASELINE_SQL:/baseline.sql:ro" \
    "$POSTGRES_CLIENT_IMAGE" \
    sh -ec 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "select current_user, current_database();" >/dev/null && psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /baseline.sql >/dev/null'
}

write_compose() {
  local mode="$1" db_network="${2:-}"
  cat > "$GENERATED_COMPOSE" <<'YAML'
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    env_file:
      - .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      - pma
__DB_API_NETWORK__

  web:
    build:
      context: .
      dockerfile: Dockerfile.web
    restart: unless-stopped
    ports:
      - "${PMA_WEB_PORT:-8080}:80"
    depends_on:
      - api
    networks:
      - pma

networks:
  pma:
    external: true
    name: pma-app-link
__DB_NETWORK_DECL__
YAML

  if [[ "$mode" == "docker-container" ]]; then
    sed -i 's|__DB_API_NETWORK__|      - db_link|' "$GENERATED_COMPOSE"
    cat >> "$GENERATED_COMPOSE" <<YAML
  db_link:
    external: true
    name: $db_network
YAML
    sed -i '/__DB_NETWORK_DECL__/d' "$GENERATED_COMPOSE"
  else
    sed -i '/__DB_API_NETWORK__/d;/__DB_NETWORK_DECL__/d' "$GENERATED_COMPOSE"
  fi
}

system_admin_psql() {
  if [[ $(id -un) == "postgres" ]]; then
    psql "$@"
  elif [[ ${EUID:-$(id -u)} -eq 0 ]] && command -v runuser >/dev/null 2>&1; then
    runuser -u postgres -- psql "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u postgres psql "$@"
  else
    die "无法切换到 postgres 系统用户执行 psql。"
  fi
}

system_admin_scalar() {
  system_admin_psql -X -Atqc "$1"
}

restart_system_postgres() {
  if ! command -v systemctl >/dev/null 2>&1; then
    system_admin_psql -X -d postgres -c 'select pg_reload_conf();' >/dev/null
    warn "系统没有 systemctl；如果 listen_addresses 被修改，请手动重启 PostgreSQL。"
    return
  fi

  local unit
  unit="$(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '$1 ~ /^postgresql.*\.service$/ {print $1; exit}')"
  unit="${unit:-postgresql.service}"
  as_root systemctl restart "$unit" || die "PostgreSQL 重启失败，请检查 systemctl status $unit"
}

setup_host_container_db() {
  local line container_id container_name admin_user admin_db app_user app_db app_password db_url
  local -a candidates=()
  mapfile -t candidates < <(list_postgres_containers)
  ((${#candidates[@]} > 0)) || return 1

  log "检测到宿主机上的 PostgreSQL Docker 容器："
  local i=1
  for line in "${candidates[@]}"; do
    printf '  %d) %s\n' "$i" "$line"
    ((i++))
  done

  local pick=1
  if ((${#candidates[@]} > 1)); then
    pick="$(prompt_default '请选择 PostgreSQL 容器' '1')"
    [[ "$pick" =~ ^[0-9]+$ ]] && ((pick >= 1 && pick <= ${#candidates[@]})) || die "选择无效"
  fi

  IFS=$'\t' read -r container_id container_name _ <<< "${candidates[$((pick-1))]}"
  admin_user="$(container_env "$container_id" POSTGRES_USER)"
  admin_db="$(container_env "$container_id" POSTGRES_DB)"
  admin_user="${admin_user:-postgres}"
  admin_db="${admin_db:-postgres}"

  app_user="$(prompt_default '应用数据库用户' 'pma')"
  app_db="$(prompt_default '应用数据库名' 'pma')"
  validate_ident "$app_user"
  validate_ident "$app_db"
  app_password="$(generate_password)"

  log "正在容器 $container_name 中创建/更新数据库用户与数据库..."
  create_role_and_db_with_psql "docker exec -i '$container_id' psql -X -U '$admin_user' -d '$admin_db'" "$app_user" "$app_db" "$app_password"
  prepare_db_objects_with_psql "docker exec -i '$container_id' psql -X -U '$admin_user' -d '$app_db'" "$app_user"
  docker exec -i "$container_id" psql -X -U "$admin_user" -d "$app_db" -v ON_ERROR_STOP=1 -v app_user="$app_user" < "$REPAIR_SQL" >/dev/null

  ensure_app_network
  connect_container_network "$container_id"
  db_url="postgres://${app_user}:${app_password}@${container_name}:5432/${app_db}"
  init_baseline_via_docker "$db_url" "network:$DB_LINK_NETWORK"

  set_env DATABASE_URL "$db_url"
  write_compose "docker-container" "$DB_LINK_NETWORK"
  log "宿主机 PostgreSQL 容器已自动接入网络 $DB_LINK_NETWORK。"
}

setup_host_system_db() {
  command -v psql >/dev/null 2>&1 || return 1
  id postgres >/dev/null 2>&1 || return 1

  if ! system_admin_psql -X -Atqc 'select 1' >/dev/null 2>&1; then
    return 1
  fi

  local app_user app_db app_password port hba_file current_listen docker_gateway app_subnet new_listen db_url hba_line
  app_user="$(prompt_default '应用数据库用户' 'pma')"
  app_db="$(prompt_default '应用数据库名' 'pma')"
  validate_ident "$app_user"
  validate_ident "$app_db"
  app_password="$(generate_password)"

  port="$(system_admin_scalar 'show port')"
  hba_file="$(system_admin_scalar 'show hba_file')"
  current_listen="$(system_admin_scalar 'show listen_addresses')"
  ensure_app_network
  docker_gateway="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
  docker_gateway="${docker_gateway:-172.17.0.1}"
  app_subnet="$(docker network inspect "$APP_NETWORK" -f '{{(index .IPAM.Config 0).Subnet}}')"

  log "检测到系统 PostgreSQL（端口 $port），正在创建/更新数据库..."
  create_role_and_db_with_psql "system_admin_psql -X -d postgres" "$app_user" "$app_db" "$app_password"
  prepare_db_objects_with_psql "system_admin_psql -X -d '$app_db'" "$app_user"
  system_admin_psql -X -d "$app_db" -v ON_ERROR_STOP=1 -v app_user="$app_user" < "$REPAIR_SQL" >/dev/null

  if [[ "$current_listen" != "*" && ",$current_listen," != *",$docker_gateway,"* ]]; then
    if [[ "$current_listen" == "localhost" || "$current_listen" == "127.0.0.1" ]]; then
      new_listen="localhost,$docker_gateway"
    else
      new_listen="$current_listen,$docker_gateway"
    fi
    system_admin_psql -X -d postgres -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET listen_addresses = '$new_listen';" >/dev/null
    log "已将 PostgreSQL 监听地址加入 Docker 网关 $docker_gateway"
  fi

  hba_line="host    $app_db    $app_user    $app_subnet    scram-sha-256"
  if ! as_root grep -Fqx "$hba_line" "$hba_file"; then
    printf '%s\n' "$hba_line" | as_root tee -a "$hba_file" >/dev/null
    log "已写入 pg_hba.conf：仅允许 Docker 私网使用 $app_user 访问 $app_db"
  fi

  restart_system_postgres

  db_url="postgres://${app_user}:${app_password}@host.docker.internal:${port}/${app_db}"
  init_baseline_via_docker "$db_url" "network:$APP_NETWORK" host-gateway
  set_env DATABASE_URL "$db_url"
  write_compose "host-system"
  log "系统 PostgreSQL 已通过 host.docker.internal 对接。"
}

setup_host_db() {
  if setup_host_container_db; then return; fi
  if setup_host_system_db; then return; fi
  die "没有检测到可管理的宿主机 PostgreSQL。请确认 PostgreSQL 正在运行，或改选“外部 PostgreSQL”。"
}

setup_external_db() {
  local db_url
  printf '\n请输入完整 PostgreSQL DATABASE_URL。\n'
  printf '示例：postgres://pma:password@10.0.0.8:5432/pma\n'
  db_url="$(prompt_secret 'DATABASE_URL')"
  [[ "$db_url" == postgres://* || "$db_url" == postgresql://* ]] || die "DATABASE_URL 格式不正确"
  ensure_app_network
  init_baseline_via_docker "$db_url" "network:$APP_NETWORK"
  set_env DATABASE_URL "$db_url"
  write_compose "external"
  log "外部 PostgreSQL 已验证并初始化。"
}

start_app() {
  log "正在使用专用数据库 Compose 启动应用..."
  (cd "$ROOT_DIR" && docker compose -f "$GENERATED_COMPOSE" up -d --build)
  printf '\n'
  log "完成。访问端口：${PMA_WEB_PORT:-8080}"
  log "后续启动：docker compose -f .pma-db-compose.yml up -d"
  log "查看日志：docker compose -f .pma-db-compose.yml logs -f api"
}

main() {
  need_cmd docker
  docker compose version >/dev/null 2>&1 || die "需要 Docker Compose v2（docker compose）"
  [[ -f "$BASELINE_SQL" ]] || die "找不到 $BASELINE_SQL，请在项目仓库内运行本脚本。"
  ensure_env_file
  ensure_app_network

  cat <<'MENU'

Personal Memory Agent · 数据库接入助手

  1) 宿主机 PostgreSQL（自动检测、建库、建用户、组网）
  2) 外部 PostgreSQL（验证连接并初始化）

MENU
  local choice
  choice="$(prompt_default '请选择数据库模式' '1')"
  case "$choice" in
    1) setup_host_db ;;
    2) setup_external_db ;;
    *) die "无效选择：$choice" ;;
  esac

  start_app
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
