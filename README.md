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

# 3) 同时启动前后端
npm run dev:all
```

- 家长端：http://localhost:5173 （`/api` 自动代理到后端 4000）
- 管理后台：http://localhost:5173/admin
- 后端：http://localhost:4000

| 入口 | 演示账号 |
| --- | --- |
| 家长端 | `13800138000` / `balloon123` |
| 管理后台（超级管理员） | `admin` / `balloon-admin-2026` ⚠️ 上线前必须修改 |
| 管理后台（运营，权限受限） | `operator` / `balloon-operator-2026` |

也可以分开跑：

```bash
npm run server:dev      # 只起后端
npm run dev             # 只起前端
```

---

## 全部命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run build` | TypeScript 类型检查 + 生产构建 |
| `npm run lint` | ESLint 检查前端 |
| `npm run preview` | 预览生产构建 |
| `npm run server:dev` | 启动后端（tsx watch） |
| `npm run server:build` | 编译后端到 `server/dist` |
| `npm run server:typecheck` | 后端类型检查 |
| `npm run server:smoke` | **后端端到端冒烟测试（158 项断言）** |
| `npm run db:clean` | 清理冒烟测试留下的临时账号与设备（先预演） |
| `npm run e2e` | **浏览器端到端测试**（家长端 + 管理后台，CDP 驱动无头 Chrome） |
| `npm run e2e:parent` / `e2e:admin` | 只跑其中一套 |
| `npm run android:build` | 构建孩子设备端 Agent 的调试 APK（见 [`android/README.md`](android/README.md)） |
| `npm run android:release` | 构建 Agent 的发布 APK |
| `npm run android:e2e` | **Agent 端到端联调**（真机/模拟器 + 真实后端：协议闭环、拍照/录音/截图、Kiosk 锁定、倒计时悬浮窗、作息时间表、最高强度档、保活） |
| `npm run android:crosstest` | **作息求值交叉验证**（Android 与后端两套实现逐点比对，2016 个采样点） |
| `npm run db:up` / `db:down` | 起停 PostgreSQL 容器 |
| `npm run db:migrate` | 执行 Prisma 迁移 |
| `npm run db:seed` | 灌入演示数据（幂等） |
| `npm run dev:all` | 前后端一起起 |

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
│  ├─ components/            # BottomNav、ErrorBoundary、shadcn/ui
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
| 管理后台（`/admin`） | ✅ 完成 | 独立管理员体系；数据看板、家长账号/设备/指令/题库管理、验证码审计、操作日志、角色分权 |

> ⚠️ 的这几项后端无法单独完成 —— 任何声称「纯服务端就能读孩子短信」的实现都是假的。
> 本仓库提供 `server/scripts/device-agent-example.mjs` 作为可运行的客户端参考实现。

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
| 16 | 无任何测试 | `server/scripts/smoke-test.mjs`：158 项断言，覆盖认证/越权/指令闭环/后台权限 |
| 17 | 无运营侧能力（客服无法定位问题、无法处置违规账号） | 新增 `/admin` 管理后台：10 个页面、操作审计、角色分权 |
| 18 | 设计系统 token 把品牌主色覆盖成近黑色，`<Button>` 默认渲染成黑底 | `--primary` 改回微信绿 `#07c160`，家长端各处不再需要硬编码颜色绕过 |

---

## 验证方式

```bash
# 后端：158 项端到端断言（认证、越权、隔离、指令队列闭环、后台权限与审计）
npm run server:smoke

# 前后端类型与规范
npm run build && npm run lint
npm run server:typecheck && npm --prefix server run lint
```

浏览器端到端测试（需要 `npm run dev:all` 已在跑）：

```bash
npm run e2e           # 家长端 25 项 + 管理后台 30 项
```

它用 CDP 直接驱动无头 Chrome（不依赖 playwright/puppeteer），真实点击、真实登录、
真实读写接口，覆盖：登录与鉴权守卫、真实数据渲染、功能开关的增删、深层路由刷新、
后台的角色权限差异，并检查全程无 console error / 页面异常。
Chrome 路径可用 `CHROME_PATH` 覆盖。

也可以手动体验管理后台：

1. 打开 http://localhost:5173/admin ，用 `admin` / `balloon-admin-2026` 登录；
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

## 浏览器支持

Chrome（最新版）、Safari（iOS 最新版）、微信内置浏览器及其它现代浏览器。

## 许可

MIT · © 2026 气球狗 - 孩子的守护者
