/**
 * 无 DSH 依赖的冒烟测试：用假 ctx 验证解析、四个工具、注入渲染。
 * 运行：node tools/smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../index.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-agent-md-'))
const failures = []
const ok = (condition, label) => {
  if (!condition) failures.push(label)
  console.log((condition ? 'PASS ' : 'FAIL ') + label)
}

const registered = new Map()
const sections = []
const listeners = new Map()
let agent = null

const ctx = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  get(service) {
    if (service === 'tools') {
      return {
        register(definition) {
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
      }
    }
    if (service === 'systemPrompt') {
      return {
        section(definition) {
          sections.push(definition)
          return () => sections.splice(sections.indexOf(definition), 1)
        },
      }
    }
    if (service === 'sessions') {
      return { get: () => ({ header: { cwd: dir } }) }
    }
    if (service === 'agents') {
      return { list: () => (agent === null ? [] : [agent]) }
    }
    return undefined
  },
  inject(_deps, callback) {
    callback(ctx)
  },
  on(event, handler) {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
  effect(callback) {
    return callback()
  },
}

agent = {
  id: 'session-smoke',
  session: { header: { cwd: dir } },
  ctx: {
    get: (service) => ctx.get(service),
    effect: (callback) => callback(),
  },
}

apply(ctx, { maxPromptChars: 1200 })

const exec = { agent }
const call = async (tool, args) => registered.get(tool).execute(args, exec)
const injection = () => sections.find((s) => s.name === 'agent-md-memory').text()

ok(name === 'dsh-agent-md', '插件 name 导出正确')
ok(registered.size === 4, '注册了 4 个工具（' + [...registered.keys()].join(', ') + '）')
ok(sections.length === 2, '为已有 agent 补装了 2 个 section')
ok(listeners.has('agent/created'), '监听了 agent/created')

// ---- 任务必须有验收标准（P1 硬约束）--------------------------------------
let result = await call('agentmd_write', { kind: 'task', text: '把评测集扩到 30 条' })
ok(result.ok === false, '任务缺 acceptance 被拒绝：' + result.message)

result = await call('agentmd_write', {
  kind: 'task',
  text: '把评测集扩到 30 条',
  acceptance: 'data/eval.jsonl 行数 = 30 且 npm test 通过',
})
ok(result.ok === true, '任务带 acceptance 写入成功：' + result.message)
const taskId = /\[([0-9a-z]+)\]/.exec(result.message)[1]

let fileText = readFileSync(join(dir, 'agent.md'), 'utf8')
ok(fileText.includes('验收：data/eval.jsonl 行数 = 30 且 npm test 通过'), '文件里写了验收行')

// ---- 写事实 ---------------------------------------------------------------
result = await call('agentmd_write', { kind: 'fact', text: 'Python 3.12，禁止新增三方依赖', weight: 3 })
ok(result.ok === true, '写入事实成功')
const factId = /\[([0-9a-z]+)\]/.exec(result.message)[1]

// ---- 注入里带验收与 ⚠ 标志 -----------------------------------------------
let text = injection()
ok(text.includes('把评测集扩到 30 条'), '注入里出现任务')
ok(text.includes('验收：data/eval.jsonl 行数 = 30'), '注入里出现验收标准')
ok(text.includes('Python 3.12'), '注入里出现事实')
ok(text.includes('[' + taskId + ']'), '注入里带条目 id')
ok(!text.includes('⚠ 未定验收'), '带验收的任务没有 ⚠ 未定验收')

// ---- 完成必须有证据（P1 硬约束）------------------------------------------
result = await call('agentmd_update', { id: taskId, done: true })
ok(result.ok === false, 'done 缺 evidence 被拒绝：' + result.message)

result = await call('agentmd_update', {
  id: taskId,
  done: true,
  evidence: 'wc -l data/eval.jsonl = 30；npm test 21 passed',
})
ok(result.ok === true, '带证据标记完成成功：' + result.message)
ok(result.message.includes('权重 1'), 'done 自动降权到 1：' + result.message)

fileText = readFileSync(join(dir, 'agent.md'), 'utf8')
ok(fileText.includes('- [x] 把评测集扩到 30 条'), '文件里任务变成已完成')
ok(fileText.includes('证据：wc -l data/eval.jsonl = 30'), '文件里写了证据行')

text = injection()
ok(text.includes('已完成 1 条'), '注入里已完成条目被折叠统计')
ok(!text.includes('⚠ 已完成未降权'), '自动降权后没有 ⚠ 已完成未降权')

// ---- 显式保持权重时，注入提示"已完成未降权" ------------------------------
await call('agentmd_update', { id: taskId, weight: 2 })
text = injection()
ok(text.includes('⚠ 已完成未降权'), 'done 但 weight=2 时注入显示 ⚠ 已完成未降权')

// ---- 旧格式（无验收）的任务在注入里带 ⚠ 未定验收 --------------------------
await call('agentmd_write', { kind: 'task', text: '旧式任务', acceptance: '临时' })
fileText = readFileSync(join(dir, 'agent.md'), 'utf8')
writeFileSync(join(dir, 'agent.md'), fileText.replace(/\n {2}验收：临时/, ''))
text = injection()
ok(text.includes('⚠ 未定验收'), '缺验收的旧任务在注入里显示 ⚠ 未定验收')

// ---- 注入字符上限 ---------------------------------------------------------
await call('agentmd_write', { kind: 'fact', text: '很长的事实'.repeat(300) })
const clipped = injection()
ok(clipped.length <= 1200 + 40, '注入长度受 maxPromptChars 限制（' + clipped.length + '）')
ok(clipped.includes('已截断'), '截断时给出提示')

// ---- 删除与错误 -----------------------------------------------------------
result = await call('agentmd_forget', { id: factId })
ok(result.ok === true, '删除事实成功')
result = await call('agentmd_forget', { id: 'nope' })
ok(result.ok === false, '不存在的 id 报错')

// ---- 手写笔记保护 ---------------------------------------------------------
writeFileSync(join(dir, 'agent.md'), readFileSync(join(dir, 'agent.md'), 'utf8') + '\n## 手写笔记\n\n这一行用户手写，不能丢。\n')
await call('agentmd_write', { kind: 'task', text: '新任务', acceptance: '新任务可见' })
const afterWrite = readFileSync(join(dir, 'agent.md'), 'utf8')
ok(afterWrite.includes('这一行用户手写，不能丢。'), '写入后手写内容仍保留')

result = await call('agentmd_read', {})
ok(result.ok === true && result.message.includes('新任务'), 'agentmd_read 返回全部条目')
ok(result.message.includes('验收：'), 'agentmd_read 里能看到验收标准')

// ---- acceptance 长度限制 --------------------------------------------------
result = await call('agentmd_write', { kind: 'task', text: '超长验收', acceptance: 'x'.repeat(600) })
ok(result.ok === false, '超长 acceptance 被拒绝')

rmSync(dir, { recursive: true, force: true })
console.log(failures.length === 0 ? '\n全部通过。' : '\n失败：\n- ' + failures.join('\n- '))
process.exit(failures.length === 0 ? 0 : 1)

