# 气球狗 - 孩子的守护者

孩子设备监控的移动端 Web 应用，提供丰富的设备管理、时间控制和应用监控功能。

## 功能特性

### 用户系统
- ✅ 手机号+密码登录/注册
- ✅ 手机号+验证码注册
- ✅ 微信一键登录（自动获取头像、昵称）
- ✅ 多设备管理（添加、删除、切换设备）
- ✅ 用户信息管理

### 基础功能
- 🔒 一键锁屏 - 立即锁定/解锁设备屏幕
- ⏰ 临时使用 - 授权临时使用权限，支持自定义时长
- 📅 时间规划 - 设置每日使用时长限制
- 📱 应用限制 - 限制特定应用的使用时长
- ✅ 应用审核 - 审核新安装的应用
- 🌐 网址拦截 - 拦截不良网站

### 高级功能
- 👁️ 同屏监控 - 实时查看屏幕内容
- 🤝 远程协助 - 远程操作帮助
- 📞 电话短信 - 查看通话和短信
- 📸 远程拍照 - 远程拍摄照片
- 🎤 远程录音 - 远程录制音频
- 🎥 连续录像 - 持续视频录制

### 答题解锁 🎓
- 英文单词意思选择
- 古诗填空
- 随机出题模式
- 支持根据年级教材选择题库
- 支持根据设备画面随机出题
- 答对奖励使用时长（可自定义）
- 详细的答题记录和统计分析

### 设备管理
- 查看所有已绑定设备
- 添加新设备（支持设备码绑定）
- 删除设备
- 切换当前监控设备

## 技术栈

- **框架**: React 19 + TypeScript
- **构建工具**: Vite 7
- **样式**: Tailwind CSS v4 (@tailwindcss/vite)
- **UI 组件**: shadcn/ui (Radix UI primitives)
- **路由**: react-router-dom v7
- **状态管理**: React Hooks (useState, useEffect, Context)
- **通知**: Sonner (toast)
- **图标**: lucide-react
- **Mock API**: Express + ts-node

## 项目结构

```
balloon-dog/
├── src/
│   ├── components/
│   │   ├── ui/              # shadcn/ui 组件
│   │   ├── BottomNav.tsx     # 底部导航栏
│   │   └── ...
│   ├── contexts/
│   │   └── AuthContext.tsx  # 用户认证上下文
│   ├── pages/
│   │   ├── HomePage.tsx      # 首页（设备监控）
│   │   ├── LocationPage.tsx   # 位置页面
│   │   ├── ProfilePage.tsx   # 个人中心
│   │   ├── LoginPage.tsx     # 登录/注册页
│   │   ├── DeviceManagePage.tsx  # 设备管理页
│   │   └── QuizUnlockPage.tsx    # 答题解锁页
│   ├── services/
│   │   └── api.ts           # API 服务层
│   ├── types/
│   │   └── index.ts         # TypeScript 类型定义
│   ├── lib/
│   │   └── utils.ts         # 工具函数
│   ├── App.tsx              # 主应用（路由配置）
│   └── main.tsx             # 入口文件
├── src/mock/
│   └── db.json             # Mock 数据
├── server.ts               # Express Mock API Server
├── index.html              # HTML 模板
└── package.json            # 项目配置
```

## 开发指南

### 环境要求

- Node.js 18+
- npm 或 pnpm 或 yarn

### 安装依赖

```bash
npm install
```

### 启动开发服务器

```bash
# 启动前端开发服务器（端口 5173）
npm run dev

# 启动 Mock API 服务器（端口 3000）
npm run mock-server

# 同时启动前端和 Mock 服务器
npm run dev:all
```

### 构建生产版本

```bash
npm run build
```

### 预览生产构建

```bash
npm run preview
```

### 代码检查

```bash
# ESLint 检查
npm run lint

# TypeScript 类型检查 + 构建
npm run build
```

## API 接口

### 认证相关
- `POST /api/auth/send-code` - 发送验证码
- `POST /api/auth/register` - 用户注册
- `POST /api/auth/login` - 用户登录
- `POST /api/auth/wechat-login` - 微信登录
- `POST /api/auth/logout` - 退出登录

### 用户相关
- `GET /api/user/info` - 获取用户信息
- `PUT /api/user/info` - 更新用户信息
- `GET /api/user/devices` - 获取设备列表
- `POST /api/user/devices` - 添加设备
- `DELETE /api/user/devices/:deviceId` - 删除设备
- `POST /api/user/select-device` - 切换设备

### 设备相关
- `GET /api/device` - 获取设备信息
- `POST /api/device/lock` - 锁定/解锁设备
- `POST /api/device/temp-unlock` - 临时解锁
- `POST /api/device/cancel-temp-unlock` - 取消临时解锁
- `POST /api/device/remote-photo` - 远程拍照
- `POST /api/device/start-recording` - 开始录像
- `POST /api/device/stop-recording` - 停止录像
- `POST /api/device/start-audio` - 开始录音
- `POST /api/device/stop-audio` - 停止录音

### 功能相关
- `GET /api/features` - 获取所有功能状态
- `PUT /api/features` - 切换功能开关
- `PUT /api/features/time-plan` - 设置时间规划
- `PUT /api/features/app-limit` - 设置应用限制
- `POST /api/features/app-audit` - 审核应用
- `POST /api/features/web-block` - 添加拦截网址

### 答题解锁
- `GET /api/quiz/config` - 获取答题配置
- `PUT /api/quiz/config` - 更新答题配置
- `GET /api/quiz/question` - 获取题目
- `POST /api/quiz/answer` - 提交答案
- `GET /api/quiz/records` - 获取答题记录
- `GET /api/quiz/statistics` - 获取答题统计

## 代码规范

### 命名约定
- **组件**: PascalCase (HomePage, BottomNav)
- **函数/变量**: camelCase (loadData, device)
- **常量**: PascalCase 组件常量，camelCase 其他
- **接口**: PascalCase (Device, Features)
- **文件**: PascalCase 组件，camelCase 工具

### 导入顺序
```typescript
import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Shield, Lock } from 'lucide-react'
import { api } from '@/services/api'
```

### 错误处理
- 使用 try-catch 块处理所有异步操作
- 使用 `toast.error()` 显示用户友好的错误信息
- 使用 `toast.success()` 显示成功提示
- 记录错误到控制台

## 设计规范

### 颜色方案
- **主色**: `#07c160` (微信绿)
- **成功**: 绿色
- **警告**: 橙色/黄色
- **错误**: 红色
- **中性**: 灰色

### 移动端适配
- 所有设计为移动端优先
- 使用 safe-area-inset 支持 iPhone 刘海屏
- 触摸友好的交互区域
- 横向滚动的列表项

### WeChat 风格
- 绿色主题
- 圆角卡片
- 简洁的图标
- 清晰的层级关系

## 浏览器支持

- Chrome (最新版)
- Safari (iOS 最新版)
- 微信内置浏览器
- 其他现代浏览器

## 许可证

MIT

## 版本

1.0.0

---

© 2026 气球狗 - 孩子的守护者
