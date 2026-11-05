#!/usr/bin/env node
/**
 * 版本一致性门禁：让「tag == package.json == CHANGELOG」成为可执行断言。
 *
 * RELEASE.md 的每个校验点都调用它，所以它必须自己就能跑、能分辨正常中间态。
 * 版本不一致时以非零退出，并把「怎么修」写在报错里，而不是只报「不一致」。
 *
 * 检查项：
 *   V1  package.json 可解析且 version 是合法 semver
 *   V2  CHANGELOG.md 顶部有对应版本的节
 *   V3  该节标题的日期是今天或更早（防手滑写未来日期）
 *   V4  engines.dsh 存在且含 `||`（单一范围会静默排除其他 rc 元组）
 *   V5  最新 git tag（若有）等于 `v<version>`
 *
 * 退出码：0 = 全部通过或仅有「正常中间态」提醒；1 = 有真实不一致。
 * 加 --allow-untagged 时 V5 缺席不报错（打 tag 之前跑）。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const allowUntagged = process.argv.includes('--allow-untagged')

let failures = 0
let reminders = 0

function ok(msg) {
	console.log(`  [OK]   ${msg}`)
}
function fail(msg, fix) {
	failures += 1
	console.log(`  [FAIL] ${msg}`)
	if (fix) console.log(`         → ${fix}`)
}
function remind(msg) {
	reminders += 1
	console.log(`  [--]   ${msg}`)
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/

console.log('版本一致性门禁')

// ---------------------------------------------------------------------------
// V1 — package.json
// ---------------------------------------------------------------------------

let pkg
try {
	pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
} catch (error) {
	fail('package.json 无法解析', error.message)
	process.exit(1)
}
const version = pkg.version
if (typeof version !== 'string' || !SEMVER.test(version)) {
	fail(`version 不是合法 semver：${version}`, '改成 X.Y.Z 或 X.Y.Z-rc.N')
} else {
	ok(`version = ${version}`)
}
const name = pkg.name
if (typeof name !== 'string' || name.length === 0) fail('缺少 name', '包名不能为空')

// ---------------------------------------------------------------------------
// V2 / V3 — CHANGELOG
// ---------------------------------------------------------------------------

let changelog = ''
try {
	changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
} catch {
	fail('CHANGELOG.md 不存在', '新建它，并在顶部加一节 ## <version> — <日期>')
}

if (changelog) {
	const headingRe = new RegExp(`^##\\s+${version.replace(/[.]/g, '\\.')}\\s*[—-]\\s*(\\S+)`, 'm')
	const match = changelog.match(headingRe)
	if (!match) {
		fail(`CHANGELOG.md 没有 ${version} 这一节`, `在顶部加 "## ${version} — <日期>" 并写清改了什么`)
	} else {
		ok(`CHANGELOG.md 有 ${version} 的节`)
		const date = match[1]
		if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			const written = new Date(`${date}T00:00:00Z`)
			const today = new Date()
			const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
			if (written > todayUtc) {
				fail(`CHANGELOG 日期在未来：${date}`, '改成今天或更早')
			} else {
				ok(`CHANGELOG 日期 = ${date}`)
			}
		} else {
			remind(`CHANGELOG 日期格式不是 YYYY-MM-DD（读到 "${date}"）`)
		}
	}
}

// ---------------------------------------------------------------------------
// V4 — engines.dsh
// ---------------------------------------------------------------------------

const dshRange = pkg.engines?.dsh
if (typeof dshRange !== 'string' || dshRange.length === 0) {
	fail('缺少 engines.dsh', '声明支持范围，DSH 大版本升级时才能提前拦下不兼容安装')
} else if (!dshRange.includes('||')) {
	// 这是本仓踩过的真坑：单一范围只放行「与该版本 major.minor.patch 完全一致
	// 且自身带预发布标签」的比较符，于是 0.2.2-rc.1 这类版本被静默排除。
	fail(`engines.dsh 无 || 分支，会静默排除其他 rc 元组：${dshRange}`, '为每个 0.2.x 元组各写一支，如 ">=0.2.1-rc.5 <0.3.0-0 || >=0.2.2-rc.0 <0.3.0-0"')
} else {
	ok('engines.dsh 用 || 覆盖多个预发布元组')
}

// ---------------------------------------------------------------------------
// V5 — git tag
// ---------------------------------------------------------------------------

function git(args) {
	try {
		return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
	} catch {
		return null
	}
}

const latestTag = git(['describe', '--tags', '--abbrev=0'])
if (latestTag === null) {
	if (allowUntagged) remind('尚无 git tag（--allow-untagged，属打 tag 前的正常态）')
	else fail('尚无 git tag', `git tag v${version} && git push origin v${version}`)
} else if (latestTag !== `v${version}`) {
	fail(`最新 tag 是 ${latestTag}，而 package.json 是 ${version}`, `git tag v${version}（并推送）`)
} else {
	ok(`最新 tag = ${latestTag}`)
	const head = git(['rev-parse', '--short', 'HEAD'])
	const tagged = git(['rev-parse', '--short', `${latestTag}^{commit}`])
	if (head && tagged) ok(`tag 指向 ${tagged}（HEAD ${head}${head === tagged ? ' 相同' : ' 不同'}）`)
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log('')
if (failures === 0) {
	console.log(reminders > 0 ? `通过（${reminders} 项提醒）。` : '通过。')
	process.exit(0)
}
console.log(`${failures} 项失败${reminders > 0 ? `，${reminders} 项提醒` : ''}。`)
process.exit(1)
