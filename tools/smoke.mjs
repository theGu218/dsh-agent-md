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

apply(ctx, { maxPromptChars: 1500 })

const exec = { agent }
const call = async (tool, args) => registered.get(tool).execute(args, exec)

ok(name === 'dsh-agent-md', '插件 name 导出正确')
ok(registered.size === 4, '注册了 4 个工具（' + [...registered.keys()].join(', ') + '）')
ok(sections.length === 2, '为已有 agent 补装了 2 个 section')
ok(listeners.has('agent/created'), '监听了 agent/created')

// 首次写入
let result = await call('agentmd_write', { kind: 'task', text: '把评测集扩到 30 条' })
ok(result.ok === true, '写入任务成功：' + result.message)
const id1 = /\[([0-9a-z]+)\]/.exec(result.message)[1]

result = await call('agentmd_write', { kind: 'fact', text: 'Python 3.12，禁止新增三方依赖', weight: 3 })
ok(result.ok === true, '写入事实成功')
const id2 = /\[([0-9a-z]+)\]/.exec(result.message)[1]

let text = readFileSync(join(dir, 'agent.md'), 'utf8')
ok(text.includes('<!-- dsh-agent-md:managed v1 -->'), '文件带 managed 标记')
ok(text.includes('## 事实与约束') && text.includes('## 任务'), '文件有两个分区')

// 注入内容
const injection = sections.find((s) => s.name === 'agent-md-memory').text()
ok(injection.includes('把评测集扩到 30 条'), '注入里出现任务')
ok(injection.includes('Python 3.12'), '注入里出现事实')
ok(injection.includes('[' + id1 + ']'), '注入里带条目 id')

// 更新 + 降权
result = await call('agentmd_update', { id: id1, done: true, weight: 1 })
ok(result.ok === true, '标记完成并降权成功：' + result.message)
text = readFileSync(join(dir, 'agent.md'), 'utf8')
ok(text.includes('- [x] 把评测集扩到 30 条'), '文件里任务变成已完成')
const after = sections.find((s) => s.name === 'agent-md-memory').text()
ok(after.includes('已完成 1 条'), '注入里已完成条目被折叠统计')

// 注入有字符上限
const longText = '很长的事实'.repeat(300)
await call('agentmd_write', { kind: 'fact', text: longText })
const clipped = sections.find((s) => s.name === 'agent-md-memory').text()
ok(clipped.length <= 1500 + 40, '注入长度受 maxPromptChars 限制（' + clipped.length + '）')
ok(clipped.includes('已截断'), '截断时给出提示')

// 删除
result = await call('agentmd_forget', { id: id2 })
ok(result.ok === true, '删除事实成功')
result = await call('agentmd_forget', { id: 'nope' })
ok(result.ok === false, '不存在的 id 报错')

// 手写笔记保留
writeFileSync(join(dir, 'agent.md'), readFileSync(join(dir, 'agent.md'), 'utf8') + '\n## 手写笔记\n\n这一行用户手写，不能丢。\n')
const before = readFileSync(join(dir, 'agent.md'), 'utf8')
ok(before.includes('这一行用户手写，不能丢。'), '文件里已含手写内容')
result = await call('agentmd_write', { kind: 'task', text: '新任务' })
const afterWrite = readFileSync(join(dir, 'agent.md'), 'utf8')
ok(afterWrite.includes('这一行用户手写，不能丢。'), '写入后手写内容仍保留')
result = await call('agentmd_read', {})
ok(result.ok === true && result.message.includes('新任务'), 'agentmd_read 返回全部条目')

// 配置项
rmSync(dir, { recursive: true, force: true })
console.log(failures.length === 0 ? '\n全部通过。' : '\n失败：\n- ' + failures.join('\n- '))
process.exit(failures.length === 0 ? 0 : 1)
