# 英语建造营地 / 第一章

## 内容与范围

- `/world` 是独立的 Three.js 游戏页面，不是 Minecraft 模组，不加载 Minecraft 游戏资源。
- 固定 64 × 64 × 24 方块世界，16 × 16 个人建造区，第一人称单人云端存档。
- 源词映射：concepts/block、wood/oak、tools/wooden axe、concepts/chest、verbs/build、verbs/jump、verbs/open、verbs/close。源主题内其他词不会自动掌握。
- 4组材料奖励依次为木板8、橡木4、木板8、木板8。旧掌握成绩首次进入补领一次。以后复习答错不撤销材料、配方或徽章。
- 初始配方：橡木1 → 木板4。8词掌握后解锁工作台（木板4）、木斧（木板3+橡木1）、箱子（木板8）、门（木板6）；这些配方需靠近公共或自建工作台使用。
- 先修桥，再领取教学斧、采集、找箱子、放台阶并跳过、开关教学门、建成轮廓小屋并开关自己的门。教学物品不依赖配方，采集点3秒恢复，可继续自由建造。
- 句子仅使用原句库9、22、23、24、25、29、32、78；找箱子提示读单词 chest。游戏不录音、不调用口语评测，也不消耗 SOE 套餐。标准音仍使用现有腾讯云 TTS，受原限流和缓存约束。

## 操作

电脑：WASD/方向键移动，点击场景锁定鼠标观察，左键或 E 操作，右键收回自建方块，Space 跳跃，1–6选择物品，Escape 暂停。暂停菜单可进入学习或合成。学习和合成面板暂停移动，关闭后回到当前位置，再次点击场景恢复鼠标观察。

iPad 横屏：左下摇杆移动，在场景滑动观察，右下分别是跳跃、使用/放置、收回按钮。底部物品栏选材，右侧工具栏打开合成或背包。手机竖屏只显示横屏建议，首版不以手机为验收目标。

轮廓按地板、墙、屋顶、门、箱子的顺序逐层显示；可关闭轮廓自由搭建。图形仅是提示，所有实际摆放都经服务端扣料并确认。已有材料不够时，可到橡木点继续采集和加工。

## 权限与存档

```env
WORLD_ACCESS=admin
```

- `admin`：默认，仅管理员试玩。
- `full`：管理员及有效的完整英语课程用户（现有 `founder_trial` 权益）。
- `off`：维护关闭，包含管理员。
- 所有新接口独立检查启用状态、密码重置状态、主课程、完整课程和开关。免费体验包括已到期账号均拒绝。

新增表：`world_saves`、`world_grants`、`world_operations`、`world_questions`，迁移标识 `2026-09-07-english-camp-v1`。只增表和索引；学习取题仍由服务端从8词白名单签发随机单次题号，绑定用户、选项及10分钟有效期。答题复用原 `answerQuiz` 的掌握、错题连续修正和绿宝石规则。

材料领取以用户+阶段为唯一键，动作以用户+操作UUID去重。存档版本冲突时先加载新版本，再用原操作UUID重试；命令内容不能被替换。读题、答题、采集、合成、放置、收回及任务动作即时确认保存。移动位置每10秒保存，也可以在暂停菜单主动保存。

网络失败时停止新的操作，保留内存中的未确认请求；重连使用相同UUID/题号重试。页面显示“云端已保存”只代表服务端已经确认。关闭页面后未确认请求不会继续重试，重新打开从服务端恢复已确认进度。多窗口共享一个存档，不支持同时合作编辑。

## API

- `GET /api/world/bootstrap`：存档、版本、任务、源词掌握、固定句子。
- `POST /api/world/learning/next`：可传营地 `wordId`。
- `POST /api/world/learning/answer`：`questionId`、`selected`、`version`。
- `POST /api/world/actions`：`operationId`、`version`、`position`、`type` 和相应动作字段。
- `GET /api/world/audio/word-<id>` 或 `/audio/phrase-<id>`：只接受固定词句ID，不接受任意文本。

动作包括 checkpoint、respawn、read、borrow、harvest、inspect、jump、craft、place、remove、door。服务端验证范围、可达距离、设施保护、库存、配方和碰撞占位。客户端负责真实移动与 Rapier 碰撞；首版不是用于竞技的全服务端物理模拟，不应宣称可防篡改客户端作弊。

## 构建与发布

Node >=22。Three.js、Rapier、图标和构建器均由 npm 锁定版本，不依赖外部 CDN。原始图形代码在 `world/`，构建至被 git 忽略的 `outputs/world-assets/`。部署必须执行构建，PM2 直接启动不会执行 npm 的 prestart。

服务器中先确认工作目录和数据库路径。下面备份适用于当前默认 `data/app.db`；自定义 DATABASE_PATH 时必须换成实际路径。不要把本地预览数据库上传生产。

```bash
cd /opt/minecraft-english-reader
mkdir -p backups
BACKUP="backups/app-before-world-$(date +%Y%m%d-%H%M%S).db"
sqlite3 data/app.db ".backup '$BACKUP'"
sqlite3 "$BACKUP" "PRAGMA integrity_check;"
```

确认结果是 `ok` 后再更新。依次执行，下列任一步失败不要继续重启：

```bash
git pull --ff-only origin main
npm ci --omit=dev
npm run build:world
npm run migrate
```

在 `.env` 设置 `WORLD_ACCESS=admin`，之后：

```bash
pm2 restart minecraft-english-reader --update-env
pm2 logs minecraft-english-reader --lines 30 --nostream
```

用独立管理员账号登录 `/world` 验收，再切换 `WORLD_ACCESS=full` 并重启。快速回滚为 `WORLD_ACCESS=off`；保留游戏表和存档，不删除数据。业务代码回滚时不需要撤销新增表。

## 自动验证与真机验收

```bash
npm ci
npm run build:world
npm run check
node scripts/preview-world.js
```

另一个终端运行 `node scripts/qa-world.cjs`，使用已安装 Chrome 和隔离的本地预览账号。截图放在 `work/world-qa/`，语音故障用网络桩模拟，不产生腾讯云付费调用。预览账号 `13830000000 / CampPreview2026!` 仅在本地隔离预览脚本中使用，不能配置到生产。

`node scripts/qa-world-recovery.cjs` 验证真实页面登录返回、重复点击、答题反馈延迟、错题保留、响应丢失、离线和版本冲突恢复。`node scripts/qa-world-journey.cjs` 验证门的真实碰撞与通行、Rapier 跳跃、最后一块蓝图放置、开关家门及结算留影；前置材料和建筑使用 API 布置隔离测试场景。这两个脚本只向 `work/world-preview/app.db` 新增独立 QA 账号，拒绝生产地址。

### 本地验证记录（2026-09-08）

- 后端及旧业务测试通过；营地取题/答题、材料、迁移、权限与整关结算均有自动回归。
- Chrome：1440×900电脑、1180×820和1024×768触控视口无横向溢出，四个选项完整可见，摇杆使用实际触控事件验证。
- 三个视口的场景像素采样非空；桌面硬件环境采样约120帧，55次左右绘制。该数据不是 iPad 真机帧率。
- 响应丢失后同一答题/动作重试不重复执行；双窗口版本冲突会同步；答错不自动切题，答对保留1秒后切题，新题延迟1.5秒读音。
- 真实腾讯云音频及 iPad Safari 真机尚未验证，测试使用503故障桩，未产生云端调用费用。
- `npm audit --omit=dev` 发现3项中等级别告警，来自原有 Express/body-parser/qs 依赖链，非新增3D依赖；本次未扩大范围升级旧服务依赖，上线前应单独处理并回归。

自动测试覆盖权限隔离、迁移幂等、源成绩继承、错题修正、单次题目、奖励去重、材料与配方校验、冲突版本、设施保护、整关建造和永久徽章。浏览器测试包含画面像素非空、四选项布局、电脑移动、触控摇杆和位置保存。

上线前仍需人工确认：真实 iPad Safari 横屏稳定30帧、连续触控与视角、真实腾讯云音频及自动播放策略、键盘鼠标全过程、双窗口与断网恢复、刷新与重新登录、退出后台、低电量模式。桌面模拟 iPad 视口和软件 WebGL 渲染不能代替真机性能验收。
