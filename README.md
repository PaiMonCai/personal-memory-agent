# 信息管家

自托管的个人信息与记忆管理 Agent。

把零散想法、资料和待办统一记录下来，由 AI 自动分类、摘要、提炼重点并建立关联，同时支持检索、问答、待办整理和阶段复盘。

## 主要功能

- 随手记录想法、资料与待办
- AI 自动分类、摘要、标签与重点提取
- 自动发现记录之间的关联
- 关键词检索与智能问答
- 待办整理与阶段复盘
- Markdown / 文本文件导入
- 主题、背景和界面个性化
- 服务器模型与自定义 OpenAI-compatible 接口
- 邮箱密码 + OTP 登录
- 管理员后台配置 SMTP
- Docker 自托管部署

## 技术栈

- 前端：Vite + React + TypeScript
- 后端：Hono
- 数据库：PostgreSQL
- Web：Nginx
- 部署：Docker Compose

## 快速部署

```bash
cp .env.example .env
```

至少配置：

```env
APP_ORIGIN=https://memory.example.com

POSTGRES_PASSWORD=replace-with-a-strong-database-password

BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-strong-admin-password
SYSTEM_CONFIG_ENCRYPTION_KEY=replace-with-a-long-random-secret

OTP_PEPPER=replace-with-a-long-random-secret
PREFERENCES_ENCRYPTION_KEY=replace-with-32-byte-key

AI_BASE_URL=https://api.example.com/v1
AI_API_KEY=replace-me
AI_MODELS=gpt-5.6
```

然后启动：

```bash
docker compose up -d
```

默认访问：

```text
http://服务器IP:8080
```

## 首次管理员与 SMTP

首次部署不需要提前把 SMTP 配好。

应用发现数据库中没有管理员时，会使用：

```env
BOOTSTRAP_ADMIN_EMAIL
BOOTSTRAP_ADMIN_PASSWORD
```

创建管理员。

之后使用管理员邮箱和密码直接登录，在：

```text
设置 → 管理员 · 邮件服务
```

中填写 SMTP，并发送测试邮件。

SMTP 保存后立即生效，不需要重启服务。

管理员创建成功后，可以从 `.env` 删除：

```env
BOOTSTRAP_ADMIN_EMAIL
BOOTSTRAP_ADMIN_PASSWORD
```

`SYSTEM_CONFIG_ENCRYPTION_KEY` 用于加密 SMTP 密码，投入使用后不要随意更换。

## AI 模型

默认模型通过服务端的 OpenAI-compatible 接口调用：

```env
AI_BASE_URL=https://api.example.com/v1
AI_API_KEY=replace-me
AI_MODELS=model-a,model-b
```

用户也可以在设置中添加自己的 OpenAI-compatible 接口与模型。

## 已有部署升级

已有 PostgreSQL volume 不需要删除。

应用启动时会自动补齐管理员角色和系统设置相关数据库结构，原有记录与用户数据会保留。

升级前建议备份数据库。

### 外部 PostgreSQL / 手动初始化

如果不是通过仓库里的 Docker Compose 全新初始化数据库，执行 `database/001_baseline.sql` 时必须使用 **`DATABASE_URL` 中的同一个 PostgreSQL 用户**。

例如应用连接用户是 `pma`：

```bash
psql "postgres://pma:密码@数据库地址:5432/pma" \
  -v ON_ERROR_STOP=1 \
  -f database/001_baseline.sql
```

不要用 `postgres` 超级用户代替 `pma` 执行基线 SQL，否则表和 identity sequence 会归 `postgres` 所有，后续应用用户可能无法执行 schema upgrade。

应用启动时会检查项目表和 sequence 的 owner；如果 owner 与当前 `DATABASE_URL` 用户不一致，会直接给出明确错误并停止启动。

如果已有数据库已经出现这个问题，可以用数据库管理员执行：

```bash
psql -U postgres -d pma \
  -v app_user=pma \
  -f database/repair_ownership.sql
```

修复脚本只处理本项目的表及其关联 sequence，并为应用用户补充 `public` schema 的必要权限。

## HTTPS

生产环境建议设置：

```env
APP_ORIGIN=https://memory.example.com
```

并在服务前使用 Nginx、Caddy、OpenResty 或 Cloudflare 提供 HTTPS。

## 本地开发

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```
