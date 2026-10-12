#!/usr/bin/env node
/**
 * i18n 工具。
 *
 * 本项目的 i18n 约定是「**中文原文就是 key**」：zh 不需要任何词条文件，
 * 查不到翻译时 i18next 直接回显 key，所以中文界面永远是对的；
 * en 只需要一份「中文 → 英文」的映射表（src/i18n/locales/en.ts）。
 *
 * 这个脚本干两件事：
 *
 *   node scripts/i18n.mjs --wrap     把 UI 里还没包 t() 的中文自动包起来
 *   node scripts/i18n.mjs --report   报告「还没包的中文」和「缺英文的词条」
 *
 * --wrap 用 TypeScript 自己的解析器（不是正则）定位中文字面量，因此不会碰到
 * 注释、类型名或非文案的代码。它只做**文本区间替换**，不重新打印 AST，
 * 所以原有格式、注释、换行都保持不动。
 *
 * 三类目标，各自的取词规则不同（见下面的 classify 注释）：
 *   - JSX 文本           → {t('...')}，并保留行内空格
 *   - 可翻译位置的字符串 → t('...')
 *   - 含插值的模板字符串 → t('...{{v0}}...', { v0: expr })
 *
 * 归属规则（决定用 hook 还是 i18n 实例，这是本脚本最关键的一处判断）：
 *   - 往上找最近的「可挂钩函数」（组件 = 大写开头，或 useXxx）：用 t()，并给它插入
 *     const { t } = useTranslation()
 *   - 只找到普通函数（formatDateTime / validateForm 这类模块级工具）：用 tt()，
 *     它直接读 i18n 实例 —— 普通函数不能调 hook
 *   - 模块级常量/顶层：不处理，交给 --report 报出来人工决定
 *     （常量在模块加载时就求值，包 t() 会把语言固化在启动那一刻）
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const SRC = 'src'
const I18N_MODULE = '@/i18n'

/** JSX 属性里不翻译的名字（技术属性，不是文案） */
const ATTR_DENY = new Set([
  'className', 'class', 'id', 'key', 'value', 'name', 'type', 'href', 'src', 'to',
  'role', 'target', 'rel', 'htmlFor', 'autoComplete', 'inputMode', 'pattern',
  'packageName', 'deviceCode', 'data-testid', 'strokeWidth', 'fill', 'color',
])

/** 对象属性里翻译的名字白名单（避免把接口 payload 也翻了） */
const PROP_ALLOW = new Set([
  'label', 'title', 'description', 'desc', 'subtitle', 'text', 'hint', 'tip',
  'placeholder', 'unit', 'empty', 'emptyText', 'help', 'confirmText', 'cancelText',
  'name', 'group', 'category', 'reason', 'note',
])

/** 打印 toast 的调用：第一个参数是文案 */
const TOAST_RE = /(^|\.)toast\.(error|success|info|warning|message|loading)$/
/**
 * 这些函数的**特定位置参数**是「给人看的兜底文案」，可以安全翻译。
 * toUserMessage(error, '加载失败') —— 第二个参数是兜底句，第一个是异常对象。
 */
const ARG_TEXT_RE = /(^|\.)toUserMessage$/


// ---------------------------------------------------------------- 小工具

/** 反斜杠、单引号要转义；换行必须转成 \n —— 无插值模板字符串里可以有真实换行，
 *  直接塞进单引号字符串会变成语法错误 */
const esc = (s) =>
  s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')

/** i18next 的插值语法是 {{name}}，而 JSX 属性里直接写 {{ 会被当表达式，所以用字符串拼接 */
const lit = (s) => `'${esc(s)}'`

/**
 * .ts 必须用 TS 模式解析，.tsx 才用 TSX —— 拿 TSX 去解析 .ts，
 * 泛型箭头 `get: <T>(path) => ...` 会被当成 JSX 元素的开标签，
 * 从那里一直吞到文件末尾，产出跨越大半个文件的伪 JsxText 节点。
 */
const scriptKindOf = (fileName) => (fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

function hasHan(s) {
  return typeof s === 'string' && HAN.test(s)
}

/**
 * JSX 文本的换行/缩进会被 JSX 规则吃掉，但**同一行内的空格会被保留**。
 * 所以 `已用 <b>x</b> 分钟` 这种前后空格必须显式补回来，否则渲染成「已用x分钟」。
 *
 * 注意这里只返回归一化后的词条；真正的替换是**只替换词条本身在源码里的区间**，
 * 前后空白原样留在原地 —— 这样既保住了行内空格，也不会把缩进和换行吃掉
 * （早期版本整段替换 + 手工拼 {' '}，把 `\n          狗\n        ` 压成了 `狗</span>`）。
 */
function normalizeJsxText(raw) {
  return raw.replace(/\s+/g, ' ').trim()
}

/** 取函数名字（函数声明名 / 变量名 / 属性名），用于判断是不是 React 组件 */
function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text
  const p = node.parent
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text
  return null
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  )
}

/** 组件或自定义 Hook —— 只有这类函数才能调 useTranslation() */
function isHookable(node) {
  const name = functionName(node)
  if (!name) return false
  return /^[A-Z]/.test(name) || /^use[A-Z]/.test(name)
}

// ---------------------------------------------------------------- 遍历

/**
 * 走一遍 AST，收集所有「要翻译的中文」以及它们各自归属的函数。
 * 返回 { edits, hookOwners, ttFiles, manual }
 */
function analyze(sourceFile, fileName) {
  /** 文本替换：{ pos, end, text } */
  const edits = []
  /** 需要插入 const { t } = useTranslation() 的函数节点 */
  const hookOwners = new Set()
  /** 需要用到 i18n 实例（tt）的函数节点 */
  let needsInstanceT = false
  /** 归属不到任何函数的中文（模块级），交给人工 */
  const manual = []
  let needsHookT = false

  /**
   * 这个函数体里是不是已经有 `const { t } = useTranslation()`。
   *
   * 必须有这个判断，否则二次运行会在同一函数里再插一个 hook（`t` 重复声明），
   * codemod 也就不再幂等 —— 这正是加 toUserMessage 支持时踩到的坑。
   */
  function hasHookBinding(fn) {
    const body = fn.body
    if (!body || !ts.isBlock(body)) return false
    return body.statements.some((st) => {
      if (!ts.isVariableStatement(st)) return false
      return st.declarationList.declarations.some((d) => {
        const init = d.initializer
        return (
          init !== undefined &&
          ts.isCallExpression(init) &&
          /(^|\.)useTranslation$/.test(init.expression.getText(sourceFile)) &&
          ts.isObjectBindingPattern(d.name) &&
          d.name.elements.some((el) => el.name.getText(sourceFile) === 't')
        )
      })
    })
  }

  /** 从当前位置往上找承载它的函数：优先可挂钩的，否则退回普通函数用 tt */
  function resolveOwner(node) {
    let cur = node.parent
    let fallback = null
    while (cur) {
      if (isFunctionLike(cur)) {
        if (isHookable(cur)) {
          // 已经有 t 就直接用，不再重复注入
          if (!hasHookBinding(cur)) {
            hookOwners.add(cur)
            needsHookT = true
          }
          return 't'
        }
        if (!fallback) fallback = cur
      }
      cur = cur.parent
    }
    if (fallback) {
      needsInstanceT = true
      return 'tt'
    }
    return null
  }

  /** 统一的「翻译这个字符串」入口。bareJsxAttr 表示这是 `attr="中文"` 的裸值，
   *  替换时必须补上大括号变成 `attr={t('中文')}` —— 少了它就是 aria-label=t('中文')，
   *  TypeScript 直接报 TS1145。 */
  function pushString(node, raw, quoteNode, bareJsxAttr = false) {
    if (!hasHan(raw)) return
    const mode = resolveOwner(node)
    if (!mode) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      manual.push({ fileName, line: line + 1, text: raw })
      return
    }
    const call = `${mode}(${lit(raw)})`
    edits.push({
      pos: quoteNode.getStart(sourceFile),
      end: quoteNode.getEnd(),
      text: bareJsxAttr ? `{${call}}` : call,
    })
  }

  /** 含插值的模板字符串：${x} → {{v0}} + 第二个参数 */
  function pushTemplate(node) {
    const all = [node.head, ...node.templateSpans.map((s) => s.literal)]
    if (!all.some((q) => hasHan(q.text))) return
    const mode = resolveOwner(node)
    if (!mode) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      manual.push({ fileName, line: line + 1, text: node.getText(sourceFile) })
      return
    }
    let key = all[0].text
    const spans = []
    node.templateSpans.forEach((span, i) => {
      key += `{{v${i}}}` + span.literal.text
      spans.push({
        i,
        start: span.expression.getStart(sourceFile),
        end: span.expression.getEnd(),
      })
    })
    // 替换文本延后到渲染时再拼：${} 里的表达式本身可能还含内层编辑，
    // 用原始文本直接拼会把内层结果丢掉
    edits.push({
      pos: node.getStart(sourceFile),
      end: node.getEnd(),
      kind: 'template',
      mode,
      key,
      spans,
    })
  }

  function visit(node) {
    // ---- JSX 文本 ----
    if (ts.isJsxText(node)) {
      const raw = node.text
      const value = normalizeJsxText(raw)
      if (hasHan(value)) {
        const parent = node.parent
        const tag =
          parent && ts.isJsxElement(parent) ? parent.openingElement.tagName.getText(sourceFile) : ''
        // <pre>/<code> 里的内容是示例代码，不能翻
        if (tag !== 'pre' && tag !== 'code') {
          const mode = resolveOwner(node)
          if (!mode) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            manual.push({ fileName, line: line + 1, text: value })
          } else {
            // 必须用 getFullStart()：JsxText 的 getStart() 会跳过前导空白，
            // 而 node.text 是**含**前导空白的原文，两者混用会把偏移量算多一倍，
            // 替换区间一路飘到后面的 </span> 上去（曾把 `</span>` 改成 `<{t('狗')}span>`）
            const fullStart = node.getFullStart()
            const lead = raw.length - raw.replace(/^\s+/, '').length
            const trail = raw.length - raw.replace(/\s+$/, '').length
            const inner = raw.slice(lead, raw.length - trail)
            if (/\s/.test(inner)) {
              // 词条内部有换行或连续空白 → value 已被折叠过，没法精确映射回源码区间，
              // 整段替换。这种位置不可能有有意义的行内空格，因此不用补 {' '}
              edits.push({ pos: fullStart, end: node.getEnd(), text: `{${mode}(${lit(value)})}` })
            } else {
              // 只替换词条本身，前后空白原样留在源码里 —— 行内空格天然不会丢，
              // 缩进和换行也不会被吃掉
              edits.push({
                pos: fullStart + lead,
                end: fullStart + raw.length - trail,
                text: `{${mode}(${lit(value)})}`,
              })
            }
          }
        }
      }
    }

    // ---- 模板字符串 ----
    else if (ts.isTemplateExpression(node)) {
      pushTemplate(node)
    } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      if (hasHan(node.text)) pushString(node, node.text, node)
    }

    // ---- 普通字符串 ----
    else if (ts.isStringLiteral(node)) {
      const parent = node.parent

      // JSX 属性取值有两种写法：attr="中文"（裸值，要补大括号）
      // 与 attr={'中文'}（已在表达式里，直接替换即可）
      const attrOwner = ts.isJsxAttribute(parent)
        ? parent
        : ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)
          ? parent.parent
          : null
      const bareJsxAttr = attrOwner !== null && ts.isJsxAttribute(parent)

      let translatable = false

      if (attrOwner) {
        // 属性名不在黑名单里就翻（aria-label / placeholder / title / emptyText…）
        const name = attrOwner.name.getText(sourceFile)
        translatable = !ATTR_DENY.has(name)
      } else if (ts.isCallExpression(parent)) {
        const callee = parent.expression.getText(sourceFile)
        if (TOAST_RE.test(callee)) {
          // toast.error('...') 的第一个参数
          translatable = parent.arguments[0] === node
        } else if (ARG_TEXT_RE.test(callee)) {
          // toUserMessage(error, '兜底文案') 的第二个参数
          translatable = parent.arguments[1] === node
        }
      } else if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
        const name = parent.name.getText(sourceFile).replace(/['"]/g, '')
        translatable = PROP_ALLOW.has(name)
      } else if (ts.isArrayLiteralExpression(parent) || ts.isConditionalExpression(parent)) {
        // 数组/三元里的中文字面量：项目里已确认没有把中文当逻辑值的地方（见 docs）
        translatable = true
      } else if (
        ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      ) {
        // `x || '兜底文案'` / `x ?? '兜底文案'` —— 中文只可能出现在右侧兜底位置。
        // 左侧是逻辑值，不动它。
        translatable = parent.right === node
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
        // const label = '中文' —— 只有在函数体内才安全（模块级交由人工）
        translatable = Boolean(node.parent.parent.parent && resolveOwnerKnown(node))
      } else if (ts.isReturnStatement(parent) || ts.isParenthesizedExpression(parent)) {
        translatable = true
      }

      if (translatable) pushString(node, node.text, node, bareJsxAttr)
    }

    ts.forEachChild(node, visit)
  }

  /** 只判断有没有函数祖先，不改动状态（给上面的预判用） */
  function resolveOwnerKnown(node) {
    let cur = node.parent
    while (cur) {
      if (isFunctionLike(cur)) return true
      cur = cur.parent
    }
    return false
  }

  visit(sourceFile)

  return { edits, hookOwners, needsHookT, needsInstanceT, manual }
}

// ---------------------------------------------------------------- 改写

function transform(fileName) {
  const original = fs.readFileSync(fileName, 'utf8')
  const sourceFile = ts.createSourceFile(fileName, original, ts.ScriptTarget.Latest, true, scriptKindOf(fileName))
  const { edits, hookOwners, needsHookT, needsInstanceT, manual } = analyze(sourceFile, fileName)

  if (!edits.length && !hookOwners.size) return { changed: false, manual }

  const all = [...edits]

  // 1) 需要时插入 import（放在最后一个 import 之后）—— 已有的同名导入不再重复插入
  const importedNames = new Set()
  for (const st of sourceFile.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue
    if (st.importClause.name) importedNames.add(st.importClause.name.text)
    const named = st.importClause.namedBindings
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) importedNames.add(el.name.text)
    }
  }
  const imports = sourceFile.statements.filter(ts.isImportDeclaration)
  const insertImportAt = imports.length
    ? imports[imports.length - 1].getEnd()
    : sourceFile.statements.length
      ? sourceFile.statements[0].getStart(sourceFile)
      : 0
  const importLines = []
  if (needsHookT && !importedNames.has('useTranslation')) {
    importLines.push(`import { useTranslation } from 'react-i18next'`)
  }
  if (needsInstanceT && !importedNames.has('tt')) {
    importLines.push(`import { tt } from '${I18N_MODULE}'`)
  }
  if (importLines.length) {
    all.push({ pos: insertImportAt, end: insertImportAt, text: '\n' + importLines.join('\n') })
  }

  // 2) 给每个归属函数插入 hook
  for (const fn of hookOwners) {
    const body = fn.body
    if (!body) continue
    if (ts.isBlock(body)) {
      const braceStart = body.getStart(sourceFile)
      // 缩进跟随函数体第一条语句
      const first = body.statements[0]
      const indent = first
        ? original.slice(original.lastIndexOf('\n', first.getStart(sourceFile)) + 1, first.getStart(sourceFile))
        : '  '
      all.push({
        pos: braceStart + 1,
        end: braceStart + 1,
        text: `\n${indent}const { t } = useTranslation()`,
      })
    } else {
      // 箭头函数表达式体：=> <div>中文</div>
      // 不能在其中插语句，改成块体再 return。体内容同样要在渲染时递归处理，
      // 否则里面已包好的 t() 会被原样覆盖掉
      all.push({
        pos: body.getStart(sourceFile),
        end: body.getEnd(),
        kind: 'body',
        prefix: `{\n  const { t } = useTranslation()\n  return (\n`,
        suffix: `\n  )\n}`,
      })
    }
  }

  const out = renderRange(0, original.length, all, original)

  if (out !== original) {
    fs.writeFileSync(fileName, out)
    return { changed: true, manual }
  }
  return { changed: false, manual }
}

/**
 * 按区间树渲染替换结果。
 *
 * 编辑之间可能是**嵌套**关系（模板字符串套模板字符串、箭头函数体里包 JSX、
 * 函数的 hook 插入点在所有编辑之内）。早期版本把编辑按位置从后往前直接在
 * 一个字符串上切片，非嵌套时没问题，一旦嵌套：内层先改完，外层仍然拿**原始**
 * 偏移去 `slice(end)`，而该处的字符串已经被内层撑长/缩短了 —— 切错位，
 * 于是在源码里留下 `)}` 这类残片（InsightsPage / ModeSchedulePage 都中过）。
 * 这里改成递归：外层负责把自己内部的子编辑渲染进来。
 */
function renderRange(start, end, edits, original) {
  const inside = edits
    .filter((e) => e.pos >= start && e.end <= end)
    .sort((a, b) => a.pos - b.pos || a.end - b.end)

  let out = ''
  let cursor = start
  for (const e of inside) {
    // 完全落在已渲染区间内部的（真嵌套、宽度非零）交给父编辑递归处理
    if (e.end > e.pos && e.end <= cursor) continue
    if (e.pos > cursor) {
      out += original.slice(cursor, e.pos)
      cursor = e.pos
    }
    out += renderEdit(e, edits, original)
    if (e.end > e.pos) cursor = e.end
  }
  out += original.slice(cursor, end)
  return out
}

function renderEdit(e, edits, original) {
  if (e.kind === 'template') {
    const args = e.spans.map((s) => `v${s.i}: ${renderRange(s.start, s.end, edits, original)}`)
    return `${e.mode}(${lit(e.key)}, { ${args.join(', ')} })`
  }
  if (e.kind === 'body') {
    return `${e.prefix}${renderRange(e.pos, e.end, edits, original)}${e.suffix}`
  }
  return e.text
}

// ---------------------------------------------------------------- 报告

/** 扫描还没被包进 t()/tt() 的中文（用于回归检查） */function scanUnwrapped(fileName) {
  const text = fs.readFileSync(fileName, 'utf8')
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindOf(fileName))
  const found = []

  // 模块级中文常量（`TILE_GROUPS` / `KIND_LABEL` …）里的字面量**故意**不在这里包
  // t()：模块只求值一次，在定义处翻译会把语言固化在首次加载时的语言上。它们的
  // 翻译发生在读取处（`--wrap-consts` 自动完成），所以报告要把这些定义跳过，
  // 否则永远显示一堆「无法修复」的条目，把真正漏掉的文案淹掉。
  const constDecls = new Set()
  for (const name of collectConstMaps(sourceFile).keys()) {
    for (const st of sourceFile.statements) {
      if (!ts.isVariableStatement(st)) continue
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
          constDecls.add(d.initializer)
        }
      }
    }
  }
  function visit(node) {
    // 命中 t()/tt() 就整棵子树跳过 —— 否则会继续下钻到它的字符串实参，
    // 把「已经包好的」当成「还没包的」报出来（曾经因此虚报 1377 条）
    if (ts.isCallExpression(node) && /^(t|tt|i18n\.t)$/.test(node.expression.getText(sourceFile))) return
    if (constDecls.has(node)) return
    if (ts.isJsxText(node)) {
      const v = normalizeJsxText(node.text).value
      if (hasHan(v)) found.push({ line: lineOf(node), text: v })
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (hasHan(node.text) && !ts.isImportDeclaration(node.parent)) {
        found.push({ line: lineOf(node), text: node.text })
      }
    } else if (ts.isTemplateExpression(node)) {
      const joined = node.head.text + node.templateSpans.map((s) => s.literal.text).join('')
      if (hasHan(joined)) found.push({ line: lineOf(node), text: joined })
    }
    ts.forEachChild(node, visit)
  }

  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

  visit(sourceFile)
  return found
}

/**
 * 抽出这个文件里所有 t()/tt() 的**第一个参数**（也就是中文 key）。
 * 这是生成 en.ts 词条表的依据 —— `--report` 报的是「还没包的」，
 * 而这里要的是「已经包了的」。
 * 返回 [{ key, line, snippet }]，snippet 是所在行的源码，供人工/模型判断语气。
 */
function keysOf(fileName, text) {
  const sourceFile = ts.createSourceFile(
    fileName,
    text ?? fs.readFileSync(fileName, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(fileName),
  )
  const out = []

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sourceFile)
      if (/^(t|tt|i18n\.t)$/.test(callee)) {
        const arg = node.arguments[0]
        let key = null
        if (arg && ts.isStringLiteral(arg)) key = arg.text
        else if (arg && ts.isTemplateExpression(arg)) {
          key =
            arg.head.text +
            arg.templateSpans.map((s, i) => `{{v${i}}}` + s.literal.text).join('')
        }
        if (key && hasHan(key)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          const lineText = sourceFile.text.split('\n')[line] ?? ''
          out.push({ key, line: line + 1, snippet: lineText.trim() })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return out
}

function collectFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'admin' || e.name === 'i18n' ? [] : collectFiles(p)
    return /\.(tsx|ts)$/.test(e.name) ? [p] : []
  })
}

/** 从 en.ts 里抠出所有 key（形如 '中文': 'English'） */
function englishKeys() {
  const file = 'src/i18n/locales/en.ts'
  if (!fs.existsSync(file)) return new Set()
  const text = fs.readFileSync(file, 'utf8')
  const keys = new Set()
  const re = /^\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")\s*:/gm
  let m
  while ((m = re.exec(text))) {
    const raw = m[1] ?? m[2]
    keys.add(raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
  }
  return keys
}

// ------------------------------------------- 模块级常量：改到「使用处」包 t()

/**
 * 模块级常量（`const KIND_LABEL = { photo: '照片' }`）**不能**在定义处包 `t()`：
 * 模块只求值一次，包了就等于把语言固化在首次加载时的语言上，之后切换语言不会更新。
 *
 * 正确做法是让常量继续存中文（中文即 key），在**读取它的地方**过 `t()`。
 * 这个 pass 自动找出「读出来是中文」的成员访问并在外面套一层 `t(...)`：
 *   - 整张表都是中文值（`{ photo: '照片' }` / `['日','一']`）→ 包住 `C[...]` / `C.x`
 *   - 只有具名字段是中文（`{ low: { label: '低风险' } }`）→ 只包 `C[...].label`
 * 数值/样式字段（`.min` / `.className`）不会被误包。
 */
function wrapConstAccess(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, scriptKindOf(fileName), true)
  const consts = collectConstMaps(sf)
  if (!consts.size) return { changed: false, text, stats: [] }

  // 文件内所有「取出来是中文」的字段名并集。
  const fieldNames = new Set()
  for (const info of consts.values()) for (const f of info.fields) fieldNames.add(f)

  // ── 污点分析：只有「根标识符能追溯到这些中文常量」的成员访问才敢包 ──
  // 不能只按字段名匹配，否则 `form.name`（家长自己敲的规则名）、`device.name`
  // （设备名）这类运行期字符串也会被包上 t()——虽然 i18next 查不到 key 会原样
  // 返回、运行时无害，但语义是错的，将来一旦有词条撞名就会把用户内容翻掉。
  // 传播规则：常量名 → `const x = <含污点表达式>` 的 x → `<污点>.map((p) => ...)` 的 p。
  const ITER_METHODS = new Set([
    'map', 'filter', 'forEach', 'find', 'some', 'every', 'reduce', 'flatMap', 'sort',
  ])
  const tainted = new Set(consts.keys())

  /** 收集一棵子树里「作为值被引用」的标识符（跳过属性名/键名/声明名） */
  function referencedNames(node, acc) {
    const n = node
    if (ts.isIdentifier(n)) {
      acc.add(n.text)
      return acc
    }
    if (ts.isPropertyAccessExpression(n)) {
      referencedNames(n.expression, acc)
      return acc
    }
    if (ts.isPropertyAssignment(n)) {
      referencedNames(n.initializer, acc)
      return acc
    }
    if (ts.isVariableDeclaration(n)) {
      if (n.initializer) referencedNames(n.initializer, acc)
      return acc
    }
    if (ts.isBindingElement(n)) {
      if (n.initializer) referencedNames(n.initializer, acc)
      return acc
    }
    // 注意别把 referencedNames 的返回值透出去：ts.forEachChild 把「回调返回
    // 真值」当成「停止遍历」，写成 `(c) => referencedNames(c, acc)` 会在第一个
    // 子节点之后就收工 —— `mode ? MODE_META[x] : null` 只会收集到 `mode`。
    ts.forEachChild(n, (c) => {
      referencedNames(c, acc)
    })
    return acc
  }

  const anyTainted = (node) => {
    for (const name of referencedNames(node, new Set())) if (tainted.has(name)) return true
    return false
  }

  for (let round = 0; round < 10; round++) {
    let grew = false
    const add = (name) => {
      if (!tainted.has(name)) {
        tainted.add(name)
        grew = true
      }
    }
    const sweep = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (anyTainted(node.initializer)) add(node.name.text)
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        if (
          ts.isPropertyAccessExpression(callee) &&
          ITER_METHODS.has(callee.name.text) &&
          anyTainted(callee.expression)
        ) {
          for (const arg of node.arguments) {
            if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
              for (const p of arg.parameters) if (ts.isIdentifier(p.name)) add(p.name.text)
            }
          }
        }
      }
      ts.forEachChild(node, sweep)
    }
    sweep(sf)
    if (!grew) break
  }

  const edits = []
  const perConst = new Map()

  // `t` 只在挂着 useTranslation() 的函数里存在；模块级工具函数里没有 hook，
  // 只能退化成 `tt`（读全局 i18n 实例）。AppShell 订阅了 languageChanged 并整树
  // 重渲，所以 `tt` 的结果也会随语言切换刷新。
  const isFunctionLike = (n) =>
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n)

  const hookScopes = new Set()
  const harvestHooks = (n) => {
    if (isFunctionLike(n) && n.body && ts.isBlock(n.body)) {
      const has = n.body.statements.some((st) => {
        if (!ts.isVariableStatement(st)) return false
        return st.declarationList.declarations.some((d) => {
          const init = d.initializer
          return (
            init !== undefined &&
            ts.isCallExpression(init) &&
            /(^|\.)useTranslation$/.test(init.expression.getText(sf)) &&
            ts.isObjectBindingPattern(d.name) &&
            d.name.elements.some((el) => el.name.getText(sf) === 't')
          )
        })
      })
      if (has) hookScopes.add(n)
    }
    ts.forEachChild(n, harvestHooks)
  }
  harvestHooks(sf)

  // 往上找：只要**任何**外层函数挂着 useTranslation()，`t` 就在闭包里可用；
  // 一路到文件顶层都没有，才退回 `tt`。
  const ownerCall = (node) => {
    let cur = node.parent
    while (cur) {
      if (isFunctionLike(cur) && hookScopes.has(cur)) return 't'
      cur = cur.parent
    }
    return 'tt'
  }

  function chainRoot(node) {
    let cur = node
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression
    }
    return ts.isIdentifier(cur) ? cur : null
  }

  // 只检查「直接父节点是不是 t()/tt()」是不够的：`t(day.label.slice(1))` 里
  // day.label 的父节点是 `day.label.slice(1)`，于是会被再包一层变成
  // `t(t(day.label).slice(1))` —— 内层已经翻成 "Monday"，外层再拿 "Monday"
  // 当 key 查不到，看着无害，但语义重复且极易误导后续维护。所以要沿祖先链
  // 往上找，只要该节点整个落在某个 t()/tt()/i18n.t() 的实参里就跳过。
  function alreadyWrapped(node) {
    let parent = node.parent
    while (parent) {
      if (
        ts.isCallExpression(parent) &&
        /^(t|tt|i18n\.t)$/.test(parent.expression.getText(sf)) &&
        parent.arguments.some((a) => a.pos <= node.pos && a.end >= node.end)
      ) {
        return true
      }
      // 走到 JSX 表达式 / 语句 / 变量声明就是另一个求值单元了，停。
      if (
        ts.isJsxExpression(parent) ||
        ts.isStatement(parent) ||
        ts.isVariableDeclaration(parent)
      ) {
        break
      }
      parent = parent.parent
    }
    return false
  }

  // React 的 `key` / `id` / `value` 这类是身份标识而不是展示文案：包了会让
  // 值随语言漂移（`key` 变了 React 会把整棵子树卸载重建），必须原样透传。
  const IDENTITY_ATTRS = new Set([
    'key', 'id', 'htmlFor', 'value', 'name', 'type', 'role', 'href', 'src', 'to',
  ])
  function isIdentityContext(node) {
    const expr = node.parent
    if (!expr || !ts.isJsxExpression(expr)) return false
    const attr = expr.parent
    if (!attr || !ts.isJsxAttribute(attr)) return false
    return IDENTITY_ATTRS.has(attr.name.getText(sf))
  }

  function visit(node) {
    const isAccess = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
    if (isAccess && !alreadyWrapped(node) && !isIdentityContext(node)) {
      const root = chainRoot(node)
      if (root && tainted.has(root.text)) {
        const info = consts.get(root.text)

        let depth = 0
        let cur = node
        while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
          depth++
          cur = cur.expression
        }
        const tail = ts.isPropertyAccessExpression(node) ? node.name.getText(sf) : null

        const hit =
          (tail !== null && fieldNames.has(tail)) || Boolean(info && info.stringMap && depth === 1)

        if (hit) {
          edits.push({ pos: node.getStart(sf), end: node.getEnd(), fn: ownerCall(node) })
          perConst.set(root.text, (perConst.get(root.text) ?? 0) + 1)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (!edits.length) return { changed: false, text, stats: [] }

  // 从后往前应用；跳过与已接受编辑重叠的（嵌套访问只包最外层）
  const accepted = []
  for (const e of edits.sort((a, b) => b.pos - a.pos || b.end - a.end)) {
    if (accepted.some((a) => e.pos < a.end && e.end > a.pos)) continue
    accepted.push(e)
  }

  let out = text
  for (const e of accepted.sort((a, b) => b.pos - a.pos)) {
    const call = e.fn === 't' ? 't' : 'tt'
    out = `${out.slice(0, e.pos)}${call}(${out.slice(e.pos, e.end)})${out.slice(e.end)}`
  }

  return {
    changed: out !== text,
    text: out,
    stats: [...perConst.entries()].map(([k, v]) => `${k}×${v}`),
  }
}

/** 找出文件里所有「值含中文」的模块级常量，并给出中文所在的字段名 */
function collectConstMaps(sf) {
  const HAN = /[\u4e00-\u9fa5]/
  const isChinese = (n) => ts.isStringLiteral(n) && HAN.test(n.text)
  const out = new Map()

  /** 剥掉 `{...} as const` / `(...)` / `<T>{...}` 这类包裹，露出真正的字面量 */
  const unwrap = (n) => {
    let cur = n
    while (
      ts.isAsExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isSatisfiesExpression?.(cur)
    ) {
      cur = cur.expression
    }
    return cur
  }

  /** 递归收集 depth>=1 处的「中文属性名」；返回该对象是否「所有值都是字符串」 */
  function scan(node, depth) {
    let allString = true
    const walk = (n0, d) => {
      const n = unwrap(n0)
      if (ts.isObjectLiteralExpression(n)) {
        for (const p of n.properties) {
          if (!ts.isPropertyAssignment(p)) {
            allString = false
            continue
          }
          if (isChinese(p.initializer)) {
            if (d >= 1) out.__pending.add(p.name.getText(sf))
          } else {
            if (!ts.isStringLiteral(p.initializer)) allString = false
            walk(p.initializer, d + 1)
          }
        }
      } else if (ts.isArrayLiteralExpression(n)) {
        for (const el of n.elements) {
          if (isChinese(el)) {
            if (d >= 1) out.__pending.add(null) // 数组里的裸字符串 → 整表都是中文
          } else {
            walk(el, d + 1)
          }
        }
      }
    }
    walk(node, depth)
    return allString
  }

  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue
    for (const d of st.declarationList.declarations) {
      if (!d.initializer || !ts.isIdentifier(d.name)) continue
      out.__pending = new Set()
      const topAllString = scan(d.initializer, 0)
      const pending = out.__pending
      delete out.__pending

      // 判断「整张表都是中文值」：
      //  - 顶层对象，所有属性值都是字符串字面量（KIND_LABEL）
      //  - 顶层数组，元素是裸字符串（DAY_LABEL）
      const top = unwrap(d.initializer)
      let stringMap = false
      if (ts.isObjectLiteralExpression(top)) {
        const props = top.properties.filter(ts.isPropertyAssignment)
        stringMap =
          props.length > 0 &&
          props.length === top.properties.length &&
          props.every((p) => ts.isStringLiteral(p.initializer)) &&
          props.some((p) => isChinese(p.initializer))
      } else if (ts.isArrayLiteralExpression(top)) {
        stringMap =
          top.elements.length > 0 &&
          top.elements.every((el) => ts.isStringLiteral(el)) &&
          top.elements.some((el) => isChinese(el))
      }

      const fields = new Set([...pending].filter((x) => x !== null))
      if (stringMap || fields.size) out.set(d.name.text, { stringMap, fields, topAllString })
    }
  }
  return out
}

// ---------------------------------------------------------------- main

const mode = process.argv.includes('--report')
  ? 'report'
  : process.argv.includes('--keys')
    ? 'keys'
    : process.argv.includes('--wrap-consts')
      ? 'wrap-consts'
      : 'wrap'
const files = collectFiles(SRC).sort()

if (mode === 'wrap-consts') {
  // 模块级常量不能在定义处包 t()（会把语言固化），改为在读取处包
  let changed = 0
  for (const f of files) {
    const before = fs.readFileSync(f, 'utf8')
    const r = wrapConstAccess(f, before)
    if (r.changed) {
      fs.writeFileSync(f, r.text)
      changed++
      console.log(`  改写 ${f}  ${r.stats.join(' ')}`)
    }
  }
  console.log(`\n共改写 ${changed} 个文件。`)
} else if (mode === 'keys') {
  // 输出「文件 → 该文件用到的所有 key」，供生成 en.ts 用
  const byFile = {}
  const unique = new Map()
  for (const f of files) {
    const found = keysOf(f)
    if (!found.length) continue
    byFile[f] = found.map((x) => x.key)
    for (const x of found) if (!unique.has(x.key)) unique.set(x.key, x)
  }
  const outPath = process.argv[process.argv.indexOf('--keys') + 1]
  const payload = { total: unique.size, byFile, keys: [...unique.values()] }
  if (outPath && !outPath.startsWith('--')) {
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2))
    console.log(`已写出 ${outPath}：${unique.size} 条唯一 key，来自 ${Object.keys(byFile).length} 个文件`)
  } else {
    for (const k of unique.values()) console.log(`${k.key}\t${k.snippet}`)
    console.log(`\n共 ${unique.size} 条唯一 key`)
  }
} else if (mode === 'wrap') {
  let changed = 0
  const manual = []
  for (const f of files) {
    const r = transform(f)
    if (r.changed) {
      changed++
      console.log(`  改写 ${f}`)
    }
    manual.push(...r.manual)
  }
  console.log(`\n共改写 ${changed} 个文件。`)
  if (manual.length) {
    console.log(`\n以下 ${manual.length} 处中文位于模块顶层（常量在模块加载时求值，包 t() 会把语言固化），需要人工处理：`)
    for (const m of manual) console.log(`  ${m.fileName}:${m.line}  ${m.text}`)
  }
} else {
  const en = englishKeys()
  const missing = new Map()
  let unwrappedTotal = 0
  for (const f of files) {
    const found = scanUnwrapped(f)
    if (!found.length) continue
    unwrappedTotal += found.length
    console.log(`\n${f}`)
    for (const item of found) {
      const flag = en.has(item.text) ? '' : '  ← 缺英文'
      console.log(`  ${item.line}: ${item.text}${flag}`)
      if (!en.has(item.text)) missing.set(item.text, (missing.get(item.text) ?? 0) + 1)
    }
  }
  console.log(`\n未被 t()/tt() 包裹的中文：${unwrappedTotal} 条`)
  console.log(`缺英文词条（去重后）：${missing.size} 条`)
  if (missing.size && process.argv.includes('--list-missing')) {
    for (const k of missing.keys()) console.log(k)
  }
}
