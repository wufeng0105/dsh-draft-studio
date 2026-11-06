#!/usr/bin/env node
/**
 * contract-check.mjs —— `/refine` 对外契约的机械判据。
 *
 * 为什么需要它：这个仓没有构建、没有 lint，`client.js` 又没有任何 ES 导出
 * （整份实现封在 `window.__ModuleLoader__.load({ factory })` 里），所以行为只能
 * 从**宿主这一侧**验：直接 import `index.js`，用假 ctx 捕获路由 handler，喂请求、
 * 断言响应。客户端侧的两处改动另由「源码级守卫断言」兜底（见 SOURCE 段）。
 *
 * 判据对应 `docs/ARCHITECTURE.md` 的「契约不变量」：
 *   I1 请求体只有三字段          I2 成功 7 字段 / 失败 5 字段、finish === code
 *   I3 context 六态、ok 仅在 turns>0   I4 失败仍 HTTP 200
 *   I7 状态行可见性 ≡ 宿主回报过 context（源码级守卫）
 *
 * 用法：
 *   node scripts/contract-check.mjs            # 正常跑，全绿退出 0
 *   node scripts/contract-check.mjs --prove    # 反向自证：故意破坏三处，断言判据能变红
 *
 * 退出码：0 通过 / 1 有失败 / 2 环境问题
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const proveMode = process.argv.includes('--prove')
const targetArg = process.argv.indexOf('--target')
const entryFile = targetArg > 0 ? process.argv[targetArg + 1] : path.join(root, 'index.js')

let plugin
try {
	plugin = await import(pathToFileURL(entryFile).href)
} catch (error) {
	console.log(`import index.js 失败：${error.message}`)
	process.exit(2)
}

// ---------------------------------------------------------------------------
// 假宿主
// ---------------------------------------------------------------------------

const MESSAGES = [
	{ role: 'user', content: [{ type: 'text', text: '帮我写个爬虫' }] },
	{ role: 'assistant', content: [{ type: 'text', text: '先说清目标' }] },
]

/** 一份完整、合法的配置（模拟 profile 已写入的形态）。 */
export function baseConfig(overrides = {}) {
	return {
		enabled: true,
		preset: 'general',
		promptGeneral: 'GENERAL-PROMPT',
		promptCode: 'CODE-PROMPT',
		promptWriting: 'WRITING-PROMPT',
		promptTranslation: 'TRANSLATION-PROMPT',
		presetButtons: ['general', 'code', 'writing', 'translation'],
		nameGeneral: '',
		nameCode: '',
		nameWriting: '',
		nameTranslation: '',
		contextEnabled: true,
		modelMode: 'fixed',
		provider: 'fake',
		model: 'm1',
		reasoningEffort: '',
		maxOutputTokens: 2000,
		timeoutMs: 30000,
		contextMaxMessages: 8,
		contextMaxChars: 4000,
		...overrides,
	}
}

/** 装一次插件，返回「打一次请求」的函数与捕获到的 system。 */
function install(config) {
	let handler = null
	const captured = { system: null }

	const llm = {
		listProviders: () => [{ id: 'fake' }],
		resolveModelInfo: async () => ({ limits: { maxOutputTokens: 4096 } }),
		prepareCall: async () => ({
			config: {},
			async *stream(args) {
				captured.system = args.system
				yield { type: 'text-delta', text: '```\nREFINED\n```' }
				yield { type: 'finish', reason: { kind: 'stop' } }
			},
		}),
	}

	const session = { deriveMessages: () => MESSAGES }

	const scope = {
		llm,
		webServer: {
			register(entry) {
				handler = entry.handler
				return () => {}
			},
		},
		get: (name) => {
			if (name === 'sessions') return { get: () => session }
			if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'm1' }) }
			return undefined
		},
		effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
	}

	const ctx = {
		effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
		inject: (deps, callback) => callback(scope),
	}

	plugin.apply(ctx, config)
	if (handler === null) throw new Error('apply 没有注册路由')

	/** 打一次请求，返回 { status, payload }。 */
	async function call(body) {
		captured.system = null
		const raw = typeof body === 'string' ? body : JSON.stringify(body)
		const request = {
			method: 'POST',
			headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
			async *[Symbol.asyncIterator]() {
				yield Buffer.from(raw, 'utf8')
			},
		}
		let status = 0
		let text = ''
		const response = {
			writeHead(code) { status = code },
			end(chunk) { if (chunk !== undefined) text += chunk.toString('utf8') },
		}
		await handler(request, response)
		let payload = null
		try { payload = JSON.parse(text) } catch { payload = null }
		return { status, payload }
	}

	return { call, captured }
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let failures = 0
function check(id, label, passed, detail) {
	if (passed) {
		console.log(`  [PASS] ${id} ${label}`)
		return
	}
	failures += 1
	console.log(`  [FAIL] ${id} ${label}`)
	if (detail !== undefined) console.log(`         → ${detail}`)
}

const SUCCESS_FIELDS = ['ok', 'text', 'finish', 'route', 'preset', 'context', 'error']
const FAILURE_FIELDS = ['ok', 'code', 'text', 'finish', 'error']
const SIX_STATES = ['disabled', 'noSession', 'unreachable', 'empty', 'filtered', 'ok']

console.log('契约判据（I1–I4）')

const normal = install(baseConfig())
const ok = await normal.call({ draft: '写个爬虫', sessionId: 's1', presetId: 'code' })

check('C1', '成功响应恰好 7 个字段（I2）',
	ok.status === 200 && ok.payload !== null
	&& JSON.stringify(Object.keys(ok.payload).sort()) === JSON.stringify([...SUCCESS_FIELDS].sort()),
	`实际 ${JSON.stringify(Object.keys(ok.payload ?? {}))}`)

check('C2', '成功时 finish === "stop"、error === null（I2）',
	ok.payload?.finish === 'stop' && ok.payload?.error === null,
	`finish=${ok.payload?.finish} error=${JSON.stringify(ok.payload?.error)}`)

check('C3', 'presetId 生效：回显 code 且送进模型的是 CODE-PROMPT（I1/D12）',
	ok.payload?.preset === 'code' && normal.captured.system === 'CODE-PROMPT',
	`preset=${ok.payload?.preset} system=${String(normal.captured.system).slice(0, 24)}`)

check('C4', 'context 六态之一，且有会话时为 ok 且 turns>0（I3）',
	ok.payload?.context !== undefined
	&& SIX_STATES.includes(ok.payload.context.status)
	&& ok.payload.context.status === 'ok'
	&& ok.payload.context.turns > 0 && ok.payload.context.chars > 0,
	JSON.stringify(ok.payload?.context))

const emptyDraft = await normal.call({ draft: '   ', sessionId: 's1', presetId: 'code' })
check('C5', '空草稿：失败信封 5 字段、HTTP 200、finish === code（I2/I4）',
	emptyDraft.status === 200
	&& emptyDraft.payload?.ok === false
	&& JSON.stringify(Object.keys(emptyDraft.payload).sort()) === JSON.stringify([...FAILURE_FIELDS].sort())
	&& emptyDraft.payload.finish === emptyDraft.payload.code,
	`status=${emptyDraft.status} keys=${JSON.stringify(Object.keys(emptyDraft.payload ?? {}))} finish=${emptyDraft.payload?.finish} code=${emptyDraft.payload?.code}`)

const noCtx = install(baseConfig({ contextEnabled: false }))
const disabled = await noCtx.call({ draft: '写个爬虫', sessionId: 's1' })
check('C6', '关掉读取上下文：context.status === "disabled"（I3）',
	disabled.payload?.context?.status === 'disabled', JSON.stringify(disabled.payload?.context))

const noSession = await normal.call({ draft: '写个爬虫' })
check('C7', '不带 sessionId：context.status === "noSession"（I3）',
	noSession.payload?.context?.status === 'noSession', JSON.stringify(noSession.payload?.context))

const bogus = await normal.call({ draft: '写个爬虫', sessionId: 's1', presetId: '../../etc' })
check('C8', '非法 presetId 静默回落到配置预设（general）',
	bogus.payload?.preset === 'general' && bogus.payload?.ok === true,
	`preset=${bogus.payload?.preset} ok=${bogus.payload?.ok}`)

const inject = await normal.call({
	draft: '写个爬虫', sessionId: 's1', presetId: 'code',
	systemPrompt: 'INJECTED-EVIL', promptText: 'INJECTED-EVIL',
})
check('C9', 'D12：请求体里的提示词字段被完全忽略（I1）',
	inject.payload?.ok === true
	&& inject.payload?.preset === 'code'
	&& normal.captured.system === 'CODE-PROMPT',
	`system=${String(normal.captured.system).slice(0, 40)}`)

// ---------------------------------------------------------------------------
// 源码级守卫（客户端没有导出，只能断言"这行还在"）
// ---------------------------------------------------------------------------

const clientSource = readFileSync(path.join(root, 'client.js'), 'utf8')

check('C10', 'I7 守卫在位：recordLastRun 只在 payload.context 存在时调用',
	/payload\?\.context !== undefined[\s\S]{0,80}recordLastRun/u.test(clientSource),
	'client.js 里找不到 `payload?.context !== undefined` 守卫')

check('C11', 'A1：NO_ADAPTER 已拆出独立分支且使用净化后的宿主原话',
	/case 'NO_ADAPTER':/u.test(clientSource) && /hostDetail\(/u.test(clientSource),
	'client.js 里找不到 NO_ADAPTER 独立分支或 hostDetail()')

check('C12', 'A1：净化函数有长度上限与换行压平',
	/hostDetail/u.test(clientSource) && /replace\(\/\\s\+\/gu, ' '\)/u.test(clientSource),
	'找不到压平换行的实现')

// 中英各一条：缺一条就会在某个 locale 下把 key 原文或中文原话喷到界面上。
const zhDict = clientSource.slice(clientSource.indexOf('\t\t\tzh: {'), clientSource.indexOf('\t\t\ten: {'))
const enDict = clientSource.slice(clientSource.indexOf('\t\t\ten: {'))
check('C13', 'A1：state.noAdapter 中英两份都在',
	zhDict.includes("'state.noAdapter':") && enDict.includes("'state.noAdapter':"),
	`zh=${zhDict.includes("'state.noAdapter':")} en=${enDict.includes("'state.noAdapter':")}`)

check('C14', 'A1：英文文案不引用宿主原话（避免英文界面夹中文）',
	!/'state\.noAdapter': '[^']*\{detail\}/u.test(enDict),
	'英文 state.noAdapter 仍含 {detail} 占位符')

// ---------------------------------------------------------------------------
// --prove：反向自证（判据必须先被证明会红）
// ---------------------------------------------------------------------------

if (proveMode) {
	// 真注入：把 index.js 复制到临时目录、弄坏一处、用 --target 跑本脚本，期望退出码 1。
	// 这证明的是「判据端到端会红」，而不是「断言表达式写对了」。
	console.log('\n反向自证（每条都必须让本脚本退出码变 1）')
	const source = readFileSync(path.join(root, 'index.js'), 'utf8')
	const dir = mkdtempSync(path.join(os.tmpdir(), 'contract-prove-'))
	const cases = [
		['成功响应漏掉 context 字段', source.replace('\t\t\tcontext: result.context,\n', '')],
		['失败响应的 finish 不再等于 code', source.replace('\t\t\tfinish: code,\n', "\t\t\tfinish: 'stop',\n")],
	]
	let proved = 0
	for (const [label, mutated] of cases) {
		if (mutated === source) {
			console.log(`  [!!] ${label} → 注入未命中（源码形状变了，先改这里）`)
			continue
		}
		const target = path.join(dir, `mutated-${proved}.mjs`)
		writeFileSync(target, mutated, 'utf8')
		const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--target', target], { encoding: 'utf8' })
		const red = run.status === 1
		if (red) proved += 1
		console.log(`  ${red ? '[OK]' : '[!!]'} ${label} → 退出码 ${run.status}（应 1）`)
	}
	if (proved !== cases.length) {
		console.log(`\n反向自证不足：${proved}/${cases.length}`)
		process.exit(1)
	}
}

console.log('')
if (failures === 0) {
	console.log('全部通过。')
	process.exit(0)
}
console.log(`${failures} 项失败。`)
process.exit(1)
