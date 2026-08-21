# Minecraft English Reader & Chinese Reader

面向小朋友的 Minecraft 风格双向语言点读系统：中文母语用户学习英语，英语母语用户学习中文。

## 功能

- 17 个主题素材和单词卡片点读
- 10 个 Core Words 中文点读主题，共 210 个独立图标
- 学习模式 / 答题模式专注切换
- 手机号密码登录，两门课程共用账号但独立记录进度和奖励
- 管理员手机号白名单
- 6 位数字+字母一次性邀请码
- 学习进度记录
- 错题第 6-10 题复现，连续答对 3 次后完成当天修正，并在当天剩余测验中排除
- 简单管理后台
- SQLite 持久会话、体验权益和管理员操作日志
- 好友邀请审核、每周绿宝石 PK 与共同任务
- 100 句独立英语口语测评，80% 单词掌握进度永久解锁
- 腾讯云智聆口语评测、每日限额、独立星级和章节徽章

## 本地运行

```bash
npm install
cp .env.example .env
npm start
```

默认访问：

- 学习页：http://127.0.0.1:3000/
- 中文点读页：http://127.0.0.1:3000/chinese
- 中文课程进度：http://127.0.0.1:3000/chinese/progress
- 登录页：http://127.0.0.1:3000/login
- 管理后台：http://127.0.0.1:3000/admin
- 好友页：http://127.0.0.1:3000/friends
- 英语口语测评：http://127.0.0.1:3000/speaking

首次启动会自动创建管理员账号。默认值来自 `.env.example`，上线前必须修改 `ADMIN_PASSWORD` 和 `SESSION_SECRET`。

口语测评上线前还需在 `.env` 配置 `TENCENT_SOE_APP_ID`，并将 `TENCENT_SOE_ENABLED` 改为 `true`。浏览器麦克风在公网环境必须通过 HTTPS 使用；服务端只保存评分，不保存录音。

## 腾讯云部署简要步骤

```bash
sudo mkdir -p /opt/minecraft-english-reader
cd /opt/minecraft-english-reader
git clone https://github.com/guoguo2827/Minecraft-English-Reader.git .
npm install --omit=dev
cp .env.example .env
nano .env
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```

生产部署、HTTPS、无损迁移和回滚步骤见 `deploy/PUBLIC_BETA_DEPLOYMENT.md`，Nginx 模板见 `deploy/nginx.conf.example`。

## 数据备份

服务器安装 `sqlite3` 后，可定时运行：

```bash
bash deploy/backup-sqlite.sh
```

建议每天备份一次，保留 7-14 天。

## 版权说明

本项目为非官方语言学习工具，仅供私人学习交流使用，与 Mojang、Microsoft、Minecraft 官方无关联，也未获得其认可、赞助或背书。

当前素材建议仅在手机号白名单和邀请码限制下小范围使用。若后续公开传播或商业化，建议替换为自制或已授权素材。
