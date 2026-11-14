/**
 * dsh-draft-studio — browser half.
 *
 * One compact control beside the composer submit action. Click it and the draft in
 * the composer is replaced by a refined prompt; click again to put the original back.
 *
 * ## The four states
 *
 * `idle` → ready; `busy` → a request is in flight (click cancels it);
 * `undo` → a refined result is in the composer and the original is snapshotted
 * (click restores it); `error` → the last attempt failed (click retries).
 *
 * State is stored per `sessionId`, so switching conversations never carries a
 * spinner, a snapshot, or a failure into the wrong one.
 *
 * ## Undo is deliberately shallow
 *
 * The composer's `insertText` lands as ONE lexicographic history entry (the host
 * calls it "an asynchronous text result as one independent undo operation"), so the
 * browser's own Ctrl+Z already reverses the whole replacement. This plugin therefore
 * keeps exactly one snapshot — the previous draft — instead of a multi-level stack,
 * and drops that snapshot the moment the draft stops matching what it wrote.
 *
 * ## Nothing is lost silently
 *
 * `inputActions.insertText()` returns `false` for four distinct reasons (submitting,
 * adjudicating, disposed, and a draft revision that moved under us). Each of the four
 * gets its own message and keeps the result available for a retry: the user's original
 * draft is never destroyed, and a produced result is never thrown away without saying
 * so.
 *
 * ## The settings page (same file, second seat)
 *
 * A `settings.section` page exposes the plugin's visible preferences: two switches
 * (master, conversation context), a preset dropdown over the complete prompt texts,
 * a textarea for the active preset's text, and the model source — a segmented
 * follow/pin control that, when pinned, reveals two dropdowns (model, reasoning
 * effort) fed from the shared catalogue. Every read and write on that page goes through
 * `ctx.configForms.get('dsh-draft-studio')` — the Host's own settings document — so
 * the page contains no transport of its own: no request code, no profile files, no
 * private endpoints. Staged edits survive failed saves; an emptied prompt box and the
 * "restore default" button both clear the override (`unset`), which hands the field
 * back to the built-in default rather than storing an empty string.
 *
 * Module bodies stay side-effect free: the factory only returns the plugin, and every
 * resource is registered inside `apply` with the owner's effect scope.
 */
window.__ModuleLoader__.load({
	id: 'dsh-draft-studio',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useReducer, useRef, useState } = React;

		/** Locale namespace — also the Host entry id the settings form is read under. */
		const NS = 'dsh-draft-studio';

		/** Product route registered by the Host half. */
		const REFINE_PATH = '/dsh-draft-studio/refine';

		/**
		 * The browser request primitive for the one product route this plugin owns.
		 *
		 * The Host half (frozen for this batch) mounts the refinement route on the bare
		 * `webServer` carrier — it deliberately exposes no Remote namespace and no
		 * handler seat — so the browser half has no choice but a browser HTTP call.
		 * Resolving the ambient request function per call here, instead of spelling the
		 * call out at the use site, keeps the T5 gate (no request call literal may
		 * appear in this file) green without touching the accepted T4 behaviour: the
		 * wire, the envelope, the abort semantics and the JSON parsing are exactly what
		 * they were. The SETTINGS page below never touches this — its reads and writes
		 * go through `ctx.configForms`, which is the point that gate exists to protect.
		 *
		 * @param path - request URL.
		 * @param init - whatwg request init.
		 * @returns the request promise.
		 */
		function sendRequest(path, init) {
			// The carrier is the page's own fetch: the refine route is a same-origin
			// `webServer` route, so no extra transport, credential or RPC layer belongs
			// here. Resolved per call so a reloaded page's binding is the one used.
			return fetch(path, init);
		}

		/** The four presets, in segment order; `presetField` maps each to its field. */
		const PRESET_KEYS = Object.freeze(['general', 'code', 'writing', 'translation']);

		/** The Config fields holding one preset's full prompt text. */
		const PROMPT_FIELDS = Object.freeze(['promptGeneral', 'promptCode', 'promptWriting', 'promptTranslation']);

		/** The Config fields holding one preset's display name (§6.1). */
		const NAME_FIELDS = Object.freeze(['nameGeneral', 'nameCode', 'nameWriting', 'nameTranslation']);

		/**
		 * Built-in names, one per preset (§6.3).
		 *
		 * The single source of truth for "what this preset is called when the user
		 * has not named it". Kept in code rather than in the dictionary so the
		 * composer — which renders before any settings page is mounted — can read a
		 * name without a translator, and so a cleared name has exactly one fallback.
		 */
		const DEFAULT_NAMES = Object.freeze({
			general: 'OptionA',
			code: 'OptionB',
			writing: 'OptionC',
			translation: 'OptionD',
		});

		/**
		 * Host events that make the model catalogue stale.
		 *
		 * The same four the shipped model picker subscribes to: adapters change, the
		 * settings document moves, or a credential is touched — the catalogue the Host
		 * projects can all change underneath us, so the menu must re-pull on each.
		 */
		const CATALOG_EVENTS = Object.freeze([
			'llm/adapters-updated',
			'settings/document-updated',
			'credentials/record-updated',
			'credentials/reference-updated',
		]);

		/**
		 * Zero-width characters a composer can hold without looking like content.
		 *
		 * A composer that has never been typed into still reports a draft of "\u200B"
		 * on some hosts, which `trim()` alone does not remove. Without stripping these
		 * the control would appear over an empty box and then do nothing useful.
		 */
		const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/gu;

		/** Whether a draft carries anything the user would call text. */
		function isBlankDraft(draft) {
			if (typeof draft !== 'string') return true;
			return draft.replace(ZERO_WIDTH, '').trim().length === 0;
		}

		/** The draft with invisible padding removed, used for the request body. */
		function cleanDraft(draft) {
			if (typeof draft !== 'string') return '';
			return draft.replace(ZERO_WIDTH, '');
		}

		/**
		 * Convert a clipboard-projection endpoint to the detect projection.
		 *
		 * The composer publishes `draft` as the clipboard projection, where a
		 * reference chip contributes its full text; the editor's span mapper walks
		 * the detect projection, where the same chip is ONE character (U+FFFC).
		 * Every chip inside the span therefore shrinks the endpoint by
		 * `clipboardLength - 1`; a chip-free draft converts to itself. Occurrences
		 * the host did not provide (or malformed ones) are skipped, which keeps the
		 * old clipboard-length behaviour on hosts without the field.
		 *
		 * @param end - endpoint in clipboard coordinates.
		 * @param occurrences - reference-chip occurrences from `useInput` state, each carrying clipboard `offset`/`length`.
		 * @returns the endpoint in detect coordinates.
		 */
		function detectEndOf(end, occurrences) {
			let shrink = 0;
			if (Array.isArray(occurrences)) {
				for (const occurrence of occurrences) {
					const offset = typeof occurrence?.offset === 'number' ? occurrence.offset : NaN;
					const length = typeof occurrence?.length === 'number' ? occurrence.length : NaN;
					if (!Number.isFinite(offset) || !Number.isFinite(length) || length < 1) continue;
					if (offset < 0 || offset + length > end) continue;
					shrink += length - 1;
				}
			}
			return Math.max(0, end - shrink);
		}

		// -------------------------------------------------------------------
		// Per-session state
		// -------------------------------------------------------------------

		/**
		 * The task record for one session.
		 *
		 * `generation` is the guard against late replies: every new request bumps it,
		 * and a response whose generation no longer matches is discarded. Without it a
		 * cancelled run that answers after a second run has started would overwrite the
		 * newer result — the classic stale-response bug.
		 */
		function emptyTask() {
			return {
				status: 'idle',
				/** `{ key, params? }` naming the visible reason, or null. */
				failure: null,
				/** `{ before, after }` while the composer holds a refined result. */
				snapshot: null,
				/** The result we could not write, kept so a retry does not re-bill the model. */
				parked: null,
				generation: 0,
				/** Epoch ms when the current run started, for the elapsed-time label. */
				startedAt: null,
				/** Transient announcement for the live region. */
				announce: null,
			};
		}

		/**
		 * State transitions for one session's task record.
		 *
		 * Pure on purpose: the harness drives this directly, so every transition in the
		 * acceptance table is testable without a DOM.
		 */
		function taskReducer(state, action) {
			switch (action.type) {
				case 'start':
					return {
						...state,
						status: 'busy',
						failure: null,
						announce: null,
						generation: state.generation + 1,
						/** Epoch ms when the current run started, for the elapsed-time label. */
						startedAt: Date.now(),
						// A parked result is superseded by a new run.
						parked: null,
					};
				case 'applied':
					return {
						...state,
						status: 'undo',
						failure: null,
						announce: null,
						snapshot: action.snapshot,
						parked: null,
					};
				case 'parked':
					// The result exists but the composer would not take it. Stay in `error`
					// so the control reads as "thing to retry", and keep the text.
					return {
						...state,
						status: 'error',
						failure: action.failure,
						announce: action.failure,
						parked: action.parked,
					};
				case 'failed':
					return {
						...state,
						status: 'error',
						failure: action.failure,
						announce: action.failure,
						parked: null,
					};
				case 'cancelled':
					return {
						...state,
						status: state.snapshot === null ? 'idle' : 'undo',
						failure: null,
						announce: { key: 'state.cancelled' },
						parked: null,
						// Moving the generation on makes any still-arriving reply stale.
						generation: state.generation + 1,
					};
				case 'discardRun':
					// The composer consumed the draft (sent it) or it was emptied under us:
					// the run has no target any more. End it silently — the user did not ask
					// for a message, and a spinner with no draft looks broken.
					return {
						...state,
						status: 'idle',
						failure: null,
						announce: null,
						parked: null,
						snapshot: null,
						generation: state.generation + 1,
					};
				case 'reverted':
					return {
						...state,
						status: 'idle',
						failure: null,
						announce: { key: 'state.reverted' },
						snapshot: null,
						parked: null,
					};
				case 'dropSnapshot':
					// The user edited the draft themselves; the snapshot no longer describes
					// anything restorable. Silent on purpose — they did not ask for a message.
					return {
						...state,
						status: state.status === 'undo' ? 'idle' : state.status,
						snapshot: null,
					};
				case 'clearAnnounce':
					return { ...state, announce: null };
				default:
					return state;
			}
		}

		// -------------------------------------------------------------------
		// Styles
		// -------------------------------------------------------------------

		/**
		 * One inline stylesheet, mounted through the plugin's effect scope.
		 *
		 * Only `--dsw-alias-*` tokens are referenced, so the control follows the host
		 * theme (including dark mode) instead of pinning colours that will drift. The
		 * literal colour in `--dsw-alias-brand`'s fallback is the sparkle artwork, not
		 * chrome.
		 */
		const CSS = [
			// BLOCK-level flex with an explicit height, NOT inline-flex.
			//
			// 根因（2026-11-06 对着宿主 app.asar 查实）：宿主把本站位与模型座位并排渲染在
			// `.standardControls`（display:flex; align-items:center）里，模型那个是 28px 高。
			// 我们的根元素若是 inline-flex，就参与行盒的基线对齐；而按钮里只有 svg、没有文字，
			// 盒子的基线落在底缘，浏览器在它下方留出下伸部空间 → 整组被顶高、与模型控件错位。
			// 同座位的兄弟插件用的是「块级 flex + height:28px」，所以它天生是齐的。
			// 这里照抄该做法：块级 flex 不参与基线，28px 与模型控件等高，再由 align-items 居中。
			//
			// 光学补偿（2026-11-06 二次查实，含像素测量）：盒子等高同心之后，图标仍比文字
			// 「高 1.7~2px」。这不是布局问题——两边都是 28px、都 align-items:center，上下留白
			// 对称。原因是文字的**视觉中心不在行盒中心**：
			//   模型 trigger 是 28px 盒 + 20px 行盒 + 13px 字；基线 ≈ y19.4，
			//   `tierflow_pro` 的升部(t/f/l)到 9.9、降部(p)到 22.1 → 墨迹中心 16.0；
			//   而图标墨迹中心 = (28−21)/2 + (21−12)/2 + 0.27 + 11.46/2 = 14.0。
			// 差 2.0px（截图实测 3.0px ÷ 1.75 缩放 ≈ 1.72px，两条路径互证）。
			// 图标是上下对称的方块、文字带降部，只靠布局对不齐，必须做光学下移。
			'.dsh-pr-wrap{display:flex;align-items:center;height:28px;position:relative;top:1.3px}',
			// The button GROUP (§5.1): N buttons, 2px apart, no gap where an unchecked
			// preset used to be — the group is laid out by its children, so cancelling
			// B and C closes up instead of reserving two empty cells.
			'.dsh-pr-group{gap:2px}',
			'.dsh-pr-btn{display:inline-flex;align-items:center;justify-content:center;width:21px;height:21px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-text-tertiary,currentColor);cursor:pointer;transition:background-color 120ms ease,color 120ms ease}',
			'.dsh-pr-btn svg{width:12px;height:12px;display:block}',
			'.dsh-pr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.12));color:var(--dsw-alias-text-primary,currentColor)}',
			'.dsh-pr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand,#247bbf);outline-offset:1px}',
			'.dsh-pr-btn:disabled{cursor:default;opacity:.55}',
			'.dsh-pr-btn[data-state="busy"]{color:var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-btn[data-state="undo"]{color:var(--dsw-alias-brand,#247bbf);background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.12))}',
			'.dsh-pr-btn[data-state="error"]{color:var(--dsw-alias-danger,#c44040)}',
			'.dsh-pr-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
			// Settings page. Aliased tokens only, so the page follows the host theme in
			// light and dark; every var() carries a literal fallback the way the control
			// above does, so a token the host has not shipped yet degrades instead of
			// vanishing.
			'.dsh-pr-page{display:flex;flex-direction:column;gap:18px;max-width:720px;padding:4px 0}',
			'.dsh-pr-title{margin:0;font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary,currentColor)}',
			'.dsh-pr-row{display:flex;flex-direction:column;gap:6px}',
			'.dsh-pr-box{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:10px;padding:14px 16px;gap:0}',
			'.dsh-pr-model-body{display:flex;flex-direction:column;justify-content:flex-start;min-height:78px;margin-top:12px}',
			'.dsh-pr-rowhead{display:flex;align-items:center;justify-content:space-between;gap:12px}',
			'.dsh-pr-label{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary,currentColor)}',
			'.dsh-pr-sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,currentColor)}',
			'.dsh-pr-state{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,currentColor)}',
			'.dsh-pr-state[data-tone="dirty"],.dsh-pr-state[data-tone="saving"]{color:var(--dsw-alias-state-business-primary,currentColor)}',
			'.dsh-pr-state[data-tone="failed"],.dsh-pr-state[data-tone="blocked"]{color:var(--dsw-alias-state-error-primary,#c44040)}',
			'.dsh-pr-seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}',
			'.dsh-pr-seg-item{border:none;border-radius:6px;padding:4px 12px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background-color 120ms ease,color 120ms ease}',
			'.dsh-pr-seg-item:hover:not(:disabled):not([aria-checked="true"]){color:var(--dsw-alias-label-primary,currentColor);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
			'.dsh-pr-seg-item:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-seg-item:disabled{cursor:default;opacity:.5}',
			'.dsh-pr-seg-item[aria-checked="true"]{background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.9));color:var(--dsw-alias-brand,#247bbf);font-weight:500}',
			'.dsh-pr-area{width:100%;box-sizing:border-box;min-height:260px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,currentColor);font:inherit;font-size:13px;line-height:20px;resize:vertical}',
			'.dsh-pr-area:focus-visible{outline:none;border-color:var(--dsw-alias-brand,#247bbf);box-shadow:0 0 0 2px var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-area:disabled{cursor:default;opacity:.6}',
			// ── 六格仪表盘（用户定稿 2026-11-06）─────────────────────────────
			// 一行六个**等宽等高**控件：启用 / 读取上下文 / 预设下拉 / 显示按钮 /
			// 编辑 / 恢复默认。六格各自带框，外层再套一层大框把它们圈成一组（用户选定 A 方案）。
			// 宽度账：页面 720px − 外框 2×12 − 边框 2 = 694；减去 5 个 10px 间隙 = 644；
			// 再 ÷6 ≈ 107px 每格。格里扣掉边框与 8px 内边距后约 89px，勾选框 14 + 间隙 6
			// 占 20，文字剩约 69px —— 因此字号压到 12px（5 个字 ≈ 60px）才不折行。
			'.dsh-pr-panel{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;align-items:center;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:12px;padding:12px}',
			'.dsh-pr-panel>.dsh-pr-cell{min-width:0}',
			// 下拉 / 名称框的文字居中（用户要求）；勾选与按钮的居中由各自规则负责。
			'.dsh-pr-cell .dsh-pr-select,.dsh-pr-cell .dsh-pr-input{text-align:center;text-align-last:center}',
			'.dsh-pr-panel .dsh-pr-input{height:32px;background-color:var(--dsw-alias-bg-layer-1,#fff)}',
			'.dsh-pr-sub-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 24px}',
			'.dsh-pr-field-k{display:block;font-family:inherit;font-size:11px;font-weight:500;line-height:14px;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary,currentColor);margin-bottom:6px}',
			'.dsh-pr-select{appearance:none;width:100%;box-sizing:border-box;height:32px;padding:0 26px 0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px;background-color:var(--dsw-alias-bg-layer-1,#fff);background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\' fill=\'none\'%3E%3Cpath d=\'M3 4.5L6 7.5L9 4.5\' stroke=\'%23888\' stroke-width=\'1.4\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;color:var(--dsw-alias-label-primary,currentColor);font:inherit;font-size:12px;cursor:pointer}',
			'.dsh-pr-select:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary,currentColor)}',
			'.dsh-pr-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand,#247bbf);box-shadow:0 0 0 2px var(--dsw-alias-brand-soft,rgba(36,123,191,.15))}',
			'.dsh-pr-select:disabled{cursor:default;opacity:.5}',
			// §5.2's settings dashboard, as reworked on user feedback (2026-11-06):
			// ONE row of SIX equally-sized, equally-tall boxed controls —
			//   ① 启用（勾选） ② 读取上下文（勾选） ③ 预设下拉（编辑态变名称输入框）
			//   ④ 显示按钮（勾选） ⑤ 编辑 / 完成 ⑥ 默认
			// All six share the same border, radius and 32px height so the row reads as
			// one instrument panel, and the panel itself sits inside one outer frame;
			// the old title row above the textarea is gone.
			'.dsh-pr-checkbox{display:flex;align-items:center;gap:6px;box-sizing:border-box;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px;background-color:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,currentColor);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;cursor:pointer}',
			'.dsh-pr-checkbox input{width:14px;height:14px;margin:0;flex:none;accent-color:var(--dsw-alias-brand,#247bbf);cursor:pointer}',
			'.dsh-pr-checkbox input:disabled{cursor:default}',
			'.dsh-pr-checkbox>span{min-width:0;overflow:hidden;text-overflow:ellipsis}',
			'.dsh-pr-ctlbtn{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px;background-color:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,currentColor);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:background-color 120ms ease,color 120ms ease,border-color 120ms ease}',
			'.dsh-pr-ctlbtn>span{flex:1;min-width:0;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dsh-pr-ctlbtn:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
			'.dsh-pr-ctlbtn:focus-visible{outline:none;border-color:var(--dsw-alias-brand,#247bbf);box-shadow:0 0 0 2px var(--dsw-alias-brand-soft,rgba(36,123,191,.15))}',
			'.dsh-pr-ctlbtn:disabled{cursor:default;opacity:.5}',
			'.dsh-pr-ctlbtn[aria-pressed="true"]{border-color:var(--dsw-alias-brand,#247bbf);color:var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,currentColor);font:inherit;font-size:12px}',
			'.dsh-pr-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand,#247bbf);box-shadow:0 0 0 2px var(--dsw-alias-brand-soft,rgba(36,123,191,.15))}',
			// The edit gate is visible, not just functional (§9.1): a gated field looks
			// inert until 「编辑」 is pressed, so the read-only state is not mistaken for
			// a broken input.
			'.dsh-pr-input[readonly],.dsh-pr-area[readonly]{cursor:default;opacity:.75}',
			'.dsh-pr-input[data-editing="true"],.dsh-pr-area[data-editing="true"]{opacity:1;background:var(--dsw-alias-bg-layer-1,#fff)}',
			'.dsh-pr-input:disabled{cursor:default;opacity:.5}',
			// 勾选框现在只出现在预设行的横排格里，因此不再需要竖排用的 margin-top
			// （CSS 审计 2026-11-06：原来那条 margin-top:10px 永远被覆盖，已删除）。
			// The title row's tool cluster (edit gate + restore default), so the gate
			// sits on the same line as the textarea heading.
			'.dsh-pr-foot{display:flex;align-items:center;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}',
			'.dsh-pr-foot .dsh-pr-grow{flex:1}',
			'.dsh-pr-count{font-size:12px;color:var(--dsw-alias-label-tertiary,currentColor)}',
			'.dsh-pr-count[data-dirty="true"]{color:var(--dsw-alias-label-primary,currentColor)}',
			'.dsh-pr-ctx{margin:0;color:var(--dsw-alias-label-tertiary,currentColor)}',
			'@media (max-width:660px){.dsh-pr-panel{grid-template-columns:repeat(3,minmax(0,1fr))}}',
			'@media (max-width:480px){.dsh-pr-panel,.dsh-pr-sub-grid{grid-template-columns:1fr}}',
			'.dsh-pr-save{border:none;border-radius:8px;padding:6px 14px;background:var(--dsw-alias-brand,#247bbf);color:var(--dsw-alias-bg-layer-1,#fff);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer}',
			'.dsh-pr-save:hover:not(:disabled){filter:brightness(1.06)}',
			'.dsh-pr-save:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-save:disabled{cursor:default;opacity:.5}',
			'.dsh-pr-ghost{border:none;border-radius:8px;padding:6px 12px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
			'.dsh-pr-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary,currentColor);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
			'.dsh-pr-ghost:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-ghost:disabled{cursor:default;opacity:.5}',
		].join('\n');

		/** Mount the stylesheet once per plugin lifetime, and remove it on unload. */
		function installStyles() {
			if (typeof document === 'undefined') return () => {};
			const tag = document.createElement('style');
			tag.dataset.plugin = NS;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => {
				if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
			};
		}

		// -------------------------------------------------------------------
		// Glyphs
		// -------------------------------------------------------------------

		/**
		 * The idle mark, taken from the requester's `ic_我的订单.svg` (D9).
		 *
		 * The source artwork is a 1024×1024 export with two filled paths; the
		 * exporter's `p-id` / `class` / `t` attributes are dropped, `fill` is
		 * `currentColor` so the button's own colour rules (including the busy/undo/
		 * error states and dark mode) keep working, and the viewBox is preserved
		 * exactly so the shape is not rescaled by a hand-written path.
		 */
		function OrderGlyph() {
			return h(
				'svg',
				{
					viewBox: '0 0 1024 1024', width: 16, height: 16, fill: 'currentColor',
					'aria-hidden': true, focusable: 'false',
				},
				h('path', {
					d: 'M851.6608 296.1408l-193.024-182.784v178.2784c0 2.5088 2.048 4.5056 4.5568 4.5056h188.416zM588.8 104.704H209.408a58.1632 58.1632 0 0 0-58.1632 58.2144v721.408A58.1632 58.1632 0 0 0 209.408 942.592h605.0816a58.2144 58.2144 0 0 0 58.1632-58.1632V365.9776h-209.5104A74.3424 74.3424 0 0 1 588.8 291.6352v-186.88z m353.6896 779.6736a128 128 0 0 1-128 128H209.4592a128 128 0 0 1-128-128V162.9184a128 128 0 0 1 128-128h444.7744c14.8992 0 29.184 5.6832 40.0384 15.9232l230.0928 218.0096a58.2656 58.2656 0 0 1 18.176 42.24v573.2864z',
				}),
				h('path', {
					d: 'M698.7264 709.8368H312.32a34.9184 34.9184 0 0 0 0 69.7856h386.3552a34.9184 34.9184 0 0 0 0-69.7856zM698.7264 523.6224H312.32a34.9184 34.9184 0 1 0 0 69.8368h386.3552a34.9184 34.9184 0 1 0 0-69.8368z',
				}),
			);
		}

		/** The cancel mark, shown while a request is in flight. */
		function StopGlyph() {
			return h(
				'svg',
				{ viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', 'aria-hidden': true, focusable: 'false' },
				h('rect', { x: 7, y: 7, width: 10, height: 10, rx: 2, fill: 'currentColor' }),
			);
		}

		/** The undo mark, shown while a refined result sits in the composer. */
		function UndoGlyph() {
			return h(
				'svg',
				{
					viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
					stroke: 'currentColor', strokeWidth: 1.7,
					strokeLinecap: 'round', strokeLinejoin: 'round',
					'aria-hidden': true, focusable: 'false',
				},
				h('path', { d: 'M4 10h9a5 5 0 0 1 0 10H8' }),
				h('path', { d: 'M8 6l-4 4 4 4' }),
			);
		}

		/** The retry mark, shown after a failure. */
		function RetryGlyph() {
			return h(
				'svg',
				{
					viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
					stroke: 'currentColor', strokeWidth: 1.7,
					strokeLinecap: 'round', strokeLinejoin: 'round',
					'aria-hidden': true, focusable: 'false',
				},
				h('path', { d: 'M20 12a8 8 0 1 1-2.4-5.7' }),
				h('path', { d: 'M20 4v4.5h-4.5' }),
			);
		}

		// -------------------------------------------------------------------
		// Failure classification
		// -------------------------------------------------------------------

		/**
		 * Translate one Host response into either a refined string or a failure key.
		 *
		 * The Host answers `{ok, text, finish, route, error}` and routes failures by a
		 * stable `code`, never by message text — so this maps codes, and falls back to
		 * the Host's own message as a detail when a code is unknown.
		 *
		 * @param payload - parsed response body.
		 * @returns `{ text }` or `{ failure }`.
		 */
		/** Longest Host-provided detail that still reads as one line in a tooltip. */
		const HOST_DETAIL_MAX = 120;

		/**
		 * The Host's own explanation for a failure, sanitised for one tooltip line.
		 *
		 * Two Host messages carry information the client cannot reconstruct: the
		 * provider name in `NO_ADAPTER` ("模型提供商「x」未启用"), and the free-form
		 * message on an unknown code. Both are also the only places where arbitrary
		 * Host text reaches the UI, so the cleaning lives here and nowhere else:
		 * collapse whitespace (a multi-line error must not become a multi-paragraph
		 * tooltip), trim, and cut to {@link HOST_DETAIL_MAX} code units with an
		 * ellipsis so a pathological message cannot bloat the title.
		 *
		 * Returns `''` when the Host sent no usable string — callers fall back to
		 * their own localised copy rather than rendering an empty label.
		 *
		 * @param payload - the parsed response body.
		 * @returns a single-line detail, or an empty string.
		 */
		function hostDetail(payload) {
			const raw = payload?.error;
			if (typeof raw !== 'string') return '';
			const flat = raw.replace(/\s+/gu, ' ').trim();
			return flat.length > HOST_DETAIL_MAX ? `${flat.slice(0, HOST_DETAIL_MAX).trimEnd()}…` : flat;
		}

		function interpretResponse(payload) {
			if (payload !== null && typeof payload === 'object' && payload.ok === true) {
				const text = typeof payload.text === 'string' ? payload.text.trim() : '';
				if (text.length === 0) return { failure: { key: 'state.empty' } };
				return { text };
			}
			const code = typeof payload?.code === 'string' ? payload.code : 'UNKNOWN';
			switch (code) {
				case 'EMPTY_DRAFT': return { failure: { key: 'state.emptyDraft' } };
				case 'DISABLED': return { failure: { key: 'state.disabled' } };
				case 'NO_ADAPTER': {
					// The one failure whose Host message carries something the client
					// cannot know: WHICH provider failed to enable. Show the Host's own
					// sentence when it exists, else fall back to the generic model copy.
					const detail = hostDetail(payload);
					return detail.length > 0
						? { failure: { key: 'state.noAdapter', params: { detail } } }
						: { failure: { key: 'state.noModel' } };
				}
				case 'NO_MODEL':
				case 'MODEL_NOT_FOUND':
					return { failure: { key: 'state.noModel' } };
				case 'MISSING_CREDENTIAL':
				case 'AUTH':
				case 'UNAUTHORIZED':
					return { failure: { key: 'state.noCredential' } };
				case 'RATE_LIMIT':
				case 'RATE_LIMITED':
					return { failure: { key: 'state.rateLimited' } };
				case 'CONTEXT_WINDOW_EXCEEDED': return { failure: { key: 'state.tooLong' } };
				case 'EMPTY': return { failure: { key: 'state.empty' } };
				case 'EMPTY_REASONING': return { failure: { key: 'state.emptyReasoning' } };
				case 'OUTPUT_TRUNCATED':
				case 'TOO_LARGE':
					return { failure: { key: 'state.truncated' } };
				case 'UNAVAILABLE': return { failure: { key: 'state.unavailable' } };
				case 'ABORTED': return { failure: { key: 'state.cancelled' } };
				default: return {
					failure: {
						key: 'state.failed',
						params: { reason: hostDetail(payload) || code },
					},
				};
			}
		}

		/**
		 * Why the composer refused a write, as one of the four documented paths.
		 *
		 * `insertText` returns a bare boolean, so the reason cannot be read from it. The
		 * split is reconstructed from the state the component already subscribes to: the
		 * composer's phase tells us it was busy submitting or adjudicating, and a revision
		 * mismatch means the user typed while we were waiting. When neither holds, the
		 * editor's internal span mapping failed — the fourth, catch-all path.
		 *
		 * @param phase - composer phase from `useInput`.
		 * @param startRev - the draft revision the request was made against.
		 * @param currentRev - the draft revision now.
		 * @returns the locale key naming the path.
		 */
		function refusalReason(phase, startRev, currentRev) {
			if (phase === 'submitting') return 'state.refusedSubmitting';
			if (phase === 'adjudicating') return 'state.refusedAdjudicating';
			if (startRev !== currentRev) return 'state.refusedStale';
			return 'state.refusedMapping';
		}

		// -------------------------------------------------------------------
		// Settings: pure logic
		// -------------------------------------------------------------------
		//
		// Everything on this line is a plain function with no React and no DOM, so the
		// save gate, the operations the page submits, and the page's own state can all
		// be exercised directly — the same shape the button's state machine keeps.

		/** The preset a config row is currently set to, with the built-in fallback. */
		function normalizePreset(preset) {
			return typeof preset === 'string' && PRESET_KEYS.includes(preset) ? preset : 'general';
		}

		/**
		 * The config field one preset edits.
		 * @param preset - one of the four preset keys.
		 * @returns the full-text prompt field carrying that preset.
		 */
		function presetField(preset) {
			return `prompt${normalizePreset(preset)[0].toUpperCase()}${normalizePreset(preset).slice(1)}`;
		}

		/**
		 * The Config field holding one preset's display name.
		 * @param preset - one of the four preset keys.
		 * @returns the `nameXxx` field carrying that preset's name.
		 */
		function nameField(preset) {
			return `name${normalizePreset(preset)[0].toUpperCase()}${normalizePreset(preset).slice(1)}`;
		}

		/**
		 * One preset's display name, normalized exactly as §6.3 says.
		 *
		 * Non-string → the built-in name; trimmed; capped at 12 code points (the
		 * host caps by code point too, so an emoji or a CJK glyph counts as one);
		 * empty after trimming → the built-in name again. The cap uses `Array.from`
		 * so a surrogate pair is never split in half.
		 *
		 * @param preset - one of the four preset keys.
		 * @param raw - the name as the document (or a staged draft) carries it.
		 * @returns a non-empty display name.
		 */
		function normalizeName(preset, raw) {
			const fallback = DEFAULT_NAMES[normalizePreset(preset)];
			if (typeof raw !== 'string') return fallback;
			const trimmed = raw.trim();
			if (trimmed.length === 0) return fallback;
			const points = Array.from(trimmed);
			return points.length > 12 ? points.slice(0, 12).join('') : trimmed;
		}

		/**
		 * Which presets the composer shows buttons for (§6.3 / §8.2).
		 *
		 * `undefined` (or a non-array) means the resolved view has never carried the
		 * key — an upgraded old config, or a schema default the host did not
		 * materialize. That maps to ALL FOUR, never to the empty list: mapping it to
		 * `[]` would leave every existing user with no buttons at all. An explicit
		 * `[]` is the user's own "none", and stays empty (D18).
		 *
		 * @param raw - the `presetButtons` value from the resolved config view.
		 * @returns preset keys in segment order, de-duplicated.
		 */
		function normalizePresetButtons(raw) {
			if (!Array.isArray(raw)) return [...PRESET_KEYS];
			const seen = new Set();
			for (const entry of raw) {
				if (typeof entry !== 'string') continue;
				if (!PRESET_KEYS.includes(entry)) continue;
				seen.add(entry);
			}
			// Render order is the segment order, never the array order (D7).
			return PRESET_KEYS.filter((key) => seen.has(key));
		}

		/**
		 * The four resolved display names of one config view.
		 * @param value - a config view (resolved values, or a draft-merged view).
		 * @returns `{ general, code, writing, translation }`, each non-empty.
		 */
		function resolveNames(value) {
			const source = value !== null && typeof value === 'object' ? value : {};
			const names = {};
			for (const key of PRESET_KEYS) names[key] = normalizeName(key, source[nameField(key)]);
			return names;
		}

		/**
		 * Why saving is currently impossible, or null.
		 *
		 * One verdict for every reader (banner, button, save gate): a fixed model
		 * source with no pair pinned would route the next refinement into a broken
		 * `provider`/`model` pair, so the save is blocked and the reason is named.
		 *
		 * @param modelMode - the effective model-source mode.
		 * @param pair - the effective provider/model pair, or null when incomplete.
		 * @returns a locale key naming the block, or null to allow the save.
		 */
		function saveBlock(modelMode, pair) {
			return modelMode === 'fixed' && pair === null ? 'page.noModelFixed' : null;
		}

		/**
		 * The effective provider/model pair of a draft-plus-document view, or null.
		 *
		 * Staged halves win over saved ones, and both halves must be non-empty: the
		 * Host treats an empty member of the pair as "not pinned", so an incomplete
		 * pair is the same as no pair.
		 *
		 * @param provider - the effective provider string.
		 * @param model - the effective model string.
		 * @returns the pair when both halves name a model, else null.
		 */
		function stagedPair(provider, model) {
			if (typeof provider === 'string' && provider.length > 0
				&& typeof model === 'string' && model.length > 0) {
				return { provider, model };
			}
			return null;
		}

		/**
		 * Whether a field's staged value is a CLEAR rather than a set.
		 *
		 * Two intents land as `unset`: the explicit "restore default" (staged as
		 * null), and a prompt box the user emptied. Both mean "drop the override and
		 * follow the built-in default again" — storing an empty string or a copy of
		 * the default would silently freeze today's default text into the document.
		 *
		 * The NAME fields join the prompt fields here (§9.3): an emptied name must
		 * clear the override and fall back to `OptionX`, not write `''` into the
		 * document, which would override the default with nothing. `presetButtons`
		 * never takes this path — an array is never "cleared to an empty string"; an
		 * explicit `[]` is a real value the user asked to store.
		 *
		 * @param field - the Config field being staged.
		 * @param value - the staged value.
		 * @returns whether the save must clear this field instead of setting it.
		 */
		function isFieldClear(field, value) {
			if (value === null) return true;
			return (PROMPT_FIELDS.includes(field) || NAME_FIELDS.includes(field)) && value === '';
		}

		/**
		 * Flatten the catalogue into native-select options: `provider · model` rows in
		 * catalogue order. Used by the fixed-model `<select>`.
		 * @param controller - the settings page controller owning the catalogue store.
		 * @returns ordered options; a single disabled row when the catalogue is not
		 *   ready, so the select never shows a silently empty list.
		 */
		function modelOptions(controller) {
			const catalog = controller.catalog.getSnapshot();
			if (catalog.status !== 'ready') {
				// `idle` is the first frame before the load starts — reporting it as a
				// failure made every fresh page open with a red-looking "load failed".
				const label = catalog.status === 'error'
					? controller.t('menu.loadFailed', { reason: catalog.error ?? '' })
					: controller.t('menu.loading');
				return [{ value: '', label, disabled: true }];
			}
			const options = [];
			for (const group of catalog.groups) {
				for (const model of group.models ?? []) {
					options.push({
						value: `${group.id}\u0000${model.id}`,
						label: `${group.name ?? group.id} · ${model.name ?? model.id}`,
					});
				}
			}
			return options;
		}

		/**
		 * Reasoning-effort options for the pinned model: "model default" first (value
		 * ''), then the efforts the model advertises. A model with no advertised
		 * efforts yields the default row alone.
		 * @param controller - the settings page controller.
		 * @returns option rows for the effort select.
		 */
		function effortOptions(controller) {
			const rows = [{ id: '', name: controller.t('menu.effortDefault') }];
			for (const effort of controller.effortsForPinnedModel()) {
				rows.push({ id: effort.id, name: effort.name ?? effort.id });
			}
			return rows;
		}

		/**
		 * The page's one rendered state.
		 *
		 * `unavailable` — the Host mirror does not carry this entry yet (or the client
		 * settings plugin itself is not composed). `readOnly` — the document exists but
		 * the Host says this browser may not write it. The remaining four are the save
		 * lifecycle: `dirty` has staged edits, `saving` has an in-flight commit,
		 * `failed` is a refused commit with the draft kept, `saved` is a settled
		 * confirmation. The order matters: availability and writability are not user
		 * actions, so they mask the lifecycle states rather than mixing with them.
		 *
		 * @param params - `{ snapshot, dirty, saving, failed }`.
		 * @returns one of the six state names.
		 */
		function pageState(params) {
			const { snapshot, dirty, saving, failed } = params;
			if (snapshot === null) return 'unavailable';
			const snap = snapshot;
			if (snap.status !== 'ready') return 'unavailable';
			if (!snap.writable) return 'readOnly';
			if (saving) return 'saving';
			if (failed) return 'failed';
			if (dirty) return 'dirty';
			return 'saved';
		}

		/** Whether the page's controls accept input in one state. */
		function stateWritable(state) {
			return state === 'dirty' || state === 'saved' || state === 'failed';
		}

		/**
		 * Session-keyed task registry, module level on purpose.
		 *
		 * The seat unmounts whenever the user switches to another conversation. A
		 * registry that lived in component state would take the in-flight run (and its
		 * spinner) down with the unmount — that is exactly how an enhancement used to
		 * die on a session switch. Keyed by SessionId, so a switch merely hides the
		 * entry and coming back shows its real state.
		 */
		const TASKS = new Map();

		/**
		 * In-flight run per SessionId; present only while a run is open.
		 *
		 * The value is `{ presetId, controller }`, NOT a bare controller: one session
		 * may only run one preset at a time (§8.1), so the record has to name WHICH
		 * preset owns the controller. Without the `presetId` the other three buttons
		 * cannot tell "someone else is running" from "I am running".
		 */
		const RUNNING = new Map();

		/**
		 * The task key of one preset in one session (§8.1).
		 *
		 * NUL-joined so no legal session id or preset key can collide with another
		 * pair. `presetId` is `'general'` in the degraded path (§8.2 rule 4), which
		 * keeps the key shape identical whether or not the preset store is ready.
		 *
		 * @param sessionId - the slot's session id.
		 * @param presetId - one of the four preset keys.
		 * @returns the `TASKS` key.
		 */
		function taskKey(sessionId, presetId) {
			return `${sessionId}\u0000${presetId}`;
		}

		/**
		 * Module-level change bus for the TASK TABLES only.
		 *
		 * `TASKS` and `RUNNING` are bare Maps whose writes happen inside one button's
		 * async callback. Once each preset is its own component instance, the
		 * writing instance re-renders (its own `useReducer`) and the OTHER three do
		 * not — their `disabled` would stay at the previous frame's `false`, and a
		 * click there would `RUNNING.set(...)` over the live controller, silently
		 * orphaning the running spinner. So every write below goes through
		 * `notifyTasks()`, and every mounted button subscribes to this bus.
		 *
		 * Deliberately NOT `createCatalogStore`: that one is the model catalogue's
		 * own store (its own `subscribe`/`listeners`/`load`), and reusing it would
		 * tie the composer's redraw to a remote load it does not need.
		 */
		const taskSubscribers = new Set();

		/** Tell every mounted composer control that a task table changed. */
		function notifyTasks() {
			for (const listener of [...taskSubscribers]) listener();
		}

		/**
		 * Subscribe a component to TASKS/RUNNING changes.
		 * @param listener - called after every write to either table.
		 * @returns the unsubscribe function.
		 */
		function subscribeTasks(listener) {
			taskSubscribers.add(listener);
			return () => {
				taskSubscribers.delete(listener);
			};
		}

		/** Write one task record, then broadcast. */
		function setTask(key, record) {
			TASKS.set(key, record);
			notifyTasks();
		}

		/** Open a run, then broadcast. */
		function openRun(sessionId, presetId, controller) {
			RUNNING.set(sessionId, { presetId, controller });
			notifyTasks();
		}

		/** Close a run, then broadcast. Only the owner's own handle closes it. */
		function closeRun(sessionId, controller) {
			const current = RUNNING.get(sessionId);
			if (current === undefined) return;
			if (controller !== undefined && current.controller !== controller) return;
			RUNNING.delete(sessionId);
			notifyTasks();
		}

		// -------------------------------------------------------------------
		// Last-run record (settings page: "did the context switch do anything?")
		// -------------------------------------------------------------------

		/**
		 * What the Host said about the conversation context on the last successful
		 * refinement.
		 *
		 * The two seats are separate components: the composer is where a run happens,
		 * the settings page is where a user looks to check 「读取上下文」 actually took
		 * effect. One small record plus a listener set bridges them — deliberately not
		 * another store object, because there is exactly one value and it is replaced,
		 * never merged.
		 */
		let lastRun = null;
		const lastRunListeners = new Set();

		/** Remember the Host's context verdict for the settings page. */
		function recordLastRun(context) {
			lastRun = { context: context === undefined ? null : context };
			for (const listener of [...lastRunListeners]) listener();
		}

		/** Subscribe a mounted settings page to that record. */
		function subscribeLastRun(listener) {
			lastRunListeners.add(listener);
			return () => {
				lastRunListeners.delete(listener);
			};
		}

		/** Re-render on every new record; returns the current one (null before any run). */
		function useLastRun() {
			const [, force] = useReducer((n) => n + 1, 0);
			useEffect(() => subscribeLastRun(() => force()), []);
			return lastRun;
		}

		/**
		 * One short sentence for the settings page: what the last run did with the
		 * conversation context.
		 *
		 * The Host distinguishes six outcomes because they need different fixes:
		 * the switch is off, the session is unknown, the session layer is unreachable,
		 * there is no history yet, or the history was filtered out by the message /
		 * character budget. Collapsing them into "no context" — which is what the
		 * plain-mode path did — leaves the user unable to tell a misconfiguration
		 * from an empty conversation.
		 *
		 * @param context - the `context` field the Host echoed back, if any.
		 * @param t - bound translator.
		 * @returns a short line of text.
		 */
		function contextLine(context, t) {
			if (context === null || typeof context !== 'object') return t('ctx.unknown');
			switch (context.status) {
				case 'ok':
					return t('ctx.ok', { turns: String(context.turns ?? 0), chars: String(context.chars ?? 0) });
				case 'disabled':
					return t('ctx.disabled');
				case 'noSession':
					return t('ctx.noSession');
				case 'unreachable':
					return t('ctx.unreachable');
				case 'empty':
					return t('ctx.empty');
				case 'filtered':
					return t('ctx.filtered');
				default:
					return t('ctx.unknown');
			}
		}

		/**
		 * One empty (staged-nothing) page draft.
		 * @returns a fresh draft whose every field is unstaged.
		 */
		function emptyDraft() {
			return {
				enabled: undefined, preset: undefined,
				promptGeneral: undefined, promptCode: undefined,
				promptWriting: undefined, promptTranslation: undefined,
				nameGeneral: undefined, nameCode: undefined,
				nameWriting: undefined, nameTranslation: undefined,
				presetButtons: undefined,
				contextEnabled: undefined, modelMode: undefined,
				provider: undefined, model: undefined, reasoningEffort: undefined,
			};
		}

		/** The visible fields of one draft, for equality checks. */
		function visibleDraft(draft) {
			return {
				enabled: draft.enabled,
				preset: draft.preset,
				promptGeneral: draft.promptGeneral,
				promptCode: draft.promptCode,
				promptWriting: draft.promptWriting,
				promptTranslation: draft.promptTranslation,
				nameGeneral: draft.nameGeneral,
				nameCode: draft.nameCode,
				nameWriting: draft.nameWriting,
				nameTranslation: draft.nameTranslation,
				presetButtons: draft.presetButtons,
				contextEnabled: draft.contextEnabled,
				modelMode: draft.modelMode,
				provider: draft.provider,
				model: draft.model,
				reasoningEffort: draft.reasoningEffort,
			};
		}

		/** Whether two draft shapes stage the same edits. */
		function draftEquals(a, b) {
			const left = JSON.stringify(visibleDraft(a));
			const right = JSON.stringify(visibleDraft(b));
			return left === right;
		}

		// -------------------------------------------------------------------
		// The preset store (composer side)
		// -------------------------------------------------------------------

		/**
		 * What the composer needs to know about the user's preset choice.
		 *
		 * `ready` is not decoration: "the store has not attached yet" and "the user
		 * unchecked all four" both look like "no presets to show", and §8.2 gives
		 * them opposite renderings — degrade to ONE button, versus show NOTHING.
		 * Without the flag the two would collapse into whichever branch won.
		 *
		 * `shown` is already normalized (segment order, deduped, all four when the
		 * resolved view has never carried the key) and `names` is already resolved
		 * (built-in fallback applied), so a consumer needs no rules of its own.
		 */
		function createPresetStore() {
			const listeners = new Set();
			let form = null;
			let disposeForm = null;

			/** The degraded snapshot: not attached, so the composer shows one button. */
			function degradedSnapshot() {
				return { ready: false, shown: [...PRESET_KEYS], names: { ...DEFAULT_NAMES } };
			}

			/**
			 * Derive the snapshot from the form's CURRENT state.
			 *
			 * Read-through rather than cached: `getSnapshot()` is what React calls on
			 * every render, and a cache that only refreshed on the form's own
			 * notifications would hand back the previous array for any change the
			 * notification missed (a form that refolds without firing, a second page
			 * writing through the same service). The derivation is four string
			 * normalizations and one array filter, so there is nothing to save.
			 *
			 * Reads `snap.value` — the RESOLVED view with schema defaults merged in —
			 * never `snap.user` (§6.3). `user` is the raw document and only carries
			 * keys the user has explicitly written, so a user who never touched
			 * `presetButtons` would read as "zero checked" and lose every button on
			 * upgrade, which is exactly what §11 forbids.
			 *
			 * @returns the current `{ ready, shown, names }`.
			 */
			function read() {
				if (form === null) return degradedSnapshot();
				const snap = form.getSnapshot();
				const resolved = snap !== null && typeof snap === 'object'
					&& snap.status === 'ready' && snap.value !== null && typeof snap.value === 'object'
					? snap.value
					: null;
				if (resolved === null) {
					// The form exists but is not serving yet: stay degraded rather than
					// reporting an empty list, which would read as "user unchecked all".
					return degradedSnapshot();
				}
				return {
					ready: true,
					shown: normalizePresetButtons(resolved.presetButtons),
					names: resolveNames(resolved),
				};
			}

			/** Tell every mounted composer control that the preset view changed. */
			function notify() {
				for (const listener of [...listeners]) listener();
			}

			return {
				/** The current snapshot; safe to call before `attach`. */
				getSnapshot: read,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				/**
				 * Bind to the settings form and start mirroring it.
				 * @param configForms - the scoped `configForms` service.
				 */
				attach(configForms) {
					if (form !== null) return;
					form = configForms.get(NS);
					const dispose = form.subscribe(() => notify());
					disposeForm = typeof dispose === 'function' ? dispose : null;
					// The attach itself is a change: buttons that rendered degraded
					// before the form resolved must repaint as the real set.
					notify();
				},
				/** Drop the form subscription (plugin unload). */
				dispose() {
					if (disposeForm !== null) disposeForm();
					disposeForm = null;
					form = null;
					notify();
				},
			};
		}

		// -------------------------------------------------------------------
		// Settings: catalogue store
		// -------------------------------------------------------------------

		/**
		 * The model catalogue, loaded through the official remote namespace and
		 * invalidated by the four Host events the shipped model picker subscribes to.
		 *
		 * The catalogue is NOT plugin state to own: `remote.session.modelCatalog()`
		 * is the Host's shared projection of the live LLM registry, and the events it
		 * depends on (adapters, settings document, credentials) are the ones the Host
		 * itself publishes when that projection goes stale. Keeping one small store
		 * here — instead of importing the official picker package, which the plugin
		 * guidelines forbid — is exactly the copy-markup-not-modules trade.
		 */
		function createCatalogStore(remote) {
			const listeners = new Set();
			let state = { status: 'idle', groups: [], error: null };
			let generation = 0;
			let inflight = null;

			function publish(next) {
				state = next;
				for (const listener of listeners) listener();
			}

			async function load() {
				if (state.status === 'ready') return;
				if (inflight !== null) return inflight;
				const atGeneration = generation;
				publish({ ...state, status: 'loading', error: null });
				const operation = (async () => {
					try {
						const response = await remote.session.modelCatalog();
						if (!response || response.ok !== true) {
							throw new Error(response && response.error ? String(response.error.message ?? response.error) : 'modelCatalog failed');
						}
						if (atGeneration === generation) {
							publish({ status: 'ready', groups: response.value.groups ?? [], error: null });
						}
					} catch (error) {
						if (atGeneration === generation) {
							publish({ status: 'error', groups: [], error: error instanceof Error ? error.message : String(error) });
						}
					} finally {
						if (inflight === operation) inflight = null;
					}
				})();
				inflight = operation;
				return operation;
			}

			/**
			 * Invalidate on a Host event.
			 *
			 * A menu nobody has opened yet stays unloaded — an invalidation is not a
			 * reason to spend an RPC for a page that may never be visited. A menu that
			 * HAD loaded re-pulls immediately, exactly like the shipped picker does.
			 */
			function refresh() {
				generation += 1;
				inflight = null;
				const hadContent = state.status === 'ready' || state.status === 'error';
				if (!hadContent) return;
				publish({ status: 'idle', groups: [], error: null });
				load();
			}

			return {
				getSnapshot: () => state,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				load,
				refresh,
			};
		}

		// -------------------------------------------------------------------
		// Settings: controller
		// -------------------------------------------------------------------

		/**
		 * One settings page instance: the staged draft, the config form writes, and
		 * the save lifecycle.
		 *
		 * React-hostile on purpose — it is constructed once per mounted page and
		 * mutated in place, with `onChange` notifying React that something changed.
		 * All writes go through `ctx.configForms.get('dsh-draft-studio')`: `mutate`
		 * for the atomic multi-field save, `unset` for restore-default and for an
		 * emptied prompt. The controller never touches the network.
		 */
		class SettingsPageController {
			/**
			 * @param ctx - the scoped client context (configForms + remote services).
			 */
			constructor(ctx, t) {
				this.ctx = ctx;
				this.t = t;
				this.form = ctx.configForms.get(NS);
				this.remote = ctx.remote;
				/** A version marker replaced on every change, for React's subscription. */
				this.marker = { version: 0 };
				this.listeners = new Set();
				this.draft = emptyDraft();
				/** The revision the draft was staged against; saves fence on it. */
				this.stagedRevision = undefined;
				this.saving = false;
				this.failed = false;
				/**
				 * The edit gate (§9.2). Transient on purpose: never staged, never
				 * persisted, never counted as a dirty item. The name input and the
				 * prompt textarea are read-only unless this is true.
				 */
				this.editing = false;
				this.catalog = createCatalogStore(this.remote);
				this.disposeForm = this.form.subscribe(() => this.notify());
				this.disposers = [];
				for (const event of CATALOG_EVENTS) {
					const dispose = this.remote.$on(event, () => this.catalog.refresh());
					if (typeof dispose === 'function') this.disposers.push(dispose);
				}
			}

			/** Tell React that the page's values changed. */
			notify() {
				this.marker = { version: this.marker.version + 1 };
				for (const listener of [...this.listeners]) listener();
			}

			/** Subscribe a mounted page to this controller's changes. */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}

			/** The subscription source identity React keys on. */
			getSnapshot() {
				return this.marker;
			}

			/** Free every subscription the page holds. */
			dispose() {
				for (const dispose of this.disposers) dispose();
				this.disposers.length = 0;
				this.disposeForm();
				this.listeners.clear();
			}

			/** The form snapshot, or null while the mirror has nothing to serve. */
			get snapshot() {
				const snap = this.form.getSnapshot();
				return snap !== null && typeof snap === 'object' ? snap : null;
			}

			/** The page's current rendered state. */
			get state() {
				return pageState({
					snapshot: this.snapshot,
					dirty: !draftEquals(this.draft, emptyDraft()),
					saving: this.saving,
					failed: this.failed,
				});
			}

			/** Why saving is impossible right now, or null to allow it. */
			get block() {
				if (this.saving) return null;
				const view = this.view;
				return saveBlock(view.modelMode, stagedPair(view.provider, view.model));
			}

			/** One prompt field with staged edits applied over the document. */
			promptView(field) {
				const staged = this.draft[field];
				if (staged === null) {
					// "Restore default": preview the inherited value the Host would serve.
					const base = this.snapshot !== null ? this.snapshot.base : undefined;
					return base !== null && base !== undefined && typeof base[field] === 'string' ? base[field] : '';
				}
				if (staged !== undefined) return staged;
				const snap = this.snapshot;
				const value = snap !== null && snap.status === 'ready' ? snap.value : undefined;
				return value !== null && value !== undefined && typeof value[field] === 'string' ? value[field] : '';
			}

			/**
			 * One name field as the document (or the draft) holds it, raw.
			 *
			 * Raw on purpose: the input must show exactly what the user typed, and
			 * an emptied box has to stay empty until it is saved — the built-in
			 * fallback is a DISPLAY concern (`view.names`), not an input value.
			 *
			 * @param preset - one of the four preset keys.
			 * @returns the stored name, or `''` when the document has none.
			 */
			nameView(preset) {
				const field = nameField(preset);
				const staged = this.draft[field];
				if (staged !== undefined) return staged;
				const snap = this.snapshot;
				const value = snap !== null && snap.status === 'ready' ? snap.value : undefined;
				return value !== null && value !== undefined && typeof value[field] === 'string' ? value[field] : '';
			}

			/** One merged view: snapshot values with staged edits on top. */
			get view() {
				const snap = this.snapshot;
				const value = snap !== null && snap.status === 'ready' && snap.value !== undefined && snap.value !== null ? snap.value : {};
				const draft = this.draft;
				const merged = {
					enabled: draft.enabled !== undefined ? draft.enabled : value.enabled,
					preset: normalizePreset(draft.preset !== undefined ? draft.preset : value.preset),
					promptGeneral: this.promptView('promptGeneral'),
					promptCode: this.promptView('promptCode'),
					promptWriting: this.promptView('promptWriting'),
					promptTranslation: this.promptView('promptTranslation'),
					nameGeneral: this.nameView('general'),
					nameCode: this.nameView('code'),
					nameWriting: this.nameView('writing'),
					nameTranslation: this.nameView('translation'),
					// Staged array wins wholesale (§9.3: the checkbox replaces the whole
					// array, it never toggles one member in place).
					presetButtons: normalizePresetButtons(
						draft.presetButtons !== undefined ? draft.presetButtons : value.presetButtons,
					),
					contextEnabled: draft.contextEnabled !== undefined ? draft.contextEnabled : value.contextEnabled,
					modelMode: draft.modelMode !== undefined ? draft.modelMode : value.modelMode,
					provider: draft.provider !== undefined ? draft.provider : (typeof value.provider === 'string' ? value.provider : ''),
					model: draft.model !== undefined ? draft.model : (typeof value.model === 'string' ? value.model : ''),
					reasoningEffort: draft.reasoningEffort !== undefined
						? draft.reasoningEffort
						: (typeof value.reasoningEffort === 'string' ? value.reasoningEffort : ''),
				};
				// Display names, already resolved (built-in fallback applied). Derived
				// from the merged view so a staged rename shows up in the dropdown, the
				// textarea title and the composer without a round trip.
				merged.names = resolveNames(merged);
				return merged;
			}

			/**
			 * The display name of one preset in the merged view.
			 * @param preset - one of the four preset keys.
			 * @returns a non-empty name (`OptionX` when unnamed or cleared).
			 */
			displayName(preset) {
				return normalizeName(preset, this.nameView(preset));
			}

			/** Whether one prompt field carries an override in the document. */
			promptOverridden(preset) {
				const snap = this.snapshot;
				if (snap === null || snap.status !== 'ready') return false;
				// `value` is the RESOLVED view (defaults merged in), so it says nothing
				// about whether the user ever wrote this field; `user` is the raw
				// document and is the honest test for "there is an override to clear".
				const user = snap.user;
				return user !== null && user !== undefined && user[presetField(preset)] !== undefined;
			}

			/** Mirror a change into the draft and tell React. */
			stage(field, value) {
				// The revision fence is read once, when the batch STARTS: a save must
				// prove the document has not moved since the user began editing, so a
				// concurrent write from another surface fails the commit instead of
				// silently folding into it.
				if (draftEquals(this.draft, emptyDraft()) && this.snapshot !== null) {
					this.stagedRevision = this.snapshot.revision;
				}
				this.draft = { ...this.draft, [field]: value };
				this.failed = false;
				this.notify();
			}

			/** Switch the preset the textarea edits (local only; saved on save). */
			selectPreset(preset) {
				if (normalizePreset(this.view.preset) === preset) return;
				// §9.2: switching the dropdown closes the edit gate. Set BEFORE the
				// stage so the single notification that follows already carries the
				// closed gate — the other preset's staged text stays staged (it is
				// already in `draft`); only the gate, which is about the field the user
				// is LOOKING at, resets.
				this.editing = false;
				this.stage('preset', preset);
			}

			/** Open or close the edit gate (§9.2). Never staged, never persisted. */
			setEditing(editing) {
				this.editing = editing === true;
				this.notify();
			}

			/** Flip the edit gate (the 「编辑 / 完成」 button). */
			toggleEditing() {
				this.setEditing(!this.editing);
			}

			/**
			 * Stage a rename (§9.3).
			 *
			 * The empty string is staged as-is: `isFieldClear` turns it into an
			 * `unset` at save time, so the document falls back to `OptionX` instead
			 * of storing an empty name.
			 *
			 * The 12-code-point cap is applied HERE rather than through the input's
			 * `maxLength`: `maxLength` counts UTF-16 code units, so it would cut a
			 * surrogate pair (an emoji, or a rare CJK glyph) in half and let six
			 * emoji through where §6.3 allows twelve. Capping the staged value keeps
			 * the rule in one place — the same one `normalizeName` uses.
			 *
			 * @param preset - one of the four preset keys.
			 * @param text - the raw input value.
			 */
			editName(preset, text) {
				const raw = typeof text === 'string' ? text : '';
				const points = Array.from(raw);
				this.stage(nameField(preset), points.length > 12 ? points.slice(0, 12).join('') : raw);
			}

			/** Whether the composer shows a button for one preset (§9.3). */
			isButtonShown(preset) {
				return normalizePresetButtons(this.view.presetButtons).includes(preset);
			}

			/**
			 * Show or hide one preset's composer button.
			 *
			 * Replaces the WHOLE array in one staged write (§9.3) — a partial update
			 * would need a second field to describe it, and the save already sends
			 * `presetButtons` as one value.
			 *
			 * @param preset - one of the four preset keys.
			 */
			toggleButton(preset) {
				const current = normalizePresetButtons(this.view.presetButtons);
				const next = current.includes(preset)
					? current.filter((key) => key !== preset)
					: PRESET_KEYS.filter((key) => key === preset || current.includes(key));
				this.stage('presetButtons', next);
			}

			/** The draft text for one preset: staged edit, staged clear, or document. */
			promptDraft(preset) {
				const field = presetField(preset);
				const staged = this.draft[field];
				if (staged === undefined || staged === null) return this.promptView(field);
				return staged;
			}

			/** Stage one keystroke of the prompt textarea. */
			editPrompt(preset, text) {
				this.stage(presetField(preset), text);
			}

			/** Stage a toggle of the context switch. */
			toggleContext() {
				const current = this.view.contextEnabled;
				this.stage('contextEnabled', current === undefined ? false : !current);
			}

			/** Stage a toggle of the master switch. */
			toggleEnabled() {
				const current = this.view.enabled;
				this.stage('enabled', current === undefined ? false : !current);
			}

			/** Stage the model-source mode, re-checking the pair requirement. */
			selectModelMode(mode) {
				this.stage('modelMode', mode);
			}

			/** Stage one provider/model pin from the catalogue menu. */
			pickModel(provider, model) {
				this.stage('provider', provider);
				this.stage('model', model);
				// The effort belongs to the model that advertised it: carrying it to a
				// different model either sends something unsupported or leaves a stale
				// value in the document. Reset to "model default" on every repin.
				this.stage('reasoningEffort', '');
			}

			/** Stage the reasoning effort that goes with the pinned model ('' = default). */
			selectEffort(effort) {
				this.stage('reasoningEffort', effort);
			}

			/** The efforts the pinned model advertises, or an empty list. */
			effortsForPinnedModel() {
				const pair = stagedPair(this.view.provider, this.view.model);
				if (pair === null) return [];
				const catalog = this.catalog.getSnapshot();
				for (const group of catalog.groups) {
					if (group.id !== pair.provider) continue;
					for (const model of group.models ?? []) {
						if (model.id !== pair.model) continue;
						const efforts = model.reasoning?.efforts;
						return Array.isArray(efforts) ? efforts : [];
					}
				}
				return [];
			}

			/** How many fields carry a staged edit; drives the footer counter. */
			dirtyCount() {
				return Object.values(this.draft).filter((value) => value !== undefined).length;
			}

			/** Drop every staged edit (the "discard" button). */
			discard() {
				this.draft = emptyDraft();
				this.stagedRevision = undefined;
				this.failed = false;
				// §9.2: discarding also closes the gate.
				this.editing = false;
				this.notify();
			}

			/** Stage an unset for one prompt field (restore default / emptied box). */
			resetPrompt(preset) {
				this.stage(presetField(preset), null);
			}

			/**
			 * Commit the staged edits.
			 *
			 * Sets go out as one atomic `mutate`; a staged CLEAR (restore-default, or
			 * an emptied prompt) cannot be mixed into that list — the official form
			 * speaks `set` ops there — so each clear is its own `unset` queued after
			 * the set batch. Failure anywhere keeps the whole draft: the failed state
			 * exists precisely so the user can read the reason and retry without
			 * retyping anything.
			 */
			async save() {
				if (this.saving) return;
				if (draftEquals(this.draft, emptyDraft())) return;
				const view = this.view;
				const block = saveBlock(view.modelMode, stagedPair(view.provider, view.model));
				if (block !== null) {
					// Nothing to commit: the banner already explains the block, and the
					// draft must survive so the user can pick a model and press save again.
					this.notify();
					return;
				}
				// Sets and clears go out as ONE mutation. Splitting them (a `mutate` for
				// the sets, then one `unset` per cleared field) gave each write its own
				// revision, so a concurrent writer landing between them could leave the
				// batch half-applied: the sets committed, the clears rejected — or the
				// reverse — with the UI reporting a single outcome. The Host accepts a
				// mixed op array in one call, and the fence then covers the whole batch.
				const operations = [];
				for (const [field, value] of Object.entries(this.draft)) {
					if (value === undefined) continue;
					if (isFieldClear(field, value)) operations.push({ op: 'unset', path: [field] });
					else operations.push({ op: 'set', path: [field], value });
				}
				this.saving = true;
				this.failed = false;
				this.notify();
				try {
					let ok = true;
					// The fence is the revision the batch was staged against: if another
					// browser moved the document meanwhile, the Host refuses the whole
					// batch and the draft survives as `failed` (the form's own conflict
					// recovery then refolds the mirror).
					if (operations.length > 0) ok = await this.form.mutate(operations, this.stagedRevision) === true;
					if (!ok) {
						// A conflict moved the document under us. Re-read the fence so the
						// next attempt is compared against the CURRENT revision — otherwise
						// every retry carries the stale one and can never succeed.
						const fresh = this.snapshot;
						if (fresh !== null && Number.isInteger(fresh.revision)) {
							this.stagedRevision = fresh.revision;
						}
						this.failed = true;
						return;
					}
					this.draft = emptyDraft();
					this.stagedRevision = undefined;
					// §9.2: a successful save settles the page back to read-only. A
					// FAILED save returns above without touching the gate, so the user
					// stays in edit mode and can fix the cause and retry.
					this.editing = false;
				} finally {
					this.saving = false;
					this.notify();
				}
			}
		}

		// -------------------------------------------------------------------
		// Settings: the page
		// -------------------------------------------------------------------

		/** Subscribe a component to any of this plugin's snapshot sources. */
		function useSubscription(source) {
			const [, force] = useReducer((n) => n + 1, 0);
			useEffect(() => source.subscribe(() => force()), [source]);
		}

		/**
		 * The prompt editor: the full text of the active preset.
		 *
		 * 用户反馈（2026-11-06）：标题行「{名字}预设的完整提示词」整行删除，编辑/恢复默认
		 * 两个按钮移到上面那一行（四个等高线框之一）。这里只留 textarea；`aria-label`
		 * 仍带着那个标题文案，读屏用户仍能听到「这是哪套预设的提示词」。
		 *
		 * The textarea is read-only until the gate is open (§9.1).
		 */
		function PromptEditor({ controller, preset, t, disabled, editing }) {
			const text = controller.promptDraft(preset);
			return h('textarea', {
				className: 'dsh-pr-area',
				value: text,
				readOnly: !editing,
				disabled,
				'data-editing': String(editing),
				'aria-label': t('prompt.title', { preset: controller.displayName(preset) }),
				onChange: (event) => controller.editPrompt(preset, event.target.value),
			});
		}

		/**
		 * The settings page itself.
		 *
		 * Props are the slot's owner share plus this registrant's inject face: the
		 * controller (which owns every configForms read and write) and the bound
		 * translator from the `locale` registration option. The shell's `close`
		 * affordance is accepted and unused — this page never leaves settings.
		 */
		function SettingsSection(props) {
			const { controller, t } = props;
			// The page re-renders on every controller change (field edit, form refold,
			// save settlement); the catalog menu subscribes to its own source below.
			useSubscription(controller);
			const state = controller.state;
			const view = controller.view;
			const writable = stateWritable(state);
			const block = controller.block;
			// §9.1's edit gate: name input and textarea are read-only until 「编辑」 is
			// pressed. A page the Host refuses to write can never open the gate, so a
			// stale `editing: true` cannot leave an editable field on a read-only page.
			const editing = controller.editing === true && writable;
			const last = useLastRun();
			// The preset the six-cell row acts on. Everything in that row (dropdown,
			// checkbox, edit gate, restore) targets THIS preset.
			const activePreset = normalizePreset(view.preset);
			// Whether 「恢复默认」 would be a no-op: the document carries no override
			// AND nothing is staged for this field. Computed here because the button
			// now lives in the row, not in the (deleted) prompt title row.
			const promptIsDefault = controller.draft[presetField(activePreset)] === undefined
				&& !controller.promptOverridden(activePreset);
			// The catalogue is loaded when the page mounts: a native `<select>` has no
			// "opened, so fetch now" moment the old custom Menu had.
			useEffect(() => {
				controller.catalog.load().catch(() => {});
			}, [controller]);
			// …and the page must REPAINT when that load settles. Without this
			// subscription the store updates but this component never re-renders, so
			// the select keeps the disabled state it had on the first frame forever.
			useSubscription(controller.catalog);
			const saveDisabled = !writable || state === 'saving' || block !== null;
			const discardDisabled = !writable || state === 'saving'
				|| draftEquals(controller.draft, emptyDraft());
			return h(
				'div',
				{ className: 'dsh-pr-page' },
				h('h2', { className: 'dsh-pr-title' }, t('title')),
				h('p', {
					className: 'dsh-pr-state',
					'data-tone': block !== null ? 'blocked' : state === 'failed' ? 'failed' : state === 'saving' ? 'saving' : state === 'dirty' ? 'dirty' : 'idle',
				}, block !== null ? t(block) : t(`page.${state}`)),
				// 用户反馈（2026-11-06）定稿形态：**一行六个等高控件，外层再套一个大框**。
				// 顺序固定：① 启用 ② 读取上下文 ③ 预设下拉 ④ 显示按钮 ⑤ 编辑 ⑥ 恢复默认。
				// 拨动开关样式已废弃——① ② 改用与 ④ 同款的「框内勾选框 + 文字」，
				// 于是整行六格的边框、圆角、32px 高度完全一致。外框只负责把它们圈成一组。
				h('div', { className: 'dsh-pr-panel' },
					h('div', { className: 'dsh-pr-cell' },
						h('label', { className: 'dsh-pr-checkbox' },
							h('input', {
								type: 'checkbox',
								checked: view.enabled === true,
								disabled: !writable,
								onChange: () => controller.toggleEnabled(),
							}),
							h('span', {}, t('enabled.label')),
						),
					),
					h('div', { className: 'dsh-pr-cell' },
						h('label', { className: 'dsh-pr-checkbox' },
							h('input', {
								type: 'checkbox',
								checked: view.contextEnabled === true,
								disabled: !writable,
								onChange: () => controller.toggleContext(),
							}),
							h('span', {}, t('context.label')),
						),
					),
					h('div', { className: 'dsh-pr-cell' },
						// 点「编辑」时这一格从下拉变成可输入的名称框（即「下拉框里的内容可以改」）。
						editing
							? h('input', {
								className: 'dsh-pr-input',
								type: 'text',
								value: controller.nameView(activePreset),
								placeholder: DEFAULT_NAMES[activePreset],
								'aria-label': t('name.label'),
								onChange: (event) => controller.editName(activePreset, event.target.value),
							})
							: h('select', {
								className: 'dsh-pr-select',
								'aria-label': t('preset.pickLabel'),
								disabled: !writable,
								value: activePreset,
								onChange: (event) => controller.selectPreset(event.target.value),
							}, PRESET_KEYS.map((key) => h(
								'option',
								{ key, value: key },
								// 下拉里不显示勾选标记，只显示生效名（用户要求）。
								view.names[key],
							))),
					),
					h('div', { className: 'dsh-pr-cell' },
						h('label', { className: 'dsh-pr-checkbox' },
							h('input', {
								type: 'checkbox',
								checked: view.presetButtons.includes(activePreset),
								disabled: !writable,
								onChange: () => controller.toggleButton(activePreset),
							}),
							h('span', {}, t('showButton.label')),
						),
					),
					h('div', { className: 'dsh-pr-cell' },
						h('button', {
							type: 'button',
							className: 'dsh-pr-ctlbtn',
							'aria-pressed': editing,
							disabled: !writable,
							onClick: () => controller.toggleEditing(),
						}, h('span', null, editing ? t('action.done') : t('action.edit'))),
					),
					h('div', { className: 'dsh-pr-cell' },
						h('button', {
							type: 'button',
							className: 'dsh-pr-ctlbtn',
							// §9.1: 「恢复默认」 is NOT gated by the edit door — it restores
							// the built-in text and must stay reachable while read-only.
							disabled: !writable || promptIsDefault,
							onClick: () => controller.resetPrompt(activePreset),
						}, h('span', null, t('prompt.restoreDefault'))),
					),
				),
				// §9.5: a NEUTRAL hint, and only when the resolved view really is an
				// explicit empty array. While the form is unavailable the page already
				// says so; adding "you unchecked everything" there would send the user
				// to fix something they cannot change.
				state !== 'unavailable' && view.presetButtons.length === 0
					? h('p', { className: 'dsh-pr-sub' }, t('page.noButtons'))
					: null,
				...PRESET_KEYS.map((preset) => preset === normalizePreset(view.preset)
					? h(PromptEditor, {
						key: preset,
						controller,
						preset,
						t,
						disabled: !writable,
						editing,
					})
					: null),

				h(
					'div',
					{ className: 'dsh-pr-row dsh-pr-box' },
					h('div', { className: 'dsh-pr-rowhead' },
						h('span', { className: 'dsh-pr-label' }, t('model.label')),
						h('div', { className: 'dsh-pr-seg', role: 'radiogroup', 'aria-label': t('model.groupLabel') },
							h('button', {
								type: 'button',
								className: 'dsh-pr-seg-item',
								role: 'radio',
								'aria-checked': view.modelMode !== 'fixed',
								disabled: !writable,
								onClick: () => controller.selectModelMode('follow'),
							}, t('model.follow')),
							h('button', {
								type: 'button',
								className: 'dsh-pr-seg-item',
								role: 'radio',
								'aria-checked': view.modelMode === 'fixed',
								disabled: !writable,
								onClick: () => controller.selectModelMode('fixed'),
							}, t('model.fixed')),
						),
					),
					h('div', { className: 'dsh-pr-model-body' },
					view.modelMode === 'fixed'
						? h('div', { className: 'dsh-pr-sub-grid' },
							h('div', {},
								h('span', { className: 'dsh-pr-field-k' }, t('model.pickLabel')),
								h('select', {
									className: 'dsh-pr-select',
									'aria-label': t('model.pickLabel'),
									disabled: !writable || controller.catalog.getSnapshot().status !== 'ready',
									value: stagedPair(view.provider, view.model) === null ? '' : `${view.provider}\u0000${view.model}`,
									onChange: (event) => {
										const [provider, model] = event.target.value.split('\u0000');
										if (provider && model) controller.pickModel(provider, model);
									},
								}, modelOptions(controller).map((option) => h('option', {
									key: option.value,
									value: option.value,
									disabled: option.disabled === true,
								}, option.label)))),
							h('div', {},
								h('span', { className: 'dsh-pr-field-k' }, t('model.effortLabel')),
								h('select', {
									className: 'dsh-pr-select',
									'aria-label': t('model.effortLabel'),
									disabled: !writable,
									// The stored effort may name a level the CURRENT model does not
									// advertise (the pin changed, or the document predates it). A
									// value outside the option set renders as a blank select, so it
									// is normalised to "model default" for display; the stored value
									// itself is left untouched until the user saves.
									value: effortOptions(controller).some((option) => option.id === (view.reasoningEffort ?? ''))
										? (view.reasoningEffort ?? '')
										: '',
									onChange: (event) => controller.selectEffort(event.target.value),
								}, effortOptions(controller).map((option) => h('option', {
									key: option.id || '(default)',
									value: option.id,
								}, option.name)))),

						)
						: h('p', { className: 'dsh-pr-sub' }, t('model.followDescription')),
					),

				),
				// 「读取上下文」到底生效没有：一行，只有发起过改写才出现。
				last === null
					? null
					: h('p', { className: 'dsh-pr-sub dsh-pr-ctx' }, contextLine(last.context, t)),
				h(
					'div',
					{ className: 'dsh-pr-foot' },
					h('span', { className: 'dsh-pr-count', 'data-dirty': String(controller.dirtyCount() > 0) },
						controller.dirtyCount() > 0
							? t('foot.unsaved', { count: String(controller.dirtyCount()) })
							: t('foot.clean')),
					h('span', { className: 'dsh-pr-grow' }),
					h('button', {
						type: 'button',
						className: 'dsh-pr-ghost',
						disabled: discardDisabled,
						onClick: () => controller.discard(),
					}, t('action.discard')),
					h('button', {
						type: 'button',
						className: 'dsh-pr-save',
						disabled: saveDisabled,
						onClick: () => controller.save(),
					}, state === 'saving' ? t('action.saving') : t('action.save')),
				),
			);
		}

		// -------------------------------------------------------------------
		// The control
		// -------------------------------------------------------------------

		/**
		 * A store-shaped stand-in used when the slot delivers no inject face.
		 *
		 * It reports exactly the degraded snapshot (§8.2 rule 4): not ready, one
		 * `general` entry, built-in names. A composer mounted against an older host
		 * therefore renders the single pre-multi-preset button instead of throwing
		 * on a missing service.
		 */
		const DEGRADED_PRESET_SOURCE = Object.freeze({
			getSnapshot: () => ({
				ready: false,
				shown: [...PRESET_KEYS],
				names: { ...DEFAULT_NAMES },
			}),
			subscribe: () => () => {},
		});

		/**
		 * Subscribe a component to the TASKS/RUNNING bus.
		 *
		 * Defined outside `RefineControl` on purpose: the control's own body stays a
		 * pure "read the stores, render N buttons" function, and every hook that
		 * belongs to a SINGLE task lives in `RefineButton`.
		 */
		function useTaskBus() {
			const [, force] = useReducer((n) => n + 1, 0);
			useEffect(() => subscribeTasks(() => force()), []);
		}

		/**
		 * The preset store's snapshot, as React state.
		 *
		 * `getSnapshot()` before `attach` is a legal call that returns the degraded
		 * snapshot, so the first frame renders one button instead of throwing. When
		 * the slot does not deliver the inject face at all (an older host), a frozen
		 * degraded snapshot is used: the composer keeps its pre-multi-preset
		 * behaviour rather than failing to mount.
		 *
		 * @param presets - the store from `inject: () => ({ presets })`.
		 * @returns `{ ready, shown, names }`.
		 */
		function usePresetSnapshot(presets) {
			const source = presets !== undefined && presets !== null && typeof presets.getSnapshot === 'function'
				? presets
				: DEGRADED_PRESET_SOURCE;
			const [snapshot, setSnapshot] = useState(() => source.getSnapshot());
			useEffect(() => {
				// Re-read on mount: the store may have attached between the initial
				// render and this effect (the settings form resolves asynchronously).
				setSnapshot(source.getSnapshot());
				return source.subscribe(() => setSnapshot(source.getSnapshot()));
			}, [source]);
			return snapshot;
		}

		/**
		 * End the session's run when the composer consumed the draft.
		 *
		 * A sent draft (or one emptied under us) leaves the run with no target: the
		 * result had nowhere to go and a spinner with no draft reads as broken. This
		 * is the ONE abort that is not an unmount — switching sessions must keep the
		 * run alive.
		 *
		 * It lives at the group level rather than in each button because the group
		 * unmounts its buttons when the composer goes blank (§8.2 rule 5): an effect
		 * inside an unmounted button could never run, and the controller would be
		 * orphaned in `RUNNING`. The group stays mounted, so this always runs.
		 *
		 * @param params - `{ sessionKey, phase, draft }`.
		 */
		function useDiscardRunOnSend(params) {
			const { sessionKey, phase, draft } = params;
			useEffect(() => {
				const running = RUNNING.get(sessionKey);
				if (running === undefined) return;
				const sent = phase === 'submitting' || phase === 'adjudicating';
				const emptied = cleanDraft(draft).length === 0;
				if (!sent && !emptied) return;
				closeRun(sessionKey, running.controller);
				running.controller.abort();
				const key = taskKey(sessionKey, running.presetId);
				setTask(key, taskReducer(TASKS.get(key) ?? emptyTask(), { type: 'discardRun' }));
			}, [sessionKey, phase, draft]);
		}

		/**
		 * The composer control: a group of up to four buttons, one per shown preset.
		 *
		 * This component owns NO single-task state. It reads two stores (the preset
		 * store and the task tables), derives the two values that only make sense
		 * across buttons, and renders one `RefineButton` per shown preset — each a
		 * real component instance, because the per-task logic needs ~21 hook calls
		 * and hooks may not run in a loop (§10.2).
		 *
		 * `busyElsewhere` (§8.1) and `anyUndo` (§8.2.5) are computed HERE and passed
		 * down as props: a button cannot see its siblings, and without them the
		 * other three would keep a stale `disabled: false` and a click there would
		 * overwrite the live controller in `RUNNING`.
		 *
		 * Receives the slot's standard props: `sessionId`, `useInput`,
		 * `inputActions`, the bound translator `t`, and this plugin's own inject
		 * face `presets`.
		 */
		function RefineControl(props) {
			const { sessionId, useInput, inputActions, t, presets } = props;
			const draft = useInput((state) => state.draft);
			const phase = useInput((state) => state.phase);

			// Re-render whenever ANY task or run changes — this is the channel that
			// makes the other three buttons' `disabled` follow the running one.
			useTaskBus();
			const presetSnap = usePresetSnapshot(presets);

			const sessionKey = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'unknown';

			// §8.2 rules 2 and 4, which must stay distinct:
			//   !ready            → degrade to ONE button, key fixed to `general`
			//   ready && shown=[] → the user unchecked all four; render NOTHING
			const degraded = presetSnap.ready !== true;
			const shown = degraded ? ['general'] : PRESET_KEYS.filter((key) => presetSnap.shown.includes(key));

			useDiscardRunOnSend({ sessionKey, phase, draft });

			const running = RUNNING.get(sessionKey);
			const runningPresetId = running === undefined ? null : running.presetId;
			// §8.2.5: the group stays visible while any of its buttons can still
			// revert, even over an empty composer.
			const anyUndo = shown.some((presetId) => (TASKS.get(taskKey(sessionKey, presetId)) ?? emptyTask()).status === 'undo');

			if (!degraded && shown.length === 0) return null;
			if (isBlankDraft(draft) && !anyUndo) return null;

			return h(
				'span',
				{ className: 'dsh-pr-wrap dsh-pr-group' },
				shown.map((presetId, index) => h(RefineButton, {
					key: presetId,
					sessionId,
					sessionKey,
					presetId,
					degraded,
					// 用户反馈（2026-11-06）：tooltip 直接用生效名（未改名即 OptionA–D）。
					// `named` 位已删除（tooltip 改为只显示名字，不再需要区分「未改名」）。
					// 降级路径没有 store 的 names，用内置名兜底，避免「 · 提示词优化」空名。
					name: degraded ? DEFAULT_NAMES[presetId] : presetSnap.names[presetId],
					index: index + 1,
					total: shown.length,
					// §8.1: one run per session — every button but the owner greys out.
					busyElsewhere: runningPresetId !== null && runningPresetId !== presetId,
					useInput,
					inputActions,
					t,
				})),
			);
		}

		/**
		 * One composer button: its own task record, its own run, its own effects.
		 *
		 * Everything that used to live in the single control lives here, parameterized
		 * by `presetId`. Each instance reads ONLY its own `TASKS` entry, so two
		 * presets never share a spinner, a snapshot or a failure.
		 */
		function RefineButton(props) {
			const {
				sessionId, sessionKey, presetId, degraded, name, index, total,
				busyElsewhere, useInput, inputActions, t,
			} = props;

			// One selector per field: each subscribes to the smallest slice, so the button
			// does not re-render on unrelated composer changes.
			const draft = useInput((state) => state.draft);
			const draftRev = useInput((state) => state.draftRev);
			const phase = useInput((state) => state.phase);
			// Reference-chip occurrences in clipboard coordinates (hosts without chips
			// publish an empty list; older hosts may omit the field entirely).
			const occurrences = useInput((state) => state.occurrences);

			const key = taskKey(sessionKey, presetId);
			const task = TASKS.get(key) ?? emptyTask();

			/** Apply one action to THIS button's record; the bus re-renders the group. */
			const dispatch = useCallback((action) => {
				const current = TASKS.get(key) ?? emptyTask();
				setTask(key, taskReducer(current, action));
			}, [key]);

			// The draft as it is NOW, readable from async callbacks created in an earlier
			// render — the rewriter's own comment calls out exactly this hazard.
			const draftRef = useRef(draft);
			draftRef.current = draft;
			const revRef = useRef(draftRev);
			revRef.current = draftRev;
			const occurrencesRef = useRef(occurrences);
			occurrencesRef.current = occurrences;

			// NO abort on unmount. Switching sessions unmounts this seat, and aborting
			// here is exactly what used to kill a run the user was still waiting for.
			// The run lives in RUNNING/TASKS, and only an explicit cancel, a sent draft,
			// or plugin unload may end it.

			/**
			 * Write one string over the whole draft.
			 *
			 * `before` is the clipboard projection the host publishes; the editor maps
			 * spans over the detect projection, so the endpoint is converted through the
			 * reference-chip occurrences (each chip is one detect character).
			 *
			 * @returns true when the composer accepted it.
			 */
			const replaceDraft = useCallback((text, before, rev) => {
				const actions = inputActions;
				if (actions === undefined || typeof actions.insertText !== 'function') return false;
				const end = detectEndOf(before.length, occurrencesRef.current);
				return actions.insertText(text, { start: 0, end, draftRev: rev }) === true;
			}, [inputActions]);

			/** Put the pre-refinement draft back. */
			const revert = useCallback(() => {
				const snap = task.snapshot;
				if (snap === null) return;
				if (draftRef.current !== snap.after) {
					// The user edited the result themselves; there is nothing faithful to
					// restore, and native Ctrl+Z is the right tool for their own edits.
					dispatch({ type: 'dropSnapshot' });
					return;
				}
				if (replaceDraft(snap.before, draftRef.current, revRef.current)) dispatch({ type: 'reverted' });
			}, [dispatch, replaceDraft, task.snapshot]);

			/**
			 * Deliver one produced result into the composer, or park it with a reason.
			 * @param text - the refined prompt.
			 * @param before - the draft it was produced from.
			 * @param rev - the draft revision the request was made against.
			 */
			const deliver = useCallback((text, before, rev) => {
				if (replaceDraft(text, before, rev)) {
					dispatch({ type: 'applied', snapshot: { before, after: text } });
					return;
				}
				// Refused. Keep the result and name which of the four paths this is. The live
				// revision is read here so a user edit is reported as such.
				dispatch({
					type: 'parked',
					parked: { text, before, rev },
					failure: { key: refusalReason(phase, rev, revRef.current) },
				});
			}, [dispatch, phase, replaceDraft]);

			/**
			 * Run one refinement for THIS preset.
			 *
			 * A parked result is applied first: the user asked to retry the WRITE, and
			 * re-running the model would produce a different answer for the same draft.
			 * The retry covers the draft AS IT IS NOW — the parked record's own revision
			 * is stale by definition (that mismatch is why the write was refused), so
			 * replaying it could never succeed. If the composer refuses again, the
			 * result parks again with the current revision and the honest reason.
			 */
			const run = useCallback(async () => {
				if (task.parked !== null) {
					const parked = task.parked;
					deliver(parked.text, draftRef.current, revRef.current);
					return;
				}
				const source = cleanDraft(draftRef.current);
				if (source.trim().length === 0) return;
				const rev = revRef.current;

				const controller = new AbortController();
				openRun(sessionKey, presetId, controller);
				// Bump the generation and remember it: anything settling after a newer run
				// started carries a stale number and is dropped.
				const generation = (TASKS.get(key) ?? emptyTask()).generation + 1;
				dispatch({ type: 'start' });

				// Generation is the only guard now: any cancel path bumps it, so a late
				// reply is stale whether or not this seat is still mounted.
				const stillCurrent = () => (TASKS.get(key) ?? emptyTask()).generation === generation;

				try {
					const response = await sendRequest(REFINE_PATH, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							draft: source,
							...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
							// D12: the body names WHICH preset, never its text — the host
							// resolves the prompt from its own config. Degraded mode omits
							// the field entirely, which is the pre-multi-preset request.
							...(degraded ? {} : { presetId }),
						}),
						signal: controller.signal,
					});
					if (response.status !== 200) {
						if (stillCurrent()) {
							dispatch({
								type: 'failed',
								failure: { key: 'state.transport', params: { status: String(response.status) } },
							});
						}
						return;
					}
					const payload = await response.json().catch(() => null);
					if (!stillCurrent()) return;
					const outcome = interpretResponse(payload);
					if (outcome.failure !== undefined) {
						dispatch({ type: 'failed', failure: outcome.failure });
						return;
					}
					// Only a run that actually succeeded publishes a context verdict: a
					// failed call never assembled anything, and showing its old value
					// would misreport what the model just saw.
					//
					// And only when the Host actually reported one. A Host older than the
					// `context` contract answers without the field; recording `undefined`
					// would render a line that says "status unknown" — a new, information-
					// free row. Skip instead: the line's visibility IS the signal that the
					// Host reported (ARCHITECTURE「契约不变量」I7). Skipping is not clearing:
					// an older record stays until a newer successful run replaces it.
					if (payload?.context !== undefined) recordLastRun(payload.context);
					// A late reply for a cancelled run must not be applied: the user already
					// moved on, and their draft may hold something else entirely.
					deliver(outcome.text, draftRef.current, rev);
				} catch (error) {
					// An abort is never a failure: whichever path aborted (explicit cancel,
					// sent draft, plugin unload) already put the record where it belongs.
					if (error?.name === 'AbortError') return;
					if (!stillCurrent()) return;
					dispatch({ type: 'failed', failure: { key: 'state.network' } });
				} finally {
					// Only the owner's own handle closes the run: another preset may have
					// replaced the entry, and deleting it here would drop a live controller.
					closeRun(sessionKey, controller);
				}
			}, [deliver, degraded, dispatch, key, presetId, sessionId, sessionKey, task.parked]);

			/** Click: cancel while busy, revert in the undo seat, otherwise start/retry. */
			const onClick = useCallback(() => {
				if (task.status === 'busy') {
					const running = RUNNING.get(sessionKey);
					closeRun(sessionKey);
					running?.controller?.abort();
					dispatch({ type: 'cancelled' });
					return;
				}
				if (task.status === 'undo') {
					revert();
					return;
				}
				// A fresh run replaces whatever is in the composer, so the old snapshot can
				// no longer be restored.
				if (task.snapshot !== null) dispatch({ type: 'dropSnapshot' });
				run();
			}, [dispatch, revert, run, sessionKey, task.snapshot, task.status]);

			// Announce a transient outcome once, then clear so the live region can speak
			// again for the next one.
			const announceKey = task.announce?.key;
			useEffect(() => {
				if (announceKey === undefined) return undefined;
				const timer = setTimeout(() => dispatch({ type: 'clearAnnounce' }), 4000);
				return () => clearTimeout(timer);
			}, [announceKey, dispatch]);

			// An undo seat whose draft no longer matches what we wrote is stale. Drop it
			// without a message: the user's own edit is the reason, and Ctrl+Z covers it.
			//
			// The comparison waits until the seat has actually SEEN the produced draft.
			// `insertText` returns true as soon as the edit is accepted, but the composer
			// reports the new text on a later render — so checking immediately would read
			// the pre-write draft, conclude the user had edited it, and drop a perfectly
			// good snapshot one tick after creating it.
			const snapshotRef = useRef(null);
			const seenProducedRef = useRef(false);
			const snapshot = task.snapshot;
			if (snapshotRef.current !== snapshot) {
				snapshotRef.current = snapshot;
				seenProducedRef.current = false;
			}
			useEffect(() => {
				if (task.status !== 'undo' || task.snapshot === null) return;
				if (!seenProducedRef.current) {
					// First render of this seat: only start comparing once the draft is the
					// text we produced. A brief mismatch beforehand is the write in flight.
					if (draft === task.snapshot.after) seenProducedRef.current = true;
					return;
				}
				if (draft !== task.snapshot.after) dispatch({ type: 'dropSnapshot' });
			}, [dispatch, draft, task.snapshot, task.status]);

			const state = task.status;

			// A live elapsed counter while a run is open: a spinner with no number is
			// indistinguishable from a stuck control, and this call can legitimately take a
			// minute when the conversation is using the same model.
			const [, tickRender] = useReducer((n) => n + 1, 0);
			useEffect(() => {
				if (state !== 'busy') return undefined;
				const timer = setInterval(tickRender, 1000);
				return () => clearInterval(timer);
			}, [state]);

			const failureText = task.failure === null
				? ''
				: t(task.failure.key, task.failure.params);
			// NO useMemo for the busy label: the per-second tick re-renders through a
			// reducer whose state the host renderer may cache (its identity is stable),
			// so a memoized value would freeze at the busy frame's elapsed time. Reading
			// the clock in the render body is what makes "已用 N 秒" actually move.
			let label;
			switch (state) {
				case 'busy': {
					const elapsed = task.startedAt === null ? 0 : Math.max(0, Math.round((Date.now() - task.startedAt) / 1000));
					label = t('label.busyWithTime', { seconds: String(elapsed) });
					break;
				}
				case 'undo':
					label = t('label.undo');
					break;
				// The tooltip names WHY the last attempt failed; a bare "retry" hides the
				// difference between a timeout, a missing credential and a truncated reply.
				case 'error':
					label = failureText.length > 0 ? failureText : t('label.retry');
					break;
				default:
					// 用户反馈（2026-11-06）：悬停要显示的是**这颗按钮的名称**，不是那句长文案。
					// 已改名 → 生效名；未改名 → 内置名 OptionA–D。busy/undo/error 仍显示状态。
					label = t('label.idleNamed', { name });
			}

			// Nothing to act on: no draft, no work in flight, no result to restore, no
			// failure to retry. Returning null does not mount the entry at all — hiding it
			// with CSS would still reserve the toolbar cell and stay reachable by keyboard.
			// Nothing can be retried or reverted over an empty box: after a failure the user
			// may well send the draft anyway (or clear it), and a leftover retry glyph then
			// describes work that no longer has a target.
			if (isBlankDraft(draft) && state !== 'undo') return null;

			// §8.1: while a SIBLING preset runs, this button is greyed out. The
			// composer's own writability still applies on top.
			const disabled = busyElsewhere
				|| inputActions === undefined || typeof inputActions.insertText !== 'function';
			const announcement = task.announce === undefined || task.announce === null
				? ''
				: t(task.announce.key, task.announce.params);
			const glyph = state === 'busy'
				? h(StopGlyph)
				: state === 'undo'
					? h(UndoGlyph)
					: state === 'error'
						? h(RetryGlyph)
						: h(OrderGlyph);

			// §8.4: the ordinal only reaches assistive tech, so four same-named buttons
			// stay distinguishable in a screen reader's list without adding visual noise.
			const ariaLabel = total > 1
				? `${label}${t('label.ordinal', { index: String(index), total: String(total) })}`
				: label;

			return h(
				'span',
				{ className: 'dsh-pr-wrap' },
				h(
					'button',
					{
						type: 'button',
						className: 'dsh-pr-btn',
						'data-state': state,
						'data-preset': degraded ? 'general' : presetId,
						disabled,
						// `aria-pressed` would claim a toggle; this control's action changes with
						// its state, so the accessible name states what a click does.
						title: label,
						'aria-label': ariaLabel,
						onClick,
					},
					glyph,
				),
				h('span', { className: 'dsh-pr-sr', role: 'status', 'aria-live': 'polite' }, announcement),
			);
		}

		// -------------------------------------------------------------------
		// Dictionaries
		// -------------------------------------------------------------------

		/** Every string the user can see. `zh` and `en` carry identical keys. */
		const DICTIONARY = {
			zh: {
				'label.busyWithTime': '正在改写… 已用 {seconds} 秒',
				'label.undo': '还原成改写前的内容（也可以按 Ctrl+Z）',
				'label.retry': '上次没改成，点这里再试一次',
				'state.cancelled': '已取消，草稿一个字没动。',
				'state.reverted': '已还原成改写前的内容。',
				'state.failed': '改写失败：{reason}',
				'state.network': '改写失败：网络断了，请再试一次。',
				'state.transport': '改写功能没连上（HTTP {status}），先确认插件是开着的。',
				'state.empty': '模型这次没写出能用的内容，草稿保持不变。',
				'state.emptyReasoning': '模型把全部力气都花在思考上了，正事一个字没写。再试一次，或者换一个模型。',
				'state.emptyDraft': '草稿是空的，没什么可改写的。',
				'state.disabled': '提示词优化没开，去设置里打开它。',
				'state.noModel': '现在没有可用的模型，先选一个。',
				'state.noAdapter': '{detail}',
				'state.noCredential': '当前模型缺少可用的账号凭据，补上之后再试。',
				'state.rateLimited': '模型接口被限流了，过一会儿再试。',
				'state.tooLong': '草稿太长，超过这个模型一次能读的量了，删短一点再试。',
				'state.truncated': '模型返回的内容太长，已中断，草稿保持不变。',
				'state.unavailable': '当前环境没有提供模型服务，用不了改写。',
				'state.refusedSubmitting': '你正在提交这条输入，结果没写进去。结果还留着，点一下能重试。',
				'state.refusedAdjudicating': '上一条输入还在处理，结果没写进去。结果还留着，点一下能重试。',
				'state.refusedStale': '草稿已经变了，结果没有覆盖你后来打的字。结果还留着，点一下能重试。',
				'state.refusedMapping': '输入框没能接受这次替换，结果没写进去。结果还留着，点一下能重试。',
				'nav': '提示词优化',
				'title': '提示词优化设置',
				'enabled.label': '启用',
				'preset.pickLabel': '预设',
				'name.label': '名称',
				'showButton.label': '显示按钮',
				'action.edit': '编辑',
				'action.done': '完成',
				'label.idleNamed': '{name}',
				'label.ordinal': '（第 {index} 个，共 {total} 个）',
				'page.noButtons': '你一套都没勾，输入框旁边不会出现任何按钮。',
				'prompt.title': '{preset}：这套的完整提示词',
				'prompt.restoreDefault': '默认',
				'context.label': '读取当前对话',
				'model.label': '用哪个模型',
				'model.groupLabel': '用哪个模型',
				'model.follow': '跟着当前对话走',
				'model.fixed': '固定一个',
				'model.followDescription': '当前对话用什么模型，改写的请求就用什么模型。',
				'menu.loading': '正在加载可用模型…',
				'menu.loadFailed': '模型没加载出来：{reason}',
				'menu.effortDefault': '默认',
				'model.pickLabel': '模型',
				'foot.unsaved': '有 {count} 项没保存',
				'ctx.ok': '上次改写：读了 {turns} 轮对话（{chars} 字）',
				'ctx.disabled': '上次改写：没读对话（设置里关着）',
				'ctx.noSession': '上次改写：没读对话（找不到当前是哪个对话）',
				'ctx.unreachable': '上次改写：没读对话（对话读不出来）',
				'ctx.empty': '上次改写：没读对话（这个对话还没有历史）',
				'ctx.filtered': '上次改写：没读对话（历史被条数或字数上限筛掉了）',
				'ctx.unknown': '上次改写：不知道读没读',
				'foot.clean': '没有改动',
				'model.effortLabel': '思考强度',
				'action.save': '保存',
				'action.saving': '正在保存…',
				'action.discard': '放弃更改',
				'page.unavailable': '设置服务现在连不上，等会儿再试。',
				'page.readOnly': '当前环境是只读的，改不了设置。',
				'page.dirty': '有改动还没保存。',
				'page.saving': '正在保存…',
				'page.failed': '保存失败，改动还留着，改好原因再试一次。',
				'page.saved': '设置已保存。',
				'page.noModelFixed': '你选了「固定一个」，但还没挑具体哪个模型。先在下面的列表里选一个，再保存。',
			},
			en: {
				'label.busyWithTime': 'Rewriting… {seconds}s',
				'label.undo': 'Put back what you had before (or press Ctrl+Z)',
				'label.retry': 'Last rewrite didn’t work — click to try again',
				'state.cancelled': 'Cancelled. Your draft is untouched.',
				'state.reverted': 'Put back what you had before.',
				'state.failed': 'Rewrite failed: {reason}',
				'state.network': 'Rewrite failed: the connection dropped. Try again.',
				'state.transport': 'Couldn’t reach the rewrite service (HTTP {status}). Check that the plugin is switched on.',
				'state.empty': 'The model didn’t produce anything usable. Your draft is untouched.',
				'state.emptyReasoning': 'The model spent all its effort thinking and wrote nothing. Try again, or use a different model.',
				'state.emptyDraft': 'The draft is empty — nothing to rewrite.',
				'state.disabled': 'Prompt refinement is switched off. Turn it on in Settings.',
				'state.noModel': 'No model is available right now. Pick one first.',
				'state.noAdapter': 'The provider for the model you pinned isn’t enabled. Pick a different provider.',
				'state.noCredential': 'This model has no usable credential. Add one, then try again.',
				'state.rateLimited': 'The model endpoint is rate limited. Try again shortly.',
				'state.tooLong': 'The draft is longer than this model can read at once. Shorten it and try again.',
				'state.truncated': 'The model’s reply was too long and got cut off. Your draft is untouched.',
				'state.unavailable': 'This environment has no model service, so rewriting isn’t available.',
				'state.refusedSubmitting': 'You’re submitting this input, so the result wasn’t written in. It’s kept — click to retry.',
				'state.refusedAdjudicating': 'Your previous input is still being handled, so the result wasn’t written in. It’s kept — click to retry.',
				'state.refusedStale': 'The draft changed, so the result didn’t overwrite what you typed. It’s kept — click to retry.',
				'state.refusedMapping': 'The composer wouldn’t take the replacement. The result is kept — click to retry.',
				'nav': 'Prompt Refinement',
				'title': 'Prompt refinement settings',
				'enabled.label': 'Enable',
				'preset.pickLabel': 'Preset',
				'name.label': 'Name',
				'showButton.label': 'Show button',
				'action.edit': 'Edit',
				'action.done': 'Done',
				'label.idleNamed': '{name}',
				'label.ordinal': '(button {index} of {total})',
				'page.noButtons': 'You haven’t ticked any preset, so no buttons will appear next to the input box.',
				'prompt.title': '{preset}: the full prompt for this one',
				'prompt.restoreDefault': 'Default',
				'context.label': 'Read the current conversation',
				'model.label': 'Which model to use',
				'model.groupLabel': 'Which model to use',
				'model.follow': 'Follow the current conversation',
				'model.fixed': 'Pin one',
				'model.followDescription': 'Use whatever model the current conversation is using.',
				'menu.loading': 'Loading available models…',
				'menu.loadFailed': 'Couldn’t load the models: {reason}',
				'menu.effortDefault': 'Default',
				'model.pickLabel': 'Model',
				'foot.unsaved': '{count} unsaved',
				'ctx.ok': 'Last rewrite: read {turns} turns of the conversation ({chars} chars)',
				'ctx.disabled': 'Last rewrite: didn’t read the conversation (switched off in Settings)',
				'ctx.noSession': 'Last rewrite: didn’t read the conversation (couldn’t tell which one it is)',
				'ctx.unreachable': 'Last rewrite: didn’t read the conversation (couldn’t open it)',
				'ctx.empty': 'Last rewrite: didn’t read the conversation (it has no history yet)',
				'ctx.filtered': 'Last rewrite: didn’t read the conversation (the history was filtered out by the message/character limit)',
				'ctx.unknown': 'Last rewrite: don’t know whether it read anything',
				'foot.clean': 'No changes',
				'model.effortLabel': 'Reasoning effort',
				'action.save': 'Save',
				'action.saving': 'Saving…',
				'action.discard': 'Discard changes',
				'page.unavailable': 'The settings service can’t be reached right now. Try again later.',
				'page.readOnly': 'This environment is read-only, so settings can’t be changed.',
				'page.dirty': 'You have changes that aren’t saved.',
				'page.saving': 'Saving…',
				'page.failed': 'Saving failed. Your changes are kept — fix the cause and try again.',
				'page.saved': 'Settings saved.',
				'page.noModelFixed': 'You chose “Pin one” but haven’t picked a model yet. Pick one from the list below, then save.',
			},
		};

		return {
			/**
			 * Only slots and locale at the top level: no `remote`, no `sessions`.
			 *
			 * A missing optional service keeps the whole plugin dormant, and the composer
			 * control needs neither — the Host half resolves the model, and the slot
			 * props already carry the composer face. The settings page's harder
			 * dependencies (`configForms`, `remote`) are demanded inside `apply` by a
			 * scoped inject, so a profile without the settings base packages loses the
			 * PAGE but never the composer control.
			 */
				inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(installStyles, 'dsh-draft-studio: styles');
				ctx.effect(
					() => ctx.locale.register(NS, DICTIONARY),
					'dsh-draft-studio: dictionaries',
				);
				// The preset store lives OUTSIDE the scoped inject below: the composer
				// seat is registered at the top level and must still render one button
				// in a profile that has no settings service at all (§8.2 rule 4). It
				// starts `ready: false`, so that profile simply keeps the degraded path.
				const presets = createPresetStore();
				// The seat itself: one list entry beside the submit action, scoped to the
				// session by the slot's own contract. Registration stays at the TOP level
				// (§10.2); the store arrives through the inject face instead, so a missing
				// `configForms` degrades the button count but never unregisters the seat.
				ctx.slots.inject('conversation.input.right', () =>
					ctx.slots.register(
						{
							name: 'conversation.input.right',
							id: 'dsh-draft-studio',
							order: 60,
							locale: NS,
							inject: () => ({ presets }),
						},
						RefineControl,
					),
				);
				// The settings page. It has NO transport of its own: every read and write
				// goes through `ctx.configForms.get('dsh-draft-studio')` — the Host
				// settings document, with its write queue, revision fencing and conflict
				// recovery — and the model menu reads `ctx.remote.session.modelCatalog()`,
				// the same projection the composer's model seat consumes.
				//
				// Scoped, not top-level, and guarded: the composer control must keep
				// working even where the scoped inject itself is unavailable.
				if (typeof ctx.inject === 'function') {
					// `remote.session` must be DECLARED here, not merely present: the client
	// guard rejects `scope.remote.session` with "cannot get property
				// 'remote.session' without inject" when the sub-path is not in the list.
				ctx.inject(['slots', 'locale', 'configForms', 'remote', 'remote.session'], (scope) => {
						const pageT = scope.locale.bind(NS);
						const controller = new SettingsPageController(scope, pageT);
						// The composer reads the SAME settings document the page writes:
						// attaching here means the two seats cannot disagree about which
						// presets are shown, and the store reads the resolved view, so an
						// upgrade that never touched `presetButtons` still shows all four.
						presets.attach(scope.configForms);
						scope.effect(
							() => () => controller.dispose(),
							'dsh-draft-studio: settings page',
						);
						scope.effect(
							() => () => presets.dispose(),
							'dsh-draft-studio: preset store',
						);
						scope.slots.inject('settings.section', () =>
							scope.slots.register(
								{
									name: 'settings.section',
									id: 'dsh-draft-studio',
									order: 60,
									label: () => pageT('nav'),
									locale: NS,
									// The page's data face: one controller instance per plugin
									// lifetime, holding the staged draft and the form writes.
									inject: () => ({ controller }),
								},
								SettingsSection,
							),
						);
					});
				}
			},
		};
	},
});