# 方块英语点读 Android 内测版

这是独立于 Express 服务的 Capacitor Android 容器。App 始终通过 HTTPS 加载 `https://eduplayer.top`，不包含业务数据库，也不改变现有 API。

## 环境要求

- Node.js 22+
- JDK 21
- Android Studio 或 Android SDK 36
- Android 设备最低版本 Android 7.0（API 24）

## 本地检查与调试包

```powershell
cd mobile-app
npm ci
npm run check
npm run sync
cd android
.\gradlew.bat assembleDebug
```

调试 APK 输出到：

```text
mobile-app/android/app/build/outputs/apk/debug/app-debug.apk
```

## 正式签名

首次发布前，在安装了 JDK 21 的可信电脑上运行：

```powershell
.\scripts\generate-keystore.ps1
Copy-Item keystore.properties.example android\keystore.properties
```

编辑 `android/keystore.properties` 填写实际密码。证书、密码和该配置均已被 Git 忽略，必须额外制作两份离线备份。后续所有覆盖安装包必须使用同一证书。

```powershell
$env:APP_VERSION_CODE="2"
$env:APP_VERSION_NAME="1.0.1"
npm run build:release
```

正式 APK 输出到：

```text
mobile-app/android/app/build/outputs/apk/release/app-release.apk
```

也可使用 `ANDROID_KEYSTORE_FILE`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` 和 `ANDROID_KEY_PASSWORD` 环境变量替代配置文件。

## 版本规则

- 每次内测发布必须递增 `APP_VERSION_CODE`。
- `APP_VERSION_NAME` 使用语义版本，例如 `1.0.1`。
- 发布记录应包含 APK 的 SHA-256、Git 提交号、构建日期和测试设备。
- APK 仅通过可信私密渠道发送，公开上架前必须完成素材授权、儿童隐私与 APP 备案工作。

## 真机验收

1. 首次安装及同证书覆盖升级。
2. 登录后关闭 App、重启手机和服务器重启后的会话保持。
3. 英语与中文点读、答题、绿宝石和主题完成流程。
4. 口语测评的麦克风允许、拒绝、再次授权、录音和评分。
5. 断网、弱网、服务维护和会话失效页面。
6. 返回键依次关闭抽屉、退出答题、返回上一页和二次确认退出。

现有 Minecraft 名称和素材仅允许用于封闭测试，不应将本安装包公开传播。
