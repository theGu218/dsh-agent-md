/**
 * dsh-agent-md — 项目级 agent.md 记忆。
 *
 * 解决的是长对话/长任务里的"失忆"：上下文一长，早先的约束、决定、任务要求
 * 就被挤出窗口或淹没在噪声里。这个插件把它们落到当前工作目录的 `agent.md`，
 * 并在**每一次模型请求**里自动注入最新内容（system prompt 的动态 section），
 * 所以不需要模型"记得去读"——它每次请求都在眼前。
 *
 * 组成：
 * - 四个模型工具 `agentmd_write / agentmd_update / agentmd_forget / agentmd_read`，
 *   按工作目录读写同一个文件；
 * - 两个 per-agent 的 system prompt section：一固定规则、一动态内容；
 * - 条目带 id 和权重（1-3）以及完成标记，完成任务后可以降权或删除，
 *   让注入内容保持在几百字级别，而不是越滚越大。
 *
 * 不依赖任何 `@deepseek-ai/*` 包：profile 里装的插件解析不到它们，一切走 `ctx`。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

export const name = 'dsh-agent-md'

const DEFAULT_FILE = 'agent.md'
const DEFAULT_MAX_CHARS = 4000
const MAX_ENTRIES = 200
const MAX_TEXT = 2000
const MAX_ACCEPTANCE = 500
const MAX_EVIDENCE = 500
const MANAGED_MARK = '<!-- dsh-agent-md:managed v1 -->'
const META_RE = /<!--\s*m:([A-Za-z0-9]{1,16})\s+w(\d+)\s*-->/
const TASK_SECTION_RE = /任务|待办|task|todo/i
const EMPTY_STATE = { entries: [], freeText: [] }

const RULES_TEXT = [
  '## 项目记忆 agent.md',
  '当前项目的对话与工作过程会被提炼进工作目录下的 `agent.md`，它在每次请求里自动注入（见紧随其后的一节）。',
  '维护它用四个工具：`agentmd_write`（新增）、`agentmd_update`（按 id 改内容/权重/完成状态）、`agentmd_forget`（删除）、`agentmd_read`（读全文，注入内容可能被截断）。',
  '',
  '**写之前先做三问**（三问都"是"才记）：',
  '1. 10 轮之后它还会影响某个决定吗？不会 → 不记。',
  '2. 如果忘了它，我可能做错什么？说不出来 → 不记。',
  '3. 能从仓库或文件里随时查回来吗？能 → 不记。',
  '该记：约束（技术栈/版本/平台/性能/合规/预算）、用户偏好与禁止事项、已定方案与接口契约、验收标准、环境事实（路径/命令/网络限制）。',
  '不该记：试错过程与报错原文、可随时重查的代码细节、工具中间输出、寒暄与情绪、密钥与隐私。',
  '权重：影响正确性且不可重查 = 3；影响风格或次要 = 2；备忘 = 1。',
  '',
  '**任务必须带验收标准**：`agentmd_write` 写 kind=task 时 `acceptance` 必填，写清"什么现象出现算完成"（例如"行数=30 且 npm test 通过"）。没有验收标准的任务等于没定义完成，工具会拒绝。',
  '**标记完成必须有证据**：`agentmd_update` 的 done=true 必须给 `evidence`，可信度从高到低——测试/命令通过 > 产物可核对（文件、提交、行数）> 无证据的"我做了"（最后一种不能标 done，工具会拒绝）。',
  '标记 done 会自动把权重降到 1（该结论后续仍被依赖时显式传 weight=2）；结论彻底过时再 `agentmd_forget` 删除。',
  '注入里带 ⚠ 的条目是待处理的：`⚠ 未定验收` 要补 acceptance；`⚠ 已完成未降权` 要把 weight 降到 1。',
  '- 写之前先看注入的内容：同一件事用 `agentmd_update` 修改，不要重复新增；保持 agent.md 精简（几十条以内）。',
  '- 执行任务、写代码、做决定前以注入的 agent.md 为准，不要凭记忆猜。',
].join('\n')

// ---------------------------------------------------------------- 文件格式

function clampWeight(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 3
  return Math.max(1, Math.min(3, Math.round(n)))
}

function parse(text) {
  const entries = []
  const freeText = []
  let kind = 'fact'
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') {
      current = null
      continue
    }
    if (line.indexOf(MANAGED_MARK) >= 0) continue
    if (/^#\s/.test(line)) {
      current = null
      continue
    }
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading) {
      kind = TASK_SECTION_RE.test(heading[1]) ? 'task' : 'fact'
      current = null
      continue
    }
    // 条目下的缩进字段：验收 / 证据
    if (current !== null && /^\s+/.test(line)) {
      const field = /^\s*(验收|证据)\s*[:：]\s*(.*)$/.exec(line)
      if (field !== null) {
        if (field[1] === '验收') current.acceptance = field[2].trim()
        else current.evidence = field[2].trim()
        continue
      }
      freeText.push(line)
      continue
    }
    const meta = line.match(META_RE)
    if (meta === null) {
      current = null
      freeText.push(line)
      continue
    }
    const body = line.slice(0, meta.index).replace(/^-\s+/, '').replace(/\s+$/, '')
    const doneMatch = /^\[( |x|X)\]\s*/.exec(body)
    const done = doneMatch !== null && doneMatch[1].toLowerCase() === 'x'
    const content = (doneMatch === null ? body : body.slice(doneMatch[0].length)).trim()
    if (content === '') {
      current = null
      continue
    }
    current = {
      id: meta[1].toLowerCase(),
      kind,
      text: content,
      weight: clampWeight(meta[2]),
      done,
      acceptance: '',
      evidence: '',
    }
    entries.push(current)
  }
  return { entries, freeText }
}

function serialize(state) {
  const facts = state.entries.filter((entry) => entry.kind === 'fact')
  const tasks = state.entries.filter((entry) => entry.kind === 'task')
  const out = ['# agent.md · 项目记忆', '', MANAGED_MARK, '', '## 事实与约束', '']
  const lines = (entry) => {
    const result = [
      `- ${entry.kind === 'task' ? (entry.done ? '[x] ' : '[ ] ') : ''}${entry.text} <!--m:${entry.id} w${entry.weight}-->`,
    ]
    if (entry.kind === 'task' && entry.acceptance) result.push(`  验收：${entry.acceptance}`)
    if (entry.evidence) result.push(`  证据：${entry.evidence}`)
    return result
  }
  for (const entry of facts) out.push(...lines(entry))
  out.push('', '## 任务', '')
  for (const entry of tasks) out.push(...lines(entry))
  if (state.freeText.length > 0) {
    out.push('', '## 手写笔记', '')
    for (const raw of state.freeText) out.push(raw)
  }
  out.push('')
  return out.join('\n')
}

// ---------------------------------------------------------------- 注入渲染

function clip(text, max) {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

function renderInjection(state, file, maxChars) {
  const pending = state.entries.filter((entry) => entry.kind === 'task' && !entry.done)
  const done = state.entries.filter((entry) => entry.kind === 'task' && entry.done)
  const facts = state.entries.filter((entry) => entry.kind === 'fact')
  pending.sort((a, b) => b.weight - a.weight)
  facts.sort((a, b) => b.weight - a.weight)
  const body = []
  if (pending.length > 0) {
    body.push('### 进行中任务')
    for (const entry of pending) {
      const flag = entry.acceptance ? '' : '（⚠ 未定验收）'
      body.push(`- [${entry.id}] ${entry.weight >= 2 ? entry.text : clip(entry.text, 80)}${flag}`)
      if (entry.weight >= 2 && entry.acceptance) body.push(`  验收：${clip(entry.acceptance, 80)}`)
    }
    body.push('')
  }
  if (done.length > 0) {
    body.push(`### 已完成 ${done.length} 条`)
    for (const entry of done.slice(0, 5)) {
      const flag = entry.weight >= 2 ? '（⚠ 已完成未降权）' : ''
      body.push(`- [${entry.id}] ${clip(entry.text, 40)}${flag}`)
    }
    if (done.length > 5) body.push(`- …还有 ${done.length - 5} 条`)
    body.push('')
  }
  if (facts.length > 0) {
    body.push('### 事实与约束')
    for (const entry of facts) {
      body.push(`- [${entry.id}] ${entry.weight >= 2 ? entry.text : clip(entry.text, 160)}`)
    }
    body.push('')
  }
  if (body.length === 0) {
    body.push('（agent.md 目前为空；遇到重要内容时用 `agentmd_write` 记录。）', '')
  }
  const text = ['## agent.md · 当前记忆（自动注入）', `文件：${file}`, '', ...body].join('\n')
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n…（内容过长已截断，用 `agentmd_read` 查看全部）'
}

function renderFull(state, file) {
  const out = [`路径：${file}`, '']
  const kinds = [
    ['task', '任务'],
    ['fact', '事实与约束'],
  ]
  for (const [kind, label] of kinds) {
    const items = state.entries.filter((entry) => entry.kind === kind)
    out.push(`## ${label}（${items.length} 条）`)
    for (const entry of items) {
      out.push(
        `- [${entry.id}] w${entry.weight}${entry.done ? ' 已完成' : ''}${entry.kind === 'task' && entry.acceptance === '' ? ' ⚠未定验收' : ''} ${entry.text}`,
      )
      if (entry.kind === 'task' && entry.acceptance) out.push(`    验收：${entry.acceptance}`)
      if (entry.evidence) out.push(`    证据：${entry.evidence}`)
    }
    out.push('')
  }
  if (state.freeText.length > 0) {
    out.push('## 手写笔记', ...state.freeText, '')
  }
  return out.join('\n')
}

// ---------------------------------------------------------------- 插件主体

export function apply(ctx, config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const maxChars =
    Number.isFinite(cfg.maxPromptChars) && cfg.maxPromptChars > 0
      ? Math.max(500, Math.min(20000, Math.round(cfg.maxPromptChars)))
      : DEFAULT_MAX_CHARS

  const cache = new Map()
  const installed = new Map()

  function log(level, text, err) {
    try {
      const logger = ctx.logger
      if (logger === undefined || typeof logger[level] !== 'function') return
      logger[level](err === undefined ? text : text + '：' + String(err && err.message ? err.message : err))
    } catch {
      /* 日志不能反过来打断调用方 */
    }
  }

  // ---- 路径与读写 ---------------------------------------------------------

  function memoryFile(cwd) {
    const raw = typeof cfg.memoryFile === 'string' && cfg.memoryFile.trim() !== '' ? cfg.memoryFile.trim() : DEFAULT_FILE
    if (isAbsolute(raw)) return join(cwd, DEFAULT_FILE)
    const root = resolve(cwd)
    const full = resolve(root, raw)
    if (full !== root && !full.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) {
      return join(root, DEFAULT_FILE)
    }
    return full
  }

  function readState(file) {
    let stat
    try {
      stat = statSync(file)
    } catch {
      cache.delete(file)
      return EMPTY_STATE
    }
    const hit = cache.get(file)
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.state
    }
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return EMPTY_STATE
    }
    const state = parse(text)
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, state })
    return state
  }

  function saveState(file, state) {
    const text = serialize(state)
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp'
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, file)
    } finally {
      cache.delete(file)
    }
  }

  function newId(entries) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = randomBytes(2).toString('hex')
      if (!entries.some((entry) => entry.id === id)) return id
    }
    return randomBytes(3).toString('hex')
  }

  // ---- 会话目录 -----------------------------------------------------------

  function cwdOf(agent) {
    try {
      const direct = agent === undefined || agent === null ? undefined : agent.session
      const directCwd = direct === undefined || direct === null ? undefined : direct.header?.cwd
      if (typeof directCwd === 'string' && directCwd.trim() !== '') return directCwd.trim()
    } catch {
      /* agent.session 不是公开字段，取不到就换一条路 */
    }
    try {
      const sessions = ctx.get('sessions')
      if (sessions === undefined || typeof sessions.get !== 'function') return ''
      const session = sessions.get(agent.id)
      const cwd = session === undefined || session === null ? undefined : session.header?.cwd
      return typeof cwd === 'string' ? cwd.trim() : ''
    } catch {
      return ''
    }
  }

  // ---- 工具 ---------------------------------------------------------------

  function toolContext(exec) {
    const agent = exec === undefined || exec === null ? undefined : exec.agent
    const cwd = agent === undefined ? '' : cwdOf(agent)
    return { cwd, file: cwd === '' ? '' : memoryFile(cwd) }
  }

  const TOOL_OUTPUT = {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        message: { type: 'string' },
      },
      required: ['message'],
      additionalProperties: true,
    },
    render: (_args, value) => [
      { type: 'text', text: typeof value.message === 'string' ? value.message : '（无输出）' },
    ],
  }

  const DEFINITIONS = [
    {
      name: 'agentmd_write',
      description:
        '把一条重要内容写进当前工作目录的 agent.md。kind=fact（事实/约束/偏好/决定）或 task（任务/要求）；weight=1~3 表示重要程度（3 最重要，默认 3）。写 task 时必须同时给 acceptance（验收标准：什么现象出现算完成），否则工具会拒绝——没有验收标准的任务无法判定完成。agent.md 每次请求都会自动注入提示，所以写进去就相当于一直记着。写入前先看注入内容，同一件事用 agentmd_update 修改而不是重复新增。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fact', 'task'], description: 'fact=事实/约束，task=任务/要求' },
          text: { type: 'string', description: '要记住的内容，一两句话，能独立读懂' },
          weight: { type: 'integer', enum: [1, 2, 3], description: '重要程度，3 最重要（默认 3）' },
          acceptance: {
            type: 'string',
            description: '验收标准（kind=task 时必填）：写清"什么现象出现算完成"，如"行数=30 且 npm test 通过"',
          },
        },
        required: ['kind', 'text'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const kind = input.kind === 'task' ? 'task' : 'fact'
        const text = typeof input.text === 'string' ? input.text.trim() : ''
        if (text === '') return { ok: false, message: 'text 不能为空。' }
        if (text.length > MAX_TEXT) {
          return { ok: false, message: `text 太长（${text.length} 字），请压缩到 ${MAX_TEXT} 字以内。` }
        }
        const acceptance = typeof input.acceptance === 'string' ? input.acceptance.trim() : ''
        if (kind === 'task' && acceptance === '') {
          return {
            ok: false,
            message: '写任务必须提供 acceptance（验收标准）：写清"什么现象出现算完成"，否则这条任务无法判定是否完成。',
          }
        }
        if (acceptance.length > MAX_ACCEPTANCE) {
          return { ok: false, message: `acceptance 太长（${acceptance.length} 字），请压缩到 ${MAX_ACCEPTANCE} 字以内。` }
        }
        const { cwd, file } = toolContext(exec)
        if (cwd === '') return { ok: false, message: '拿不到当前会话的工作目录，无法定位 agent.md。' }
        const state = readState(file)
        if (state.entries.length >= MAX_ENTRIES) {
          return {
            ok: false,
            message: `agent.md 已有 ${state.entries.length} 条（上限 ${MAX_ENTRIES}）。先用 agentmd_update 降权/合并或 agentmd_forget 清理无用条目。`,
          }
        }
        const weight = clampWeight(input.weight)
        const id = newId(state.entries)
        state.entries.push({
          id,
          kind,
          text,
          weight,
          done: false,
          acceptance: kind === 'task' ? acceptance : '',
          evidence: '',
        })
        saveState(file, state)
        return {
          ok: true,
          message: `已写入${kind === 'task' ? '任务（含验收标准）' : '事实'} [${id}]（权重 ${weight}）→ ${file}`,
        }
      },
    },
    {
      name: 'agentmd_update',
      description:
        '按 id 修改 agent.md 里的条目：改写内容、补验收标准、调整权重、标记完成。标 done=true 必须同时给 evidence（可核对的证据：测试/命令结果、产物路径、行数等，"我做了"不算），并会自动把权重降到 1（结论仍被依赖时显式传 weight=2）。任务只是想做但还没有可核对结果时，不要标 done。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '条目 id（注入内容里方括号中的短串）' },
          text: { type: 'string', description: '新的内容（可选）' },
          acceptance: { type: 'string', description: '验收标准（可选，给旧任务补上）' },
          weight: { type: 'integer', enum: [1, 2, 3], description: '新权重（可选；done=true 且不传时自动降为 1）' },
          done: { type: 'boolean', description: '是否已完成（可选；true 时必须给 evidence）' },
          evidence: { type: 'string', description: '完成证据（done=true 时必填）：测试/命令输出、产物路径、行数等可核对的东西' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''
        if (id === '') return { ok: false, message: 'id 不能为空。' }
        const { cwd, file } = toolContext(exec)
        if (cwd === '') return { ok: false, message: '拿不到当前会话的工作目录。' }
        const state = readState(file)
        const entry = state.entries.find((item) => item.id === id)
        if (entry === undefined) {
          return {
            ok: false,
            message: `没有 id 为 ${id} 的条目。用 agentmd_read 查看现有 id。`,
          }
        }
        if (typeof input.text === 'string' && input.text.trim() !== '') {
          if (input.text.trim().length > MAX_TEXT) {
            return { ok: false, message: `text 太长，请压缩到 ${MAX_TEXT} 字以内。` }
          }
          entry.text = input.text.trim()
        }
        if (typeof input.acceptance === 'string' && input.acceptance.trim() !== '') {
          if (input.acceptance.trim().length > MAX_ACCEPTANCE) {
            return { ok: false, message: `acceptance 太长，请压缩到 ${MAX_ACCEPTANCE} 字以内。` }
          }
          entry.acceptance = input.acceptance.trim()
        }
        const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : ''
        if (evidence.length > MAX_EVIDENCE) {
          return { ok: false, message: `evidence 太长，请压缩到 ${MAX_EVIDENCE} 字以内。` }
        }
        if (evidence !== '') entry.evidence = evidence
        if (input.weight !== undefined) entry.weight = clampWeight(input.weight)
        if (typeof input.done === 'boolean' && input.done) {
          if (entry.evidence === '') {
            return {
              ok: false,
              message: '标记完成必须提供 evidence：测试/命令结果、产物路径、行数等可核对的东西。"我做了"不算证据，没有证据时保持 pending。',
            }
          }
          entry.done = true
          // 完成即降权；结论仍被依赖时由调用方显式传 weight=2 覆盖。
          if (input.weight === undefined) entry.weight = 1
        } else if (typeof input.done === 'boolean') {
          entry.done = input.done
        }
        saveState(file, state)
        return {
          ok: true,
          message: `已更新 [${id}]：权重 ${entry.weight}${entry.done ? '，已完成（附证据）' : ''}`,
        }
      },
    },
    {
      name: 'agentmd_forget',
      description:
        '按 id 从 agent.md 删除一条已经过时、被推翻或不再相关的条目。仍在起作用的结论建议先降权（agentmd_update weight=1）而不是直接删。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '条目 id' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''
        if (id === '') return { ok: false, message: 'id 不能为空。' }
        const { cwd, file } = toolContext(exec)
        if (cwd === '') return { ok: false, message: '拿不到当前会话的工作目录。' }
        const state = readState(file)
        const index = state.entries.findIndex((item) => item.id === id)
        if (index < 0) return { ok: false, message: `没有 id 为 ${id} 的条目。` }
        const [removed] = state.entries.splice(index, 1)
        saveState(file, state)
        return { ok: true, message: `已删除 [${removed.id}]：${clip(removed.text, 60)}` }
      },
    },
    {
      name: 'agentmd_read',
      description:
        '读取当前工作目录下 agent.md 的全部条目（注入到提示里的内容可能被截断或降权折叠，需要看全文时用它）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, exec) {
        const { cwd, file } = toolContext(exec)
        if (cwd === '') return { ok: false, message: '拿不到当前会话的工作目录。' }
        if (!existsSync(file)) {
          return { ok: true, message: `还没有 ${file}。需要时用 agentmd_write 创建。` }
        }
        const state = readState(file)
        return { ok: true, message: renderFull(state, file) }
      },
    },
  ]

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (tools === undefined || typeof tools.register !== 'function') return
    for (const definition of DEFINITIONS) {
      toolsCtx.effect(
        () =>
          tools.register({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
            output: TOOL_OUTPUT,
            execute: definition.execute,
          }),
        'dsh-agent-md: ' + definition.name,
      )
    }
  })

  // ---- 系统提示注入（按 agent，跟随其工作目录） ---------------------------

  function sectionFor(agent) {
    const cwd = cwdOf(agent)
    if (cwd === '') return ''
    const file = memoryFile(cwd)
    try {
      return renderInjection(readState(file), file, maxChars)
    } catch (err) {
      log('warn', 'dsh-agent-md: 渲染 agent.md 失败', err)
      return ''
    }
  }

  function disarm(disposer) {
    if (typeof disposer === 'function') disposer()
    else if (disposer !== null && typeof disposer === 'object' && typeof disposer.dispose === 'function') disposer.dispose()
  }

  function install(agent) {
    if (agent === undefined || agent === null || installed.has(agent.id)) return
    const agentCtx = agent.ctx
    if (agentCtx === undefined || typeof agentCtx.effect !== 'function' || typeof agentCtx.get !== 'function') return
    const prompt = agentCtx.get('systemPrompt')
    if (prompt === undefined || typeof prompt.section !== 'function') return
    const disposer = agentCtx.effect(() => {
      const rules = prompt.section({ name: 'agent-md-rules', order: 160, text: RULES_TEXT })
      const memory = prompt.section({
        name: 'agent-md-memory',
        order: 161,
        text: () => sectionFor(agent),
      })
      return () => {
        disarm(rules)
        disarm(memory)
      }
    }, 'dsh-agent-md: prompt sections')
    installed.set(agent.id, disposer)
  }

  function uninstall(agent) {
    if (agent === undefined || agent === null) return
    const disposer = installed.get(agent.id)
    installed.delete(agent.id)
    if (disposer !== undefined) disarm(disposer)
  }

  ctx.on('agent/created', (payload) => {
    install(payload === undefined || payload === null ? undefined : payload.agent)
  })
  ctx.on('agent/disposed', (payload) => {
    uninstall(payload === undefined || payload === null ? undefined : payload.agent)
  })

  // 插件加载时可能已经有 live agent（本会话就是）；systemPrompt 也可能晚于本插件
  // 出现，所以两处都补装，install 自身幂等。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const agents = promptCtx.get('agents')
    if (agents !== undefined && typeof agents.list === 'function') {
      for (const agent of agents.list()) install(agent)
    }
    promptCtx.effect(() => () => {
      for (const [id, disposer] of installed) {
        installed.delete(id)
        disarm(disposer)
      }
    }, 'dsh-agent-md: teardown sections')
  })
}
