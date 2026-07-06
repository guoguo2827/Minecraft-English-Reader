# Minecraft English Reader

一个面向小朋友的 Minecraft 英语点读学习网页，已升级为适合好友小范围使用的线上版本。

## 功能

- 17 个主题素材和单词卡片点读
- 学习模式 / 答题模式专注切换
- 用户名密码登录
- 管理员手机号白名单
- 6 位数字+字母一次性邀请码
- 学习进度记录
- 错题第 6-10 题复现，连续答对 2 次后退出错题队列
- 简单管理后台

## 本地运行

```bash
npm install
cp .env.example .env
npm start
```

默认访问：

- 学习页：http://127.0.0.1:3000/
- 登录页：http://127.0.0.1:3000/login
- 管理后台：http://127.0.0.1:3000/admin

首次启动会自动创建管理员账号。默认值来自 `.env.example`，上线前必须修改 `ADMIN_PASSWORD` 和 `SESSION_SECRET`。

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

如使用 Nginx，可参考 `deploy/nginx.conf.example`。

## 数据备份

服务器安装 `sqlite3` 后，可定时运行：

```bash
bash deploy/backup-sqlite.sh
```

建议每天备份一次，保留 7-14 天。

## 版权说明

本项目为非官方英语学习工具，仅供私人学习交流使用，与 Mojang、Microsoft、Minecraft 官方无关联，也未获得其认可、赞助或背书。

当前素材建议仅在手机号白名单和邀请码限制下小范围使用。若后续公开传播或商业化，建议替换为自制或已授权素材。
