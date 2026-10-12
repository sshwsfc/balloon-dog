/**
 * 词典覆盖率检查：找出「代码里有中文、但 en.ts 里没有对应词条」的洞。
 *
 * 为什么 `i18n.mjs --keys` 不够用：
 *   `--keys` 走的是「t('...') / tt('...') 的静态字符串实参」这条路，所以对
 *   `t(vendor.name)`、`t(KIND_LABEL[kind])` 这类**常量在别处、取用时才过 t()**
 *   的写法完全看不见 —— 而这些恰恰是模块级中文常量表（厂商名、状态名、档位名）
 *   的普遍形态。漏掉它们，就会出现「切换英文后页面上还剩一片中文」。
 *
 * 所以这里换一个更保守的口径：**扫描全部含中文的字符串字面量、无插值模板字面量
 * 和 JSX 文本**，逐个跟 en.ts 的 key 集合比对。口径保守意味着会有意保留少量白名单
 * （见 IGNORE），但不会漏。
 *
 * 用法：node scripts/i18n-coverage.mjs [--json <outPath>]
 *   - 退出码 1 表示还有缺口，可以直接挂到 CI 上防止回退。
 */
import ts from 'typescript'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src'
const DICT = 'src/i18n/locales/en.ts'
const HAS_ZH = /[\u4e00-\u9fff]/

/**
 * 有意不进词典的中文。
 *
 *  - 语言选择器里的标签要「自报家门」：切到英文界面时也得显示「简体中文」，
 *    翻成 "Simplified Chinese" 反而让中文用户认不出来；
 *  - useXxx 的误用报错是给开发者看的，跟终端用户选的语言无关。
 */
const IGNORE = new Set([
  '简体中文',
  '中',
  'useAuth 必须在 AuthProvider 内部使用',
  'useDevices 必须在 DeviceProvider 内部使用',
])

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.tsx?$/.test(p) && p !== DICT) files.push(p)
  }
}
walk(SRC)

// 从 en.ts 里抽 key：只认行首的 "key": 形式，够用且不会误抓 value 里的中文。
const dictSrc = readFileSync(DICT, 'utf8')
const enKeys = new Set()
for (const m of dictSrc.matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:/gm)) {
  try {
    enKeys.add(JSON.parse(m[1]))
  } catch {
    /* 解析失败的行直接忽略，不影响其余 key */
  }
}

/** 判断节点是否处在 console.* 实参里 —— 开发者日志故意保留中文。 */
const isDevLog = (node, sf) => {
  for (let p = node.parent; p && !ts.isStatement(p); p = p.parent) {
    if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText(sf))) return true
  }
  return false
}

const report = []
for (const file of files.sort()) {
  // 管理后台按设计只做中文，不进家长端词典。
  if (file.startsWith('src/admin/')) continue

  const text = readFileSync(file, 'utf8')
  // 必须按扩展名选 ScriptKind：拿 TSX 去解析 .ts 会把 `http.get<{ok:boolean}>(...)`
  // 的泛型实参当成 JSX 标签，产出一堆假的 JsxText（实测虚报 41 条）。
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)

  const hits = []
  const visit = (node) => {
    let s = null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) s = node.text
    else if (ts.isJsxText(node)) s = node.text.trim()

    if (s && HAS_ZH.test(s) && !IGNORE.has(s) && !enKeys.has(s) && !isDevLog(node, sf)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      hits.push({ line: line + 1, key: s })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (hits.length) report.push({ file, hits })
}

const total = report.reduce((n, r) => n + r.hits.length, 0)
const lines = report.map(
  ({ file, hits }) =>
    `${file}  (${hits.length})\n` + hits.map((h) => `  ${h.line}: ${h.key}`).join('\n'),
)

console.log(lines.join('\n\n'))
console.log(`\n词典缺失：${total} 条 / ${report.length} 个文件`)

const jsonFlag = process.argv.indexOf('--json')
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  const seen = new Set()
  const items = []
  for (const { file, hits } of report) {
    for (const h of hits) {
      if (seen.has(h.key)) continue
      seen.add(h.key)
      items.push({ key: h.key, line: h.line, file })
    }
  }
  writeFileSync(process.argv[jsonFlag + 1], JSON.stringify({ count: items.length, items }, null, 2))
  console.log(`去重后需补词条：${items.length} 条 → ${process.argv[jsonFlag + 1]}`)
}

process.exit(total === 0 ? 0 : 1)
