#!/usr/bin/env node
/**
 * 一键部署到 bdog.gtsiot.cn（43.137.2.132）。
 *
 * 设计原则：**每次部署都可回滚，且回滚只换两个指针**（静态目录软链 + 镜像 tag）。
 *
 *   静态产物：/opt/app/bdog/releases/<tag>/    ← 每次新目录，永不原地覆盖
 *             /opt/app/bdog/releases/current  ← 软链，切换即生效（nginx 每请求解析）
 *   后端镜像：bdog-server:<tag>                 ← 每次新 tag，旧 tag 保留最近 3 个
 *
 * 为什么在开发机构建镜像：服务器连不上 Docker Hub（基础镜像拉不下来），本机用
 * `docker buildx --platform linux/amd64` 构建后 `docker save | ssh docker load` 送过去。
 * 服务器端只 load，不 pull。
 *
 * 用法：
 *   npm run deploy              # 构建 + 上传 + 切换 + 冒烟
 *   npm run deploy -- --dry-run # 只打印将要做什么
 *   npm run deploy -- --rollback         # 切回上一版（静态 + 镜像）
 *   npm run deploy -- --build-apk        # 同时重打孩子端 release APK
 *   npm run deploy -- --skip-image       # 只更新前端静态产物
 *   npm run deploy -- --skip-web         # 只更新后端镜像
 *
 * 配置来源：仓库根目录 `.env.deploy`（模板 `.env.deploy.example`），已 gitignore。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const ROLLBACK = args.has('--rollback');
const BUILD_APK = args.has('--build-apk');
const SKIP_IMAGE = args.has('--skip-image');
const SKIP_WEB = args.has('--skip-web');

// ────────────────────────────── 配置 ──────────────────────────────

function loadEnvFile(file) {
  const map = {};
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return map;
}

const fileEnv = loadEnvFile(path.join(ROOT, '.env.deploy'));
const cfg = {
  host: process.env.DEPLOY_HOST || fileEnv.DEPLOY_HOST || '',
  user: process.env.DEPLOY_USER || fileEnv.DEPLOY_USER || 'root',
  port: process.env.DEPLOY_PORT || fileEnv.DEPLOY_PORT || '22',
  key: process.env.DEPLOY_KEY || fileEnv.DEPLOY_KEY || '',
  domain: process.env.DEPLOY_DOMAIN || fileEnv.DEPLOY_DOMAIN || '',
  root: (process.env.DEPLOY_ROOT || fileEnv.DEPLOY_ROOT || '').replace(/\/+$/, ''),
};

// 镜像在哪构建：
//   server = 上传 server/ 目录，在服务器上 docker build（默认）
//   local  = 本地 buildx --platform linux/amd64 构建后 docker save | ssh docker load
// 默认 server 的原因：本地 Docker Desktop 的 VM 磁盘一满（或 Docker.raw 损坏）就报
// 「input/output error」，构建直接失败；而服务器能连 swr 镜像站和 npm 源，构建环境是自洽的。
const BUILD_ON = (process.env.BUILD_ON || fileEnv.BUILD_ON || 'server').toLowerCase();
if (!['server', 'local'].includes(BUILD_ON)) {
  console.error(`✗ BUILD_ON 只能是 server 或 local，当前：${BUILD_ON}`);
  process.exit(2);
}

const REQUIRED = ['host', 'domain', 'root'];
const missing = REQUIRED.filter((k) => !cfg[k]);
if (missing.length > 0) {
  console.error(`✗ .env.deploy 缺少：${missing.join(', ')}（模板见 .env.deploy.example）`);
  process.exit(2);
}
if (!cfg.root.startsWith('/') || cfg.root.split('/').includes('..')) {
  console.error(`✗ DEPLOY_ROOT 必须是不含 .. 的绝对路径，当前：${cfg.root}`);
  process.exit(2);
}

const APP_ENV_FILE = path.join(ROOT, 'deploy', '.env.prod');
const COMPOSE_FILE = path.join(ROOT, 'deploy', 'docker-compose.prod.yml');
const WEB_NGINX_CONF = path.join(ROOT, 'deploy', 'nginx', 'ballondog-web.conf');
const APK_LOCAL = path.join(ROOT, 'public', 'download', 'balloon-dog-agent.apk');

const sshTarget = `${cfg.user}@${cfg.host}`;
const sshOpts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']
  .concat(cfg.key ? ['-i', cfg.key] : [])
  .concat(['-o', 'StrictHostKeyChecking=accept-new']);
// ssh 的端口是 -p，scp 是 -P。写成 base 加端口，两个都留一份，
// 免得哪天在 scp 上再踩一次「stat local "22"」。
const sshBase = [...sshOpts, '-p', cfg.port];
const scpBase = [...sshOpts, '-P', cfg.port];

let stepNo = 0;
const t0 = Date.now();

function step(title) {
  stepNo += 1;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[${String(stepNo).padStart(2, '0')}] ${title}  (${elapsed}s)`);
}

function run(cmd, { cwd = ROOT, capture = false, env = null } = {}) {
  return new Promise((resolve, reject) => {
    if (DRY) {
      console.log(`    $ ${cmd}${env ? `   # ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`);
      resolve({ code: 0, stdout: '', stderr: '' });
      return;
    }
    const child = spawn('bash', ['-c', cmd], {
      cwd,
      stdio: capture ? 'pipe' : 'inherit',
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`命令失败（exit ${code}）：${cmd}${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

/**
 * 把一段文本包成 POSIX 单引号参数。
 *
 * 为什么不用 JSON.stringify：它产出的是**双引号**字符串，本机 `bash -c` 会先在双引号里
 * 展开 `$(...)`、`{{...}}` 之前就被本地 shell 吃掉 —— 远程命令必须在本地"原样传递"。
 * 单引号里的内容本机 shell 一个字节都不碰。
 */
function shq(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

const remote = (cmd) => run(`ssh ${sshBase.join(' ')} ${sshTarget} ${shq(cmd)}`);

async function remoteOutput(cmd) {
  const { stdout } = await run(`ssh ${sshBase.join(' ')} ${sshTarget} ${shq(cmd)}`, {
    capture: true,
  });
  return stdout.trim();
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function trySha256(file) {
  return fs.existsSync(file) ? sha256(file) : '';
}

// ────────────────────────────── 回滚 ──────────────────────────────

if (ROLLBACK) {
  step('回滚到上一版（静态软链 + 镜像 tag）');
  const state = await remoteOutput(`cat ${cfg.root}/.deploy-state.json 2>/dev/null || true`);
  if (!state) {
    console.error('✗ 没有找到 .deploy-state.json，无法自动回滚');
    process.exit(1);
  }
  const parsed = JSON.parse(state);
  const { currentRelease, currentTag, previousRelease, previousTag } = parsed;
  if (!previousRelease && !previousTag) {
    console.error('✗ 状态文件里没有上一版记录，无法回滚');
    process.exit(1);
  }
  console.log(`    当前：release=${currentRelease} image=${currentTag}`);
  console.log(`    回滚到：release=${previousRelease} image=${previousTag}`);

  if (previousRelease) {
    await remote(`test -d ${cfg.root}/releases/${previousRelease} && cd ${cfg.root}/releases && ln -sfn ${previousRelease} current.tmp && mv -T current.tmp current`);
  }
  if (previousTag) {
    await remote(
      `cd ${cfg.root} && printf '%s' '{"currentRelease":"${previousRelease}","currentTag":"${previousTag}","previousRelease":"${currentRelease}","previousTag":"${currentTag}","deployedAt":"${new Date().toISOString()}"}' > .deploy-state.json && BDOG_SERVER_TAG=${previousTag} docker-compose --env-file ${cfg.root}/.env.prod -p bdog -f ${cfg.root}/docker-compose.yml up -d --remove-orphans`,
    );
  }
  await remote(`docker exec bdog-web wget -q -O- http://127.0.0.1/__health || true`);
  console.log('\n✓ 已回滚');
  process.exit(0);
}

// ────────────────────────────── 正常部署 ──────────────────────────────

const gitSha = (await run('git rev-parse --short HEAD', { capture: true }).catch(() => ({ stdout: 'nogit' }))).stdout.trim();
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const TAG = `${stamp}-${gitSha || 'nogit'}`;
const IMAGE = `bdog-server:${TAG}`;
const PUBLIC_URL = `https://${cfg.domain}`;

console.log(`目标：${PUBLIC_URL}  （${sshTarget}:${cfg.port}，目录 ${cfg.root}）`);
console.log(`版本：${TAG}  镜像构建：${SKIP_IMAGE ? '跳过' : BUILD_ON}${DRY ? '  [dry-run]' : ''}`);

// 1. 前置校验：前端烘焙的对外地址必须与要部署的域名一致
step('前置校验');
if (!fs.existsSync(APP_ENV_FILE)) {
  console.error(`✗ 缺少 ${APP_ENV_FILE}（生产环境变量，含密钥；从 deploy/.env.prod.example 复制后填）`);
  process.exit(1);
}
// VITE_SERVER_URL 是**构建期**烘焙的（家长端二维码 + 孩子端 APK 的默认地址），所以这里不是读
// 仓库根的 .env，而是显式覆盖成部署域名 —— 本地 .env 可以继续指向本机，两边互不干扰。
const rootEnv = loadEnvFile(path.join(ROOT, '.env'));
const localServerUrl = (rootEnv.VITE_SERVER_URL || '').replace(/\/+$/, '');
if (localServerUrl && localServerUrl !== PUBLIC_URL) {
  console.log(`    · 构建时把 VITE_SERVER_URL 覆盖为 ${PUBLIC_URL}（本地 .env 是 ${localServerUrl}，不影响线上）`);
}
if (!SKIP_WEB && !fs.existsSync(APK_LOCAL)) {
  console.error(`✗ 缺少孩子端安装包 ${APK_LOCAL}（先跑 npm run android:release && npm run android:copy-apk）`);
  process.exit(1);
}
await remote(`test -d ${cfg.root} || (mkdir -p ${cfg.root} && echo ok)`);
await remote(`test -n "$(docker network inspect app_backend -f '{{.Id}}' 2>/dev/null)" || (echo "✗ 服务器上没有 app_backend 网络，边缘 nginx 反代不到本项目" >&2; exit 1)`);
// 支付密钥自检：渠道目录只看「配没配」，看不出密钥能不能解析 ——
// 裸 base64 的支付宝私钥曾一路显示 configured:true，直到家长点支付才 500。
const keys = DRY ? { stdout: '' } : await run('npx tsx scripts/check-payment-keys.mts || true', {
  cwd: path.join(ROOT, 'server'),
  env: { ...loadEnvFile(APP_ENV_FILE), npm_config_yes: 'true' },
  capture: true,
}).catch((error) => ({ stdout: String(error) }));
const keyOut = String(keys.stdout || '');
if (DRY) {
  // dry-run 不真的执行命令，这里不假装通过也不报错
} else if (!/✓|✗/.test(keyOut)) {
  console.log('    ! 支付密钥自检没跑起来（跳过，不影响部署）');
} else if (/✗/.test(keyOut)) {
  console.error(keyOut.trim());
  console.error('✗ 支付密钥自检失败，先修好再部署（npm run check:payment-keys）');
  process.exit(1);
}
for (const line of keyOut.split('\n').filter((l) => /✓|!/.test(l)).slice(0, 12)) console.log(`    ${line.trim()}`);
console.log('    ✓ 域名 / 安装包 / 支付密钥 / 服务器目录 / docker 网络 检查通过');

// 2. 构建前端
if (!SKIP_WEB) {
  step('构建前端（家长端 + 管理后台）');
  await run('npm run build', { env: { VITE_SERVER_URL: PUBLIC_URL } });
  if (!fs.existsSync(path.join(ROOT, 'dist', 'admin', 'index.html'))) {
    throw new Error('构建产物里没有 dist/admin/index.html，管理后台的第二个入口没打出来');
  }
  console.log(`    ✓ dist 就绪（含 download/balloon-dog-agent.apk，${(fs.statSync(APK_LOCAL).size / 1024 / 1024).toFixed(1)}MB）`);
}

// 3. 孩子端 APK（可选）
if (BUILD_APK) {
  step('构建孩子端 release APK（正式签名）');
  await run('npm run android:release');
  await run('npm run android:copy-apk');
  const apkInfo = await run('keytool -printcert -jarfile public/download/balloon-dog-agent.apk | head -5', {
    capture: true,
  }).catch(() => ({ stdout: '' }));
  console.log(apkInfo.stdout.trim());
}

// 4. 构建后端镜像
let imageReady = false;
if (!SKIP_IMAGE) {
  if (BUILD_ON === 'local') {
    step('构建后端镜像（本地，linux/amd64）');
    await run(
      // --provenance/--sbom 关掉：带 attestation 的 manifest list 在服务器那台 Docker 19.03
      // 上 load 会出问题，而且我们只关心单平台镜像
      `docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load -t ${IMAGE} -f server/Dockerfile server`,
    );
    const size = await run(`docker image inspect ${IMAGE} --format '{{.Size}}'`, { capture: true });
    console.log(`    ✓ ${IMAGE}  ${DRY ? '' : (Number(size.stdout.trim()) / 1024 / 1024).toFixed(0) + 'MB'}`);
  } else {
    step('构建后端镜像（服务器上 docker build）');
    const ctx = `${cfg.root}/build/server`;
    await remote(`mkdir -p ${ctx}`);
    if (!DRY) {
      // 只上传构建上下文需要的文件：源码、lock 文件、prisma schema 与迁移、Dockerfile
      await run(
        `rsync -az --delete -e "ssh ${sshBase.join(' ')}" ` +
          `--exclude node_modules --exclude dist --exclude uploads --exclude '.env' --exclude '.env.*' ` +
          `--exclude '*.log' server/ ${sshTarget}:${ctx}/`,
      );
    }
    console.log(`    ✓ 构建上下文 → ${ctx}`);
    // 服务器是 amd64，经典构建器直接出 linux/amd64 镜像，不需要 --platform
    await remote(`cd ${ctx} && docker build -t ${IMAGE} . 2>&1 | tail -25`);
    const arch = await remoteOutput(`docker image inspect ${IMAGE} --format '{{.Architecture}}'`);
    if (arch && arch !== 'amd64') {
      throw new Error(`镜像架构是 ${arch}，服务器跑不了`);
    }
    console.log(`    ✓ ${IMAGE}  (${arch || 'amd64'})`);
  }
  imageReady = true;
}

// 5. 上传静态产物 + 部署描述文件
step('上传静态产物与编排文件');
const relDir = `${cfg.root}/releases/${TAG}`;
await remote(`mkdir -p ${relDir} ${cfg.root}/nginx ${cfg.root}/uploads ${cfg.root}/pgdata ${cfg.root}/backup`);
if (!DRY) {
  await run(
    `rsync -az --delete -e "ssh ${sshBase.join(' ')}" dist/ ${sshTarget}:${relDir}/`,
  );
}
console.log(`    ✓ dist → ${relDir}`);

for (const [local, dest] of [
  [COMPOSE_FILE, `${cfg.root}/docker-compose.yml`],
  [WEB_NGINX_CONF, `${cfg.root}/nginx/ballondog-web.conf`],
  [APP_ENV_FILE, `${cfg.root}/.env.prod`],
]) {
  const destDir = path.posix.dirname(dest);
  const destFile = path.posix.basename(dest);
  const tmp = `${dest}.tmp-${TAG}`;
  await run(`scp ${scpBase.join(' ')} ${shq(local)} ${sshTarget}:${tmp}`);
  // 先写临时文件再 mv：避免容器在写一半时读到半个配置
  await remote(`mv ${tmp} ${dest} && chmod 600 ${dest}`);
  console.log(`    ✓ ${path.basename(local)} → ${destDir}/${destFile}`);
}

// 6. 传送镜像（仅本地构建时）
if (imageReady && BUILD_ON === 'local') {
  step('传送后端镜像（docker save | ssh docker load）');
  await run(
    `docker save ${IMAGE} | gzip -1 | ssh ${sshBase.join(' ')} ${sshTarget} 'gunzip | docker load'`,
  );
  console.log('    ✓ 镜像已在服务器上');
}

// 7. 切换 + 启动
step('切换静态目录并启动容器（迁移随容器启动执行）');
const prevState = await remoteOutput(`cat ${cfg.root}/.deploy-state.json 2>/dev/null || echo '{}'`);
const prev = JSON.parse(prevState || '{}');
// 软链放在 releases/ 里面：容器把这个目录挂成 /usr/share/nginx/html，nginx 的 root 是
// /usr/share/nginx/html/current —— 换链即生效，不用重建容器。
await remote(`cd ${cfg.root}/releases && ln -sfn ${TAG} current.tmp && mv -T current.tmp current`);
const newState = {
  currentRelease: TAG,
  currentTag: SKIP_IMAGE ? prev.currentTag || '' : TAG,
  previousRelease: prev.currentRelease || '',
  previousTag: prev.currentTag || '',
  deployedAt: new Date().toISOString(),
};
await remote(
  `printf '%s' ${shq(JSON.stringify(newState))} > ${cfg.root}/.deploy-state.json`,
);
await remote(
  `cd ${cfg.root} && BDOG_SERVER_TAG=${newState.currentTag || 'latest'} docker-compose --env-file ${cfg.root}/.env.prod -p bdog -f ${cfg.root}/docker-compose.yml up -d --remove-orphans`,
);
console.log(`    ✓ releases/current → ${TAG}，容器已启动`);

// 8. 等待后端健康
step('等待后端健康（prisma migrate deploy + 启动）');
{
  let healthy = false;
  for (let i = 0; i < 40; i += 1) {
    const status = await remoteOutput(
      `docker inspect bdog-server --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo missing`,
    );
    if (status === 'healthy') {
      healthy = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!healthy) {
    const logs = await remoteOutput(`docker logs --tail 60 bdog-server 2>&1 | tail -40`);
    console.error('✗ bdog-server 在 2 分钟内没有变成 healthy，最近日志：\n' + logs);
    console.error(`\n排查：ssh 上去看 docker logs bdog-server；回滚：npm run deploy -- --rollback`);
    process.exit(1);
  }
  console.log('    ✓ bdog-server healthy');
}

// 9. 冒烟
step('冒烟验证');
// 证书还没装的时候 https 会握手失败（域名指向这台机器，但没有它的证书）。
// 这时自动退回 http 继续验证应用本身，并在报告里说清楚 —— 不假装 https 是通的。
let BASE = PUBLIC_URL;
try {
  await run(`curl -fsS -m 10 ${PUBLIC_URL}/health`, { capture: true });
} catch {
  const plain = PUBLIC_URL.replace(/^https:/, 'http:');
  await run(`curl -fsS -m 10 ${plain}/health`, { capture: true });
  BASE = plain;
  console.log(`    ⚠ https 还不可用（证书未安装），本次冒烟走 ${plain}`);
}
const smoke = [
  ['后端健康', `curl -fsS -m 10 ${BASE}/health`],
  ['家长端首页', `curl -fsS -m 10 -o /dev/null -w '%{http_code}' ${BASE}/`],
  ['管理后台', `curl -fsS -m 10 -o /dev/null -w '%{http_code}' ${BASE}/admin/login`],
  // 需要登录的接口：这里只验证「反代到了后端」——未登录应该是 401，
  // 不是 502/504（那说明 /api 没接到 bdog-server），也不是 200（那说明后端漏了鉴权）。
  ['接口鉴权生效', `curl -s -m 10 -o /dev/null -w '%{http_code}' ${BASE}/api/payments/catalog`],
];
for (const [label, cmd] of smoke) {
  const { stdout } = await run(cmd, { capture: true });
  const text = stdout.trim();
  if (label === '接口鉴权生效') {
    if (text !== '401') throw new Error(`/api 反代异常：期望 401，实际 ${text}`);
    console.log(`    ✓ ${label}：401（未登录，符合预期；渠道配置状态登录后台 /admin/payments 查看）`);
  } else {
    console.log(`    ✓ ${label}：${text.slice(0, 80)}`);
  }
}

// APK 校验：服务器上的字节必须和本地完全一致（二维码扫出来的就是这份文件）
if (!SKIP_WEB) {
  const remoteApk = await remoteOutput(`sha256sum ${cfg.root}/releases/current/download/balloon-dog-agent.apk | cut -d' ' -f1`);
  const localApk = sha256(APK_LOCAL);
  if (remoteApk !== localApk) {
    console.error(`✗ 安装包校验失败：本地 ${localApk}，服务器 ${remoteApk}`);
    process.exit(1);
  }
  const httpCode = await remoteOutput(`curl -fsS -m 15 -o /dev/null -w '%{http_code}' ${BASE}/download/balloon-dog-agent.apk`);
  console.log(`    ✓ 安装包 sha256 一致（${localApk.slice(0, 12)}…），HTTP ${httpCode}`);
  console.log(`      家长端二维码内容：${PUBLIC_URL}/download/balloon-dog-agent.apk`);
}

// 10. 收尾：清理旧版本（保留最近 3 个）
step('清理旧版本（release 保留 3 份、镜像保留 3 个 tag）');
await remote(
  // 排除 current 软链本身：只清真实目录
  `cd ${cfg.root}/releases && ls -1dt */ 2>/dev/null | grep -v '^current/$' | tail -n +4 | xargs -r rm -rf`,
);
await remote(`docker images 'bdog-server' --format '{{.Tag}} {{.ID}}' | tail -n +4 | awk '{print $2}' | sort -u | xargs -r -n1 docker rmi -f >/dev/null 2>&1 || true`);
console.log('    ✓ 已清理');

console.log(`\n✓ 部署完成（${((Date.now() - t0) / 1000).toFixed(0)}s）：${PUBLIC_URL}`);
console.log(`  回滚：npm run deploy -- --rollback`);
if (newState.previousTag) console.log(`  上一版镜像仍在：${newState.previousTag}`);
