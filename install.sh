#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${PMA_REPO_URL:-https://github.com/PaiMonCai/personal-memory-agent.git}"
PMA_REF="${PMA_REF:-main}"
DEFAULT_INSTALL_DIR="/opt/personal-memory-agent"
INSTALL_DIR=""
GENERATED_ADMIN_PASSWORD=""
ENV_WAS_PRESENT=0

log()  { printf '\033[1;34m[PMA]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[PMA]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[PMA]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[PMA]\033[0m %s\n' "$*" >&2; exit 1; }

on_error() {
  local code=$?
  printf '\n' >&2
  warn "安装在第 ${BASH_LINENO[0]:-?} 行失败（退出码 $code）。"
  if [[ -n "${INSTALL_DIR:-}" && -f "${INSTALL_DIR}/.pma-db-compose.yml" ]]; then
    warn "排查命令：cd $INSTALL_DIR && docker compose -f .pma-db-compose.yml logs --tail=200 api"
  fi
  exit "$code"
}
trap on_error ERR

tty_read() {
  local __var="$1"
  if [[ -r /dev/tty ]]; then
    IFS= read -r "$__var" < /dev/tty || true
  else
    IFS= read -r "$__var" || true
  fi
}

ask_default() {
  local prompt="$1" default="$2" value=""
  if [[ -w /dev/tty ]]; then
    printf '%s [%s]: ' "$prompt" "$default" > /dev/tty
  else
    printf '%s [%s]: ' "$prompt" "$default" >&2
  fi
  tty_read value
  printf '%s' "${value:-$default}"
}

ask_secret() {
  local prompt="$1" value=""
  if [[ -r /dev/tty && -w /dev/tty ]]; then
    printf '%s: ' "$prompt" > /dev/tty
    IFS= read -r -s value < /dev/tty || true
    printf '\n' > /dev/tty
  else
    IFS= read -r -s -p "$prompt: " value || true
    printf '\n' >&2
  fi
  printf '%s' "$value"
}

ask_yes_no() {
  local prompt="$1" default="${2:-y}" hint value=""
  if [[ "$default" == "y" ]]; then hint="Y/n"; else hint="y/N"; fi
  if [[ -w /dev/tty ]]; then
    printf '%s [%s]: ' "$prompt" "$hint" > /dev/tty
  else
    printf '%s [%s]: ' "$prompt" "$hint" >&2
  fi
  tty_read value
  if [[ -z "$value" ]]; then
    [[ "$default" == "y" ]]
    return
  fi
  case "${value,,}" in
    y|yes) return 0 ;;
    n|no) return 1 ;;
    *) warn "请输入 y 或 n。"; ask_yes_no "$prompt" "$default" ;;
  esac
}

require_root() {
  [[ ${EUID:-$(id -u)} -eq 0 ]] || die "请使用 root 运行。推荐先执行 sudo -i，再运行一键安装命令。"
}

install_base_packages() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v openssl >/dev/null 2>&1 || missing+=(openssl)
  (("${#missing[@]}" == 0)) && return

  log "安装基础依赖：${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git openssl
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl git openssl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl git openssl
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache ca-certificates curl git openssl
  else
    die "无法自动安装 curl/git/openssl，请先手动安装后重试。"
  fi
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker info >/dev/null 2>&1 || die "Docker 已安装但 daemon 不可用。"
    return
  fi

  printf '\n'
  warn "未检测到可用的 Docker + Compose v2。"
  ask_yes_no "使用 Docker 官方安装脚本自动安装" y || die "需要 Docker + Compose v2 才能继续。"
  curl -fsSL https://get.docker.com -o /tmp/pma-get-docker.sh
  sh /tmp/pma-get-docker.sh
  rm -f /tmp/pma-get-docker.sh
  command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "Docker 安装完成，但 Compose v2 不可用。"
  docker info >/dev/null 2>&1 || die "Docker daemon 未启动。"
}

checkout_project() {
  INSTALL_DIR="$(ask_default "安装目录" "$DEFAULT_INSTALL_DIR")"

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "检测到已有项目：$INSTALL_DIR"
    if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
      warn "项目目录存在未提交修改，为避免覆盖，本次不自动更新代码。"
      ask_yes_no "继续使用当前代码部署" y || die "已取消。请先处理本地修改。"
    else
      log "更新项目代码（ref: $PMA_REF）..."
      git -C "$INSTALL_DIR" fetch --prune origin
      if git -C "$INSTALL_DIR" show-ref --verify --quiet "refs/heads/$PMA_REF"; then
        git -C "$INSTALL_DIR" switch "$PMA_REF"
      else
        git -C "$INSTALL_DIR" switch -C "$PMA_REF" "origin/$PMA_REF"
      fi
      git -C "$INSTALL_DIR" pull --ff-only origin "$PMA_REF"
    fi
  else
    if [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]]; then
      die "安装目录已存在且不是 Git 仓库：$INSTALL_DIR"
    fi
    mkdir -p "$(dirname "$INSTALL_DIR")"
    log "拉取 Personal Memory Agent（ref: $PMA_REF）..."
    git clone --depth 1 --branch "$PMA_REF" "$REPO_URL" "$INSTALL_DIR"
  fi

  [[ -f "$INSTALL_DIR/deploy/setup-database.sh" ]] || die "当前 ref 不包含数据库部署助手。测试 PR 时请设置 PMA_REF=feat/database-setup-helper。"
  cd "$INSTALL_DIR"
}

random_hex() {
  local bytes="${1:-32}"
  openssl rand -hex "$bytes"
}

valid_email() {
  [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && ((1 <= 10#$1 && 10#$1 <= 65535))
}

detect_host_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  fi
  if [[ -z "$ip" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  printf '%s' "${ip:-127.0.0.1}"
}

ensure_secret_env() {
  local key="$1" current
  current="$(get_env "$key")"
  case "$current" in
    ""|replace-with-a-long-random-secret|replace-with-32-byte-key)
      set_env "$key" "$(random_hex 32)"
      ;;
  esac
}

configure_application() {
  local port access_mode origin domain admin_email admin_password ai_base ai_key ai_models host_ip

  [[ -f .env ]] && ENV_WAS_PRESENT=1
  if ((ENV_WAS_PRESENT)); then
    cp .env ".env.backup.$(date +%Y%m%d-%H%M%S)"
    log "已备份现有 .env。"
  fi
  ensure_env_file

  printf '\n'
  log "应用基础配置"

  while true; do
    port="$(ask_default "Web 访问端口" "$(get_env PMA_WEB_PORT || true)")"
    port="${port:-8080}"
    valid_port "$port" && break
    warn "端口必须是 1-65535。"
  done
  set_env PMA_WEB_PORT "$port"
  set_env PMA_BIND_ADDRESS "0.0.0.0"
  set_env NODE_ENV "production"
  set_env PORT "3000"
  set_env SESSION_DAYS "30"

  cat >&2 <<'MENU'

访问方式：
  1) 域名 / HTTPS（已有 Nginx、1Panel、Caddy、Cloudflare 等反代）
  2) 服务器 IP / HTTP 直接访问
MENU
  access_mode="$(ask_default "请选择访问方式" "1")"
  case "$access_mode" in
    1)
      while true; do
        domain="$(ask_default "域名或完整访问地址" "https://memory.example.com")"
        [[ "$domain" != *"example.com"* ]] || { warn "请输入你自己的域名。"; continue; }
        if [[ "$domain" != http://* && "$domain" != https://* ]]; then
          domain="https://$domain"
        fi
        origin="${domain%/}"
        break
      done
      ;;
    2)
      host_ip="$(detect_host_ip)"
      origin="http://${host_ip}:${port}"
      origin="$(ask_default "APP_ORIGIN（浏览器实际访问地址）" "$origin")"
      origin="${origin%/}"
      ;;
    *)
      die "无效访问方式：$access_mode"
      ;;
  esac
  set_env APP_ORIGIN "$origin"

  while true; do
    admin_email="$(ask_default "管理员邮箱" "$(get_env BOOTSTRAP_ADMIN_EMAIL || true)")"
    admin_email="${admin_email:-admin@example.com}"
    valid_email "$admin_email" && [[ "$admin_email" != "admin@example.com" ]] && break
    warn "请输入有效的管理员邮箱。"
  done

  admin_password="$(ask_secret "管理员密码（留空自动生成）")"
  if [[ -z "$admin_password" ]]; then
    admin_password="$(random_hex 12)"
    GENERATED_ADMIN_PASSWORD="$admin_password"
  elif (("${#admin_password}" < 8)); then
    die "管理员密码至少 8 个字符。"
  fi
  set_env BOOTSTRAP_ADMIN_EMAIL "$admin_email"
  set_env BOOTSTRAP_ADMIN_PASSWORD "$admin_password"

  ensure_secret_env OTP_PEPPER
  ensure_secret_env SYSTEM_CONFIG_ENCRYPTION_KEY
  ensure_secret_env PREFERENCES_ENCRYPTION_KEY

  if ((ENV_WAS_PRESENT == 0)); then
    set_env SMTP_HOST ""
    set_env SMTP_USER ""
    set_env SMTP_PASS ""
    set_env MAIL_FROM ""
    set_env SMTP_PORT "465"
    set_env SMTP_SECURE "true"
  fi

  if ask_yes_no "现在配置默认 AI 接口" n; then
    ai_base="$(ask_default "AI Base URL" "$(get_env AI_BASE_URL || true)")"
    ai_key="$(ask_secret "AI API Key")"
    ai_models="$(ask_default "模型（多个用逗号分隔）" "$(get_env AI_MODELS || true)")"
    ai_models="${ai_models:-gpt-5.6}"
    set_env AI_BASE_URL "${ai_base%/}"
    set_env AI_API_KEY "$ai_key"
    set_env AI_MODELS "$ai_models"
    set_env AI_DAILY_LIMIT "200"
  elif ((ENV_WAS_PRESENT == 0)); then
    set_env AI_BASE_URL ""
    set_env AI_API_KEY ""
    set_env AI_MODELS ""
    set_env AI_DAILY_LIMIT "200"
  fi

  chmod 600 .env
}

configure_database() {
  local db_mode
  cat >&2 <<'MENU'

数据库模式：
  1) 内置 PostgreSQL 16 容器（推荐新部署，最省事）
  2) 宿主机 PostgreSQL（自动检测系统服务 / 1Panel / Docker）
  3) 外部 PostgreSQL（远程数据库）
MENU
  db_mode="$(ask_default "请选择数据库模式" "1")"
  case "$db_mode" in
    1)
      setup_managed_db
      ;;
    2)
      setup_host_db
      ;;
    3)
      setup_external_db
      ;;
    *)
      die "无效数据库模式：$db_mode"
      ;;
  esac
}

wait_for_health() {
  local port url i
  port="$(get_env PMA_WEB_PORT)"
  port="${port:-8080}"
  url="http://127.0.0.1:${port}/api/health"

  log "检查应用健康状态..."
  for i in $(seq 1 30); do
    if curl -fsS --max-time 3 "$url" 2>/dev/null | grep -q '"ok":true'; then
      ok "API 健康检查通过。"
      return 0
    fi
    sleep 2
  done

  warn "应用容器已经启动，但健康检查暂未通过。"
  docker compose -f .pma-db-compose.yml ps >&2 || true
  docker compose -f .pma-db-compose.yml logs --tail=80 api >&2 || true
  return 1
}

clear_bootstrap_password() {
  set_env BOOTSTRAP_ADMIN_PASSWORD ""
  chmod 600 .env
}

print_summary() {
  local origin email port
  origin="$(get_env APP_ORIGIN)"
  email="$(get_env BOOTSTRAP_ADMIN_EMAIL)"
  port="$(get_env PMA_WEB_PORT)"

  printf '\n'
  printf '\033[1;32m============================================================\033[0m\n'
  printf '\033[1;32m Personal Memory Agent 部署完成\033[0m\n'
  printf '\033[1;32m============================================================\033[0m\n'
  printf '安装目录：%s\n' "$INSTALL_DIR"
  printf '访问地址：%s\n' "$origin"
  printf '管理员邮箱：%s\n' "$email"
  if [[ -n "$GENERATED_ADMIN_PASSWORD" ]]; then
    printf '管理员密码：%s  （仅显示这一次，请保存）\n' "$GENERATED_ADMIN_PASSWORD"
  else
    printf '管理员密码：使用你刚才输入的密码\n'
  fi
  printf 'Web 端口：%s\n' "$port"
  printf '\n常用命令：\n'
  printf '  cd %q\n' "$INSTALL_DIR"
  printf '  docker compose -f .pma-db-compose.yml ps\n'
  printf '  docker compose -f .pma-db-compose.yml logs -f api\n'
  printf '  docker compose -f .pma-db-compose.yml restart\n'
  printf '  docker compose -f .pma-db-compose.yml down\n'
  printf '\n'
  warn "如果数据库里原本已经存在管理员，本脚本不会重置其现有登录密码。"
}

main() {
  require_root
  clear 2>/dev/null || true
  cat <<'BANNER'
============================================================
 Personal Memory Agent · 一键交互安装器
============================================================
BANNER

  install_base_packages
  ensure_docker
  checkout_project

  # setup-database.sh 既能单独运行，也作为本安装器的数据库模块被 source。
  # shellcheck source=/dev/null
  source "$INSTALL_DIR/deploy/setup-database.sh"

  configure_application
  configure_database

  log "启动应用..."
  start_app

  if wait_for_health; then
    # 管理员已在 API 启动阶段完成 bootstrap；明文密码不再需要留在 .env。
    clear_bootstrap_password
  fi

  print_summary
}

main "$@"
