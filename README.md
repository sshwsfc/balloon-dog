# 气球狗 · 孩子的守护者

儿童设备监控应用。家长端是 React 移动端 Web 应用（微信风格 UI），
后端是 Express + Prisma + PostgreSQL 的真实服务，孩子设备通过 Agent 接入，
另有一套独立的管理后台（`/admin`）用于平台运营与安全审计。

> 本仓库原先只有一份基于 `db.json` 的 mock server。现已重写为真实后端，
> 详见下方 [从 mock 到真实后端](#从-mock-到真实后端) 与 [`server/README.md`](server/README.md)。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19 · TypeScript 5.9 · Vite 7（双入口：家长端 + 管理后台）· Tailwind CSS v4 · shadcn/ui · react-router-dom 7 · sonner |
| 后端 | Express 5 · TypeScript · Prisma 5 · PostgreSQL 16 · zod · pino · JWT |
| 工具 | ESLint 9（前后端各自配置）· Docker Compose（数据库） |

---

## 快速开始

```bash
# 1) 前端依赖
npm install

# 2) 后端依赖 + 数据库
npm run server:install
npm run db:up           # docker 起 PostgreSQL（端口 5433）
npm run db:migrate      # 建表
npm run db:seed         # 演示数据

# 3) 配对外访问基址（决定安装包二维码指向哪、孩子端装完连哪个后端）
cp .env.example .env    # 本机开发可留空，走下面的 localhost 即默认值

# 4) 构建产物 + 同时启动预览服务器与后端
npm run preview:all
```

- 家长端：http://localhost:2727 （`/api` 自动代理到后端 4000）
- 管理后台：http://localhost:2727/admin
- 后端：http://localhost:4000

> **对外访问（含反向代理的域名）一律走 `npm run preview`（2727）**。它跑的是 `dist/` 静态产物，
> 首屏比 dev server 快得多（dev 要按需转换每个模块还挂着 HMR websocket，走公网代理会明显变慢）。
>
> 本机开发用 `npm run dev`，端口走 Vite 默认的 5173（带 HMR，被占用时自动 +1），不对外。
> `preview` 的 2727 配了 `strictPort`，被占用时直接报错而不会悄悄换端口。

| 入口 | 演示账号 |
| --- | --- |
| 家长端 | `13800138000` / `balloon123` |
| 管理后台（超级管理员） | `admin` / `balloon-admin-2026` ⚠️ 上线前必须修改 |
| 管理后台（运营，权限受限） | `operator` / `balloon-operator-2026` |

也可以分开跑：

```bash
npm run server:dev      # 只起后端（4000）
npm run preview         # 只起对外站点（2727，需先 npm run build）
npm run dev             # 本机开发服务器（5173，带 HMR）
```

### 对外访问基址（`VITE_SERVER_URL`）

仓库根目录的 `.env`（模板 `.env.example`）里只有一个变量：

```bash
VITE_SERVER_URL=https://ballondog.hd.takin.cc
```

它是**家长端页面、后端 `/api`、孩子端安装包下载**共同挂在的那个域名，由反向代理统一入口。
这一个值决定三件事，必须一致，所以只配一处：

1. 新手引导第一步那个**安装包二维码**的内容（必须是孩子手机能直接打开的公网地址）；
2. 家长端页面上的**手动下载链接**与**微信登录回跳地址**；
3. **孩子端 APK 内置的后端地址** —— `android/app/build.gradle` 读同一个变量烘焙进
   `release` 包，这样 `npm run android:copy-apk` 发布的包装到孩子手机上直接就连线上。

留空则回落到「当前页面的 origin」，只适合本机开发：那时孩子手机扫不开二维码，
引导页会显示一条琥珀色警告说明。

反向代理需要满足三点：

| 路径 | 转发到 | 说明 |
| --- | --- | --- |
| `/api/*` | 后端 4000 | 前端一律写相对路径 `/api/...`，由代理转发 |
| 其余（含 `/download/*.apk`） | `vite preview` 2727 | **安装包必须由前端这一侧提供**，转发到后端会 404 |

⚠️ 反代**不要**指向 `npm run dev`（5173）：dev server 首屏明显更慢，而且必须转发 WebSocket
`Upgrade` 头（否则热更新连不上）。对外统一用 2727 的 `vite preview`。

Vite 会校验请求的 `Host` 头，`vite.config.ts` 已经把 `VITE_SERVER_URL` 的主机名加进
`allowedHosts`；换域名时改 `.env` 即可，不用动配置。后端那边记得同步
`server/.env` 的 `PUBLIC_BASE_URL` / `CLIENT_URL` / `CORS_ORIGIN`（见 `server/README.md`）。

---

## 全部命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器（5173，带 HMR） |
| `npm run build` | TypeScript 类型检查 + 生产构建 |
| `npm run lint` | ESLint 检查前端 |
| `npm run preview` | 起对外站点（2727，跑 `dist/` 产物，反向代理指这里） |
| `npm run server:dev` | 启动后端（tsx watch） |
| `npm run server:build` | 编译后端到 `server/dist` |
| `npm run server:typecheck` | 后端类型检查 |
| `npm run server:smoke` | **后端端到端冒烟测试（162 项断言）** |
| `npm run db:clean` | 清理冒烟测试留下的临时账号与设备（先预演） |
| `npm run e2e` | **浏览器端到端测试**（家长端 + 管理后台，CDP 驱动无头 Chrome） |
| `npm run e2e:parent` / `e2e:admin` | 只跑其中一套 |
| `npm run e2e:responsive` | **响应式视口矩阵**（5 档视口 × 20 个页面：无横向溢出、内容限宽居中、标题栏铺满、导航形态正确，见 [`docs/RESPONSIVE.md`](docs/RESPONSIVE.md)） |
| `npm run android:build` | 构建孩子设备端 Agent 的调试 APK（见 [`android/README.md`](android/README.md)） |
| `npm run android:release` | 构建 Agent 的发布 APK |
| `npm run android:e2e` | **Agent 端到端联调**（真机/模拟器 + 真实后端：协议闭环、拍照/录音/截图、Kiosk 锁定、倒计时悬浮窗、作息时间表、最高强度档、保活） |
| `npm run android:crosstest` | **作息求值交叉验证**（Android 与后端两套实现逐点比对，2016 个采样点） |
| `npm run android:e2e:screen` | **截屏洞察 + 锁定复核端到端联调**（真机/模拟器：采样→打包→上传→AI 分析→亮屏重锁→降级路径拉回） |
| `npm run android:capture` | 在模拟器上批量截取界面截图到 `android/docs/screenshots/` |
| `npm run server:e2e:insights` | **屏幕洞察后端全链路**（上传→入库→家长端可见→预算→屏幕出题→清理，28 项） |
| `npm run server:e2e:icons` | **应用图标后端全链路**（上报→嗅探→签名 URL→缓存与鉴权→重传不丢图，32 项） |
| `npm run server:e2e:membership` | **会员体系全链路**（动态定价→下单快照→三种周期→续费与升级→自动续费→门禁 403→受邀用户定价，175 项） |
| `npm run server:e2e:referral` | **分享提成全链路**（邀请码→注册绑定→首充阶梯返现→续费返现→券里程碑→次月结算→提现门槛与审核→风控，159 项） |
| `npm run server:e2e:ai` | **AI 分析全链路**，对着 `npm run server:mock:ai` 起的假视觉服务跑（28 项，不需要真 key） |
| `npm run server:mock:ai` | 起一个 OpenAI 兼容的假视觉服务（默认 :4100），用 `MOCK_AI_SCENARIO` 切换场景 |
| `npm run db:up` / `db:down` | 起停 PostgreSQL 容器 |
| `npm run db:migrate` | 执行 Prisma 迁移 |
| `npm run db:seed` | 灌入演示数据（幂等） |
| `npm run dev:all` | 开发服务器 + 后端一起起（5173 + 4000） |
| `npm run preview:all` | 构建后起对外站点 + 后端（2727 + 4000） |

后端专属命令（需 `cd server`）：`npm run lint`、`npm run prisma:studio`、
`npm run agent:example`（模拟一台孩子设备）。

---

## 项目结构

```
balloon-dog/
├─ index.html                # 家长端 SPA 入口（挂载 #root）
├─ admin/index.html          # 管理后台 SPA 入口（挂载 #admin-root，basename /admin）
├─ src/                      # 家长端
│  ├─ pages/                 # 首页 / 位置 / 个人中心 / 设备管理 / 答题 / 媒体 / 登录
│  ├─ contexts/AuthContext.tsx
│  ├─ services/api.ts        # 接口层（错误透传、401 统一处理、令牌管理）
│  ├─ components/            # BottomNav、BrandLogo（品牌标识，与孩子端图标同源）、ErrorBoundary、shadcn/ui
│  └─ types/index.ts         # 与后端契约一一对应的类型
├─ src/admin/                # 管理后台（独立 SPA，代码不进家长端产物包）
│  ├─ pages/                 # 看板 / 家长账号 / 设备 / 指令 / 题库 / 答题 / 验证码 / 管理员 / 日志 / 设置
│  ├─ components/            # AdminLayout、ConfirmDialog、ui-kit、status
│  ├─ hooks/useAsyncData.ts  # 统一的数据获取 + 筛选分页状态
│  └─ api/                   # 后台接口层（独立令牌与 401 通道）
├─ server/                   # 后端（独立 npm 包，见 server/README.md）
│  ├─ prisma/                # schema + migrations + seed
│  ├─ scripts/               # 冒烟测试 + 设备端 Agent 示例 + 测试数据清理
│  └─ src/features/          # auth / devices / quiz / locations / media / admin
├─ android/                  # 孩子设备端 Agent（Java + XML，见 android/README.md）
│  ├─ app/src/main/java/     # net / capability / service / ui / data / model
│  └─ scripts/e2e-agent.mjs  # Agent 端到端联调（真机或模拟器 + 真实后端）
├─ public/                   # logo.svg / apple-touch-icon.png / download/（孩子端安装包）
├─ server/docker-compose.yml
└─ vite.config.ts            # 双入口构建 + /api 代理 + /admin history fallback
```

---

## 功能状态

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 手机号 + 密码登录/注册 | ✅ 完成 | bcrypt 校验；密码错误确实会被拒绝 |
| 短信验证码 | ✅ 完成 | 腾讯云短信；未配置时非生产环境返回 `devCode` 便于联调 |
| 验证码登录 | ✅ 完成 | 手机号首次使用自动注册 |
| 微信扫码登录 | ✅ 完成 | 真实网页授权；未配置凭据时提供联调模拟扫码 |
| 多设备管理 | ✅ 完成 | 凭设备码认领、切换、改名、解绑 |
| 一键锁屏 / 临时解锁 | ✅ 完成 | 经指令队列下发；失败或超时自动回滚 |
| 时间规划 / 应用限制 / 应用审核 / 网址拦截 | ✅ 完成 | 真实配置存储 + 策略下发 |
| 答题解锁 | ✅ 完成 | 26 道题库（多年级）、答题记录与统计、答对延长可用时长 |
| 位置监控 + 安全区 | ✅ 完成 | 设备上报轨迹，服务端按 haversine 判定是否在安全区内 |
| 远程拍照 / 截图 / 录像 / 录音 | ✅ 完成 | 指令队列 + 媒体落盘 + 短时效签名 URL |
| 同屏监控 / 远程协助 / 通话短信 | ⚠️ 后端就绪 | 接口与指令类型齐备，**需设备端 Agent 实现**才能真正生效 |
| **屏幕行为 AI 洞察** | ✅ 完成 | 设备周期截屏 → 打包上传 → 服务端视觉模型总结「用了什么、在做什么」；**没配 AI key 就明确标为未配置，绝不伪造结论** |
| **异常提醒 / 用量预算 / 屏幕出题** | ✅ 完成 | 未成年内容、疑似被骗、情绪问题、游戏沉迷、高额消费五类提醒；按「玩几局 / 看几集」限用；答题由屏幕内容生成 |
| **孩子设备端 Agent（`android/`）** | ✅ 完成 | Java 原生实现，设备端协议 13 组接口；Kiosk / 悬浮窗 / 锁屏页三档锁定 + 无障碍看门狗 + 亮屏即重锁 |
| **模式切换（学习模式）** | ✅ 完成 | 手动或按时段（0–23 时 × 一周七天）；学习模式下只允许白名单应用，**判定在设备端本地做，断网照常生效** |
| **护眼设置** | ✅ 完成 | 连续用眼到点强制锁屏休息（不可被临时解锁绕过）、夜间护眼时段、屏幕亮度上限 |
| **微信 / QQ 功能管控** | ✅ 完成 | 按应用聚合的功能清单逐项开关；设备端用无障碍按界面文本拦截。**拦不住 WebView/画布内容**，见 `android/README.md` §2.4.1 |
| **家长端响应式** | ✅ 完成 | 竖屏手机 / 横屏手机 / 平板 / 桌面 / 超宽屏五档均可用：宽屏内容居中限宽（不再通栏拉伸）、导航在宽屏变侧栏、横屏矮视口压缩留白 |
| **会员体系（三档 + 动态定价）** | ✅ 完成 | 普通 / 会员 / 超级会员；按月、按年、连续包月三种周期，**金额按账号画像动态计算且规则后台可管**；**受邀注册的账号价格更高**（上浮比例 / 加收固定金额 / 一口价，后台可维护，与常规定价取更高者 —— 邀请人的返现是平台成本，得由被邀请的订单覆盖）；支付宝 / 微信收银台目前是 **mock**（`MEMBERSHIP_MOCK_PAY=true` 直接开通，不真扣款）；答题解锁 / 远程监控 / 多设备绑定归会员，AI 洞察归超级会员，非会员触达时统一提示升级 |
| **分享提成（邀请返现）** | ✅ 完成 | 每个账号自带 8 位邀请码与分享链接/二维码；好友注册充值后邀请人拿返现 —— 首充按阶梯（0-3 人 50% / 4-9 人 40% / ≥10 人 20%，月卡季卡保底 50%，年卡单笔封顶 75 元）、续费 20%–50% 封顶 75 元；奖励按当月统计、**次月 10-15 日发放**，提现需「≥3 名有效充值好友 + 实名认证 + 累计返现 ≥50 元」，提现单走后台人工审核（待审核→已通过→已打款）；邀请满 3/10/20 人及每满 30 人发优惠券，可用于会员下单抵扣。**返现与提现目前是站内记账**，真实打款仍需人工在站外汇出 |
| 管理后台（`/admin`） | ✅ 完成 | 独立管理员体系；数据看板、家长账号/设备/指令/题库管理、验证码审计、操作日志、角色分权，以及**会员管理的套餐 / 定价规则 / 受邀用户定价 / 订单 / 统计**五页与**分享提成的统计 / 提现审核 / 邀请记录 / 返现明细 / 优惠券 / 活动配置 / 规则阶梯 / 风险排查**八页 |

> ⚠️ 的这几项后端无法单独完成 —— 任何声称「纯服务端就能读孩子短信」的实现都是假的。
> 本仓库提供 `server/scripts/device-agent-example.mjs` 作为可运行的客户端参考实现。

> 关于 `password` 最高强度档：该档会随机改写系统锁屏密码，
> 「重启后自动清除」这条安全阀一度失效（会把设备锁在系统锁屏外），
> 现已通过 `directBootAware` + `LOCKED_BOOT_COMPLETED` + 设备加密存储修复，
> 并已纳入端到端回归（改写密码 → 重启 → 断言仍能进入系统）。
> 详见 [`android/README.md`](android/README.md) §2.4。

---

## 从 mock 到真实后端

原实现的问题与本次修复：

| # | 原缺陷 | 现在 |
| --- | --- | --- |
| 1 | **`npm run mock-server` 完全无法启动**（ts-node 10 不兼容 TypeScript 7） | 后端独立成 `server/` 包，用 tsx，`npm run server:dev` 正常启动 |
| 2 | **`npm run lint` 崩溃**（typescript-eslint 不兼容 TS 7） | 版本回到兼容区间，前后端各有 ESLint 配置，均 0 报错 |
| 3 | **密码形同虚设**：注册从不存密码，登录只查手机号存在性 → 任意密码都能登录 | bcrypt 哈希存储 + 真实比对；账号不存在时也做一次哈希，抹平响应时间差防枚举 |
| 4 | **`api.delete()` 漏拼 Authorization 头** → 删除设备必定 401 | 所有请求走同一个 `request()`，统一附带令牌 |
| 5 | **`/api/device`、`/api/features` 零鉴权**，未登录即可读写 | 全部要求登录，10 个接口逐一在冒烟测试里断言 401 |
| 6 | **`db.device` 是全局单例** → 用户之间互相串数据，B 锁屏会改到 A 的设备 | 数据全部按 `userId` + `deviceId` 隔离，越权返回 403 |
| 7 | **Token 就是 `token_<userId>`**，可伪造、可枚举、无过期 | 签名 JWT（含主体类型），每请求校验账号状态，禁用即时生效 |
| 8 | **验证码是纯前端摆设**（前端要求填、却从不发送，后端也从不校验） | 验证码哈希落库、限次、一次性消费、带重发与每日限流 |
| 9 | **微信登录每次生成随机 openid** → 每次点击都新建账号 | 真实扫码会话 + 后端换 openid，身份稳定可复登 |
| 10 | **错误信息全链路丢失**，用户永远看到 "API Error: 400" | 后端 `message` 直通前端 `ApiError.userMessage`，页面统一用 `toUserMessage()` |
| 11 | **接口失败即白屏**（`finally setLoading(false)` 后访问 null） | 错误态页面 + 全局 `ErrorBoundary` |
| 12 | **首页高级功能开关事件冒泡**，一次点击触发两个不同动作 | 行主体与开关拆成独立按钮，各司其职 |
| 13 | **`LocationPage` 100% 硬编码**，`db.locations` 是无人读写的死数据 | 真实位置接口 + 安全区 CRUD + 轨迹时间线 |
| 14 | **`BottomNav` 在登录页也渲染**，点击只会被守卫弹回 | 按路由决定是否显示 |
| 15 | 同一个 `Device` 类型重复定义 3 处，`Features` 与后端不同步 | 类型统一收口在 `src/types/index.ts`；`HomePage` 的 11 处 `any` 全部清除 |
| 16 | 无任何测试 | `server/scripts/smoke-test.mjs`：162 项断言，覆盖认证/越权/指令闭环/后台权限 |
| 17 | 无运营侧能力（客服无法定位问题、无法处置违规账号） | 新增 `/admin` 管理后台：10 个页面、操作审计、角色分权 |
| 18 | 设计系统 token 把品牌主色覆盖成近黑色，`<Button>` 默认渲染成黑底 | `--primary` 改回微信绿 `#07c160`，家长端各处不再需要硬编码颜色绕过 |

---

## 功能状态

**每个功能到底实现了没有、孩子端有没有真正执行**，见
[`docs/FEATURE-STATUS.md`](docs/FEATURE-STATUS.md) —— 那里有一张三端对照的总表，
并单独列出「只存不用 / 未实现」的功能（网址拦截、应用限制、应用审核、
局数预算的设备端兜底、环境监听等）。

**家长端有哪些功能、分布在哪一页、为什么这样布局**，见
[`docs/PARENT-UX.md`](docs/PARENT-UX.md) —— 功能地图、六条布局原则、
六种交互模式、开关与门禁对照表，以及改文案时必须避开的 e2e 断言锚点。

## 验证方式

```bash
# 后端：162 项端到端断言（认证、越权、隔离、指令队列闭环、后台权限与审计）
npm run server:smoke

# 前后端类型与规范
npm run build && npm run lint
npm run server:typecheck && npm --prefix server run lint
```

浏览器端到端测试（默认打 2727 的 `vite preview`，所以先 `npm run preview:all`；
想打开发服务器则加 `APP_URL=http://localhost:5173` 并在跑 `npm run dev:all`）：

```bash
npm run e2e           # 家长端 46 项 + 管理后台 48 项
npm run e2e:ux        # 家长端 UX 122 项（首次引导、功能提示、英文界面、登录态健壮性）
npm run e2e:responsive  # 5 档视口 × 20 个页面（需先调大 RATE_LIMIT_MAX，见 server/.env.example）
```

孩子设备端与屏幕洞察（需要一台模拟器/真机，以及跑着的后端）：

```bash
npm run android:e2e          # Agent 协议闭环、锁定、保活、重启安全阀等 83 项
npm run android:e2e:screen   # 截屏采集→上传→AI 分析→锁定复核（21 项）
npm run android:e2e:mode     # 学习模式拦截 / 护眼 / 插件下发（23 项，真实模拟器）
npm run server:e2e:insights  # 后端侧屏幕洞察全链路（28 项）
npm run server:e2e:ai        # AI 分析全链路（对着假视觉服务，28 项）
npm run server:e2e:mode      # 模式 / 护眼 / 插件管控后端全链路（64 项）
```

`npm run android:crosstest` 现在覆盖三件事：作息求值（2016 点）、
模式求值（3024 点）、以及学习模式/插件判定的边界用例（16 项）。

Android 端的作息求值实现与后端 `evaluateSchedule` 做过逐点交叉验证
（`npm run android:crosstest`，2016 个采样点零差异）。

它用 CDP 直接驱动无头 Chrome（不依赖 playwright/puppeteer），真实点击、真实登录、
真实读写接口，覆盖：登录与鉴权守卫、真实数据渲染、功能开关的增删、深层路由刷新、
后台的角色权限差异，并检查全程无 console error / 页面异常。
Chrome 路径可用 `CHROME_PATH` 覆盖。

也可以手动体验管理后台：

1. 打开 http://localhost:2727/admin （`vite preview`，见上文），用 `admin` / `balloon-admin-2026` 登录；
2. 用 `operator` 登录对比权限差异 —— 侧栏不会出现「管理员」菜单，
   直接访问 `/admin/admins` 会被弹回看板。

冒烟测试产生的临时账号可用 `APPLY=1 npm run db:clean` 清理，
再用 `npm run db:seed` 恢复干净的演示数据。

冒烟测试自带一台「模拟设备」，会真实走完
**设备注册 → 家长绑定 → 下发锁屏 → 设备长轮询领取 → 回报结果 → 状态落地 → 失败回滚** 的全过程。

想用交互方式体验，另开一个终端：

```bash
cd server && npm run agent:example
```

它会打印一个绑定码；在家长端「设备管理」里输入该码完成认领，然后点首页的锁屏或拍照，
就能看到指令被领取、执行、回报的完整链路。

---

## 品牌标识

家长端、管理后台、孩子端三处用**同一个**标识（绿底 + 白盾牌 + 绿爪印）：**以孩子端的启动图标为准**，
即 `android/app/src/main/res/drawable/ic_launcher.xml`（viewBox 108×108、底色 `#07C160`）。

改图标时要一起改这四处，它们是同一份画稿的四份拷贝：

| 文件 | 用在哪 |
| --- | --- |
| `android/app/src/main/res/drawable/ic_launcher.xml` | 孩子端桌面图标、锁屏页（**权威来源**） |
| `src/components/BrandLogo.tsx` | 家长端侧栏 / 登录页 / 无设备页、后台侧栏 / 登录页 |
| `public/logo.svg` | 两个入口 HTML 的 favicon（比组件多一个 `rx`：网页图标没有 CSS 可用） |
| `public/apple-touch-icon.png`、`public/logo-512.png` | iOS 加到主屏 / PWA 图标（iOS 不支持 SVG，用 `rsvg-convert` 从方形版 SVG 生成） |

原来家长端是五处各画各的 emoji（🐕 三处、🐶 一处、「狗」字一处），emoji 的实际字形由系统字体决定，
换台设备就变样，所以统一成了矢量。

---

## 浏览器支持

Chrome（最新版）、Safari（iOS 最新版）、微信内置浏览器及其它现代浏览器。

## 许可

MIT · © 2026 气球狗 - 孩子的守护者
