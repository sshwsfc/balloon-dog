/**
 * 逐点比对模式求值：后端 evaluateMode vs Android StudyModeEngine。
 *
 * 只要有任意一个采样点不一致就退出码 1 —— 这条不许「差不多」。
 */
import { readFileSync } from 'node:fs'

const [refPath, androidPath] = process.argv.slice(2)
const ref = JSON.parse(readFileSync(refPath, 'utf8'))
const android = JSON.parse(readFileSync(androidPath, 'utf8'))

if (ref.length !== android.length) {
  console.error(`✗ 用例数量不一致：后端 ${ref.length}，Android ${android.length}`)
  process.exit(1)
}

let points = 0
let diffs = 0
for (let i = 0; i < ref.length; i++) {
  const r = ref[i]
  const a = android[i]
  if (r.case !== a.case) {
    console.error(`✗ 第 ${i + 1} 个用例名不一致：「${r.case}」vs「${a.case}」`)
    diffs++
    continue
  }
  if (r.points.length !== a.points.length) {
    console.error(`✗ 用例「${r.case}」采样点数不一致：${r.points.length} vs ${a.points.length}`)
    diffs++
    continue
  }
  for (let j = 0; j < r.points.length; j++) {
    points++
    if (r.points[j].t !== a.points[j].t || r.points[j].mode !== a.points[j].mode) {
      diffs++
      if (diffs <= 10) {
        console.error(
          `✗ 用例「${r.case}」第 ${j} 点不一致：` +
          `t=${new Date(r.points[j].t).toISOString()} 后端=${r.points[j].mode} Android=${a.points[j].mode}`,
        )
      }
    }
  }
}

if (diffs > 0) {
  console.error(`\n✗ 模式求值不一致：${diffs} 处差异 / ${points} 个采样点`)
  process.exit(1)
}
console.log(`✅ 模式求值完全一致：${points} 个采样点，${ref.length} 组配置，零差异`)
