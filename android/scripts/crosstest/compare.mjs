#!/usr/bin/env node
/**
 * 比对后端与 Android 两套 ScheduleEngine 的求值结果。
 *
 * 用法：node compare.mjs <reference.json> <android.json>
 * 退出码非 0 表示存在不一致（可直接接进 CI）。
 */
import { readFileSync } from 'node:fs'

const [, , refPath, androidPath] = process.argv
if (!refPath || !androidPath) {
  console.error('用法：node compare.mjs <reference.json> <android.json>')
  process.exit(2)
}

const reference = JSON.parse(readFileSync(refPath, 'utf8'))
const android = JSON.parse(readFileSync(androidPath, 'utf8'))

let diff = 0
let total = 0
const details = []

if (reference.length !== android.length) {
  console.error(`用例数不一致：后端 ${reference.length}，Android ${android.length}`)
  process.exit(1)
}

for (let i = 0; i < reference.length; i++) {
  const a = reference[i]
  const b = android[i]
  if (a.case !== b.case) {
    details.push(`用例名不一致（第 ${i} 个）：${a.case} vs ${b.case}`)
    diff++
    continue
  }

  const boundaryA = JSON.stringify(a.boundaryAtStart)
  const boundaryB = JSON.stringify(b.boundaryAtStart)
  if (boundaryA !== boundaryB) {
    details.push(`边界不一致 [${a.case}]：后端 ${boundaryA}，Android ${boundaryB}`)
    diff++
  }

  for (let j = 0; j < a.points.length; j++) {
    total++
    const x = a.points[j]
    const y = b.points[j]
    if (x.t !== y.t || x.locked !== y.locked || x.rule !== y.rule) {
      if (details.length < 10) {
        const at = new Date(x.t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        details.push(
          `采样点不一致 [${a.case}] ${at}：后端 ${x.locked}/${x.rule}，Android ${y.locked}/${y.rule}`)
      }
      diff++
    }
  }
}

if (details.length > 0) console.error(details.join('\n'))

console.log(`\n比对采样点：${total} 个    不一致：${diff} 个`)
if (diff === 0) {
  console.log('✅ Android ScheduleEngine 与后端 evaluateSchedule 结果完全一致')
  process.exit(0)
}
console.error('❌ 两套实现存在不一致，必须修正后再发布')
process.exit(1)
