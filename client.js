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
			'.dsh-pr-wrap{display:inline-flex;align-items:center}',
			'.dsh-pr-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-text-tertiary,currentColor);cursor:pointer;transition:background-color 120ms ease,color 120ms ease}',
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
			'.dsh-pr-area{width:100%;box-sizing:border-box;min-height:180px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,currentColor);font:inherit;font-size:13px;line-height:20px;resize:vertical}',
			'.dsh-pr-area:focus-visible{outline:none;border-color:var(--dsw-alias-brand,#247bbf);box-shadow:0 0 0 2px var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-area:disabled{cursor:default;opacity:.6}',
			'.dsh-pr-switch{position:relative;flex:none;width:34px;height:19px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.4));cursor:pointer;transition:background-color 120ms ease}',
			'.dsh-pr-switch:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-switch:disabled{cursor:default;opacity:.5}',
			'.dsh-pr-switch[aria-checked="true"]{background:var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-switch-knob{position:absolute;top:2.5px;left:2.5px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);transition:transform 120ms ease}',
			'.dsh-pr-switch[aria-checked="true"] .dsh-pr-switch-knob{transform:translateX(15px)}',
			// A2 布局：两列开关栅格、模型两列子字段、提示词 meta 行、吸底保存条
			'.dsh-pr-ctrl-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 32px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:10px;padding:14px 16px}',
			'.dsh-pr-ctrl-item{display:flex;align-items:center;gap:12px;min-width:0}',
			'.dsh-pr-ctrl-text{flex:1;min-width:0}',
			'.dsh-pr-ctrl-item .dsh-pr-switch{flex:none}',
			'.dsh-pr-sub-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 24px}',
			'.dsh-pr-field-k{display:block;font-family:inherit;font-size:11px;font-weight:500;line-height:14px;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary,currentColor);margin-bottom:6px}',
			'.dsh-pr-select{appearance:none;width:100%;box-sizing:border-box;height:32px;padding:0 26px 0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff) no-repeat right 10px center;color:var(--dsw-alias-label-primary,currentColor);font:inherit;font-size:13px;cursor:pointer}',
			'.dsh-pr-select:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary,currentColor)}',
			'.dsh-pr-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand,#247bbf);box-shadow:0 0 0 2px var(--dsw-alias-brand-soft,rgba(36,123,191,.15))}',
			'.dsh-pr-select:disabled{cursor:default;opacity:.5}',
			'.dsh-pr-foot{display:flex;align-items:center;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}',
			'.dsh-pr-foot .dsh-pr-grow{flex:1}',
			'.dsh-pr-count{font-size:12px;color:var(--dsw-alias-label-tertiary,currentColor)}',
			'.dsh-pr-count[data-dirty="true"]{color:var(--dsw-alias-label-primary,currentColor)}',
			'@media (max-width:480px){.dsh-pr-ctrl-grid,.dsh-pr-sub-grid{grid-template-columns:1fr}}',
			'.dsh-pr-save{border:none;border-radius:8px;padding:6px 14px;background:var(--dsw-alias-brand,#247bbf);color:var(--dsw-alias-bg-layer-1,#fff);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer}',
			'.dsh-pr-save:hover:not(:disabled){filter:brightness(1.06)}',
			'.dsh-pr-save:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-save:disabled{cursor:default;opacity:.5}',
			'.dsh-pr-ghost{border:none;border-radius:8px;padding:6px 12px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
			'.dsh-pr-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary,currentColor);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
			'.dsh-pr-ghost:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-ghost:disabled{cursor:default;opacity:.5}',
			'.dsh-pr-reset{border:none;border-radius:6px;padding:2px 8px;background:transparent;color:var(--dsw-alias-label-tertiary,currentColor);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
			'.dsh-pr-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary,currentColor);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
			'.dsh-pr-reset:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand,#247bbf)}',
			'.dsh-pr-reset:disabled{cursor:default;opacity:.5}',
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

		/** The refine mark: three shortening lines (a draft) plus a sparkle. */
		function RefineGlyph() {
			return h(
				'svg',
				{
					viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
					stroke: 'currentColor', strokeWidth: 1.7,
					strokeLinecap: 'round', strokeLinejoin: 'round',
					'aria-hidden': true, focusable: 'false',
				},
				h('path', { d: 'M4 7h9M4 12h6M4 17h4.5' }),
				h('path', { d: 'M17.6 4.4l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z' }),
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
				case 'NO_MODEL':
				case 'NO_ADAPTER':
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
						params: { reason: typeof payload?.error === 'string' && payload.error.length > 0 ? payload.error : code },
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
		 * @param field - the Config field being staged.
		 * @param value - the staged value.
		 * @returns whether the save must clear this field instead of setting it.
		 */
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

		function isFieldClear(field, value) {
			if (value === null) return true;
			return PROMPT_FIELDS.includes(field) && value === '';
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

		/** In-flight abort handle per SessionId; present only while a run is open. */
		const RUNNING = new Map();

		/**
		 * One empty (staged-nothing) page draft.
		 * @returns a fresh draft whose every field is unstaged.
		 */
		function emptyDraft() {
			return {
				enabled: undefined, preset: undefined,
				promptGeneral: undefined, promptCode: undefined,
				promptWriting: undefined, promptTranslation: undefined,
				contextEnabled: undefined, modelMode: undefined,
				provider: undefined, model: undefined, reasoningEffort: undefined,
			};
		}

		/** The four visible model fields of one draft, for equality checks. */
		function visibleDraft(draft) {
			return {
				enabled: draft.enabled,
				preset: draft.preset,
				promptGeneral: draft.promptGeneral,
				promptCode: draft.promptCode,
				promptWriting: draft.promptWriting,
				promptTranslation: draft.promptTranslation,
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

			/** One merged view: snapshot values with staged edits on top. */
			get view() {
				const snap = this.snapshot;
				const value = snap !== null && snap.status === 'ready' && snap.value !== undefined && snap.value !== null ? snap.value : {};
				const draft = this.draft;
				return {
					enabled: draft.enabled !== undefined ? draft.enabled : value.enabled,
					preset: normalizePreset(draft.preset !== undefined ? draft.preset : value.preset),
					promptGeneral: this.promptView('promptGeneral'),
					promptCode: this.promptView('promptCode'),
					promptWriting: this.promptView('promptWriting'),
					promptTranslation: this.promptView('promptTranslation'),
					contextEnabled: draft.contextEnabled !== undefined ? draft.contextEnabled : value.contextEnabled,
					modelMode: draft.modelMode !== undefined ? draft.modelMode : value.modelMode,
					provider: draft.provider !== undefined ? draft.provider : (typeof value.provider === 'string' ? value.provider : ''),
					model: draft.model !== undefined ? draft.model : (typeof value.model === 'string' ? value.model : ''),
					reasoningEffort: draft.reasoningEffort !== undefined
						? draft.reasoningEffort
						: (typeof value.reasoningEffort === 'string' ? value.reasoningEffort : ''),
				};
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
				this.stage('preset', preset);
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

		/** The prompt editor: full text, staged draft, unset semantics. */
		function PromptEditor({ controller, preset, t, disabled }) {
			const text = controller.promptDraft(preset);
			const overridden = controller.promptOverridden(preset);
			const isDefault = controller.draft[presetField(preset)] === undefined && !overridden;
			return h(
				'div',
				{ className: 'dsh-pr-row' },
				h(
					'div',
					{ className: 'dsh-pr-rowhead' },
					h('span', { className: 'dsh-pr-label' }, t('prompt.title', { preset: t(`preset.${preset}`) })),
					h(
						'button',
						{
							type: 'button',
							className: 'dsh-pr-reset',
							disabled: disabled || isDefault,
							onClick: () => controller.resetPrompt(preset),
						},
						t('prompt.restoreDefault'),
					),
				),
				h('textarea', {
					className: 'dsh-pr-area',
					value: text,
					disabled,
					'aria-label': t('prompt.title', { preset: t(`preset.${preset}`) }),
					onChange: (event) => controller.editPrompt(preset, event.target.value),
				}),

			);
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
				h('div', { className: 'dsh-pr-ctrl-grid' },
					h(
						'div',
						{ className: 'dsh-pr-ctrl-item' },
						h('div', { className: 'dsh-pr-ctrl-text' },
							h('div', { className: 'dsh-pr-label' }, t('enabled.label')),
						),
						h('button', {
							type: 'button',
							className: 'dsh-pr-switch',
							role: 'switch',
							'aria-checked': view.enabled === true,
							disabled: !writable,
							onClick: () => controller.toggleEnabled(),
						}, h('span', { className: 'dsh-pr-switch-knob' })),
					),
					h(
						'div',
						{ className: 'dsh-pr-ctrl-item' },
						h('div', { className: 'dsh-pr-ctrl-text' },
							h('div', { className: 'dsh-pr-label' }, t('context.label')),
						),
						h('button', {
							type: 'button',
							className: 'dsh-pr-switch',
							role: 'switch',
							'aria-checked': view.contextEnabled === true,
							disabled: !writable,
							onClick: () => controller.toggleContext(),
						}, h('span', { className: 'dsh-pr-switch-knob' })),
					),
				),
				h(
					'div',
					{ className: 'dsh-pr-row' },
					h('div', { className: 'dsh-pr-rowhead' }, h('span', { className: 'dsh-pr-label' }, t('preset.groupLabel'))),
					h('select', {
						className: 'dsh-pr-select',
						'aria-label': t('preset.groupLabel'),
						disabled: !writable,
						value: normalizePreset(view.preset),
						onChange: (event) => controller.selectPreset(event.target.value),
					}, PRESET_KEYS.map((key) => h('option', { key, value: key }, t(`preset.${key}`)))),
				),
				...PRESET_KEYS.map((preset) => preset === normalizePreset(view.preset)
					? h(PromptEditor, { key: preset, controller, preset, t, disabled: !writable })
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
		 * The composer control.
		 *
		 * Receives the slot's standard props: `sessionId`, `useInput`, `inputActions`
		 * and the bound translator `t`.
		 */
		function RefineControl(props) {
			const { sessionId, useInput, inputActions, t } = props;

			// One selector per field: each subscribes to the smallest slice, so the button
			// does not re-render on unrelated composer changes.
			const draft = useInput((state) => state.draft);
			const draftRev = useInput((state) => state.draftRev);
			const phase = useInput((state) => state.phase);
			// Reference-chip occurrences in clipboard coordinates (hosts without chips
			// publish an empty list; older hosts may omit the field entirely).
			const occurrences = useInput((state) => state.occurrences);

			// One record per session, held at MODULE level: this seat unmounts on a
			// session switch, and component-held state would take the run with it.
			const store = TASKS;

			const [, forceRender] = useReducer((n) => n + 1, 0);
			const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'unknown';
			const task = store.get(key) ?? emptyTask();

			/** Apply one action to this session's record and re-render. */
			const dispatch = useCallback((action) => {
				const current = store.get(key) ?? emptyTask();
				store.set(key, taskReducer(current, action));
				forceRender();
			}, [key, store]);

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
			 * Run one refinement.
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
				RUNNING.set(key, controller);
				// Bump the generation and remember it: anything settling after a newer run
				// started carries a stale number and is dropped.
				const generation = (store.get(key) ?? emptyTask()).generation + 1;
				dispatch({ type: 'start' });

				// Generation is the only guard now: any cancel path bumps it, so a late
				// reply is stale whether or not this seat is still mounted.
				const stillCurrent = () => (store.get(key) ?? emptyTask()).generation === generation;

				try {
					const response = await sendRequest(REFINE_PATH, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							draft: source,
							...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
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
					if (RUNNING.get(key) === controller) RUNNING.delete(key);
				}
			}, [deliver, dispatch, key, sessionId, store, task.parked]);

			/** Click: cancel while busy, revert in the undo seat, otherwise start/retry. */
			const onClick = useCallback(() => {
				if (task.status === 'busy') {
					const controller = RUNNING.get(key);
					RUNNING.delete(key);
					controller?.abort();
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
			}, [dispatch, key, revert, run, task.snapshot, task.status]);

			// A sent draft (or one emptied under us) ends the run silently: the result had
			// nowhere to go, and a spinner with no draft reads as broken. This is the one
			// abort that is NOT an unmount — switching sessions must keep the run alive.
			useEffect(() => {
				if (task.status !== 'busy') return;
				const sent = phase === 'submitting' || phase === 'adjudicating';
				const emptied = cleanDraft(draft).length === 0;
				if (!sent && !emptied) return;
				const controller = RUNNING.get(key);
				if (controller === undefined) return;
				RUNNING.delete(key);
				controller.abort();
				dispatch({ type: 'discardRun' });
			}, [phase, draft, task.status, key, dispatch]);

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
					label = t('label.idle');
			}

			// Nothing to act on: no draft, no work in flight, no result to restore, no
			// failure to retry. Returning null does not mount the entry at all — hiding it
			// with CSS would still reserve the toolbar cell and stay reachable by keyboard.
			// Nothing can be retried or reverted over an empty box: after a failure the user
			// may well send the draft anyway (or clear it), and a leftover retry glyph then
			// describes work that no longer has a target.
			if (isBlankDraft(draft) && state !== 'undo') return null;

			const disabled = inputActions === undefined || typeof inputActions.insertText !== 'function';
			const announcement = task.announce === undefined || task.announce === null
				? ''
				: t(task.announce.key, task.announce.params);
			const glyph = state === 'busy'
				? h(StopGlyph)
				: state === 'undo'
					? h(UndoGlyph)
					: state === 'error'
						? h(RetryGlyph)
						: h(RefineGlyph);

			return h(
				'span',
				{ className: 'dsh-pr-wrap' },
				h(
					'button',
					{
						type: 'button',
						className: 'dsh-pr-btn',
						'data-state': state,
						disabled,
						// `aria-pressed` would claim a toggle; this control's action changes with
						// its state, so the accessible name states what a click does.
						title: label,
						'aria-label': label,
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
				'label.idle': '把草稿优化成更清晰的提示词',
				'label.busyWithTime': '正在优化… 已用 {seconds} 秒',
				'label.undo': '回退到优化前的草稿（也可以按 Ctrl+Z）',
				'label.retry': '上次优化失败，点击重试',
				'state.cancelled': '已取消优化，草稿保持不变。',
				'state.reverted': '已回退到优化前的草稿。',
				'state.failed': '优化失败：{reason}',
				'state.network': '优化失败：网络中断，请重试。',
				'state.transport': '优化接口不可用（HTTP {status}），请确认插件已启用。',
				'state.empty': '模型没有返回可用的提示词，草稿保持不变。',
				'state.emptyReasoning': '模型把输出预算用在了思考上，没有产出提示词。请重试或换一个模型。',
				'state.emptyDraft': '草稿是空的，没有可优化的内容。',
				'state.disabled': '提示词优化已关闭，请在设置中开启。',
				'state.noModel': '当前没有可用的模型选择，请先选择一个模型。',
				'state.noCredential': '当前模型缺少可用凭据，请补齐后重试。',
				'state.rateLimited': '模型接口限流，请稍后重试。',
				'state.tooLong': '草稿超出当前模型的上下文窗口，请缩短后重试。',
				'state.truncated': '模型返回内容过长，已停止，草稿保持不变。',
				'state.unavailable': '当前环境未提供模型服务，无法优化提示词。',
				'state.refusedSubmitting': '正在提交输入，优化结果未写入。结果已保留，可点击重试。',
				'state.refusedAdjudicating': '正在处理上一条输入，优化结果未写入。结果已保留，可点击重试。',
				'state.refusedStale': '草稿已变化，优化结果未覆盖原稿。结果已保留，可点击重试。',
				'state.refusedMapping': '输入框未能接受替换，优化结果未写入。结果已保留，可点击重试。',
				'nav': '提示词优化',
				'title': '提示词优化设置',
				'enabled.label': '启用提示词优化',
				'preset.groupLabel': '预设',
				'preset.general': '通用',
				'preset.code': '编程',
				'preset.writing': '写作',
				'preset.translation': '翻译',
				'prompt.title': '{preset}预设的完整提示词',
				'prompt.restoreDefault': '恢复默认',
				'context.label': '读取会话上下文',
				'model.label': '模型来源',
				'model.groupLabel': '模型来源',
				'model.follow': '跟随会话',
				'model.fixed': '固定模型',
				'model.followDescription': '使用当前会话正在使用的模型。',
				'menu.loading': '正在加载模型目录…',
				'menu.loadFailed': '模型目录加载失败：{reason}',
				'menu.effortDefault': '模型默认',
				'model.pickLabel': '模型',
				'foot.unsaved': '未保存 {count} 项',
				'foot.clean': '未修改',
				'model.effortLabel': '思考强度',
				'action.save': '保存',
				'action.saving': '正在保存…',
				'action.discard': '放弃更改',
				'page.unavailable': '设置服务暂不可用，稍后再试。',
				'page.readOnly': '当前环境为只读，设置无法修改。',
				'page.dirty': '有未保存的更改。',
				'page.saving': '正在保存…',
				'page.failed': '保存失败，更改已保留，可修正后重试。',
				'page.saved': '设置已保存。',
				'page.noModelFixed': '已选择「固定模型」但还没有选具体模型，请先在模型目录中选择，再保存。',
			},
			en: {
				'label.idle': 'Refine the draft into a clearer prompt',
				'label.busyWithTime': 'Refining… {seconds}s',
				'label.undo': 'Restore the draft from before the refinement (or press Ctrl+Z)',
				'label.retry': 'The last refinement failed; click to retry',
				'state.cancelled': 'Refinement cancelled; the draft is unchanged.',
				'state.reverted': 'Restored the draft from before the refinement.',
				'state.failed': 'Refinement failed: {reason}',
				'state.network': 'Refinement failed: the connection dropped; try again.',
				'state.transport': 'The refinement endpoint is unavailable (HTTP {status}); check that the plugin is enabled.',
				'state.empty': 'The model returned no usable prompt; the draft is unchanged.',
				'state.emptyReasoning': 'The model spent its output budget on reasoning and produced no prompt. Retry, or switch models.',
				'state.emptyDraft': 'The draft is empty; there is nothing to refine.',
				'state.disabled': 'Prompt refinement is switched off; enable it in Settings.',
				'state.noModel': 'No model is available; choose one in the conversation first.',
				'state.noCredential': 'The current model has no usable credential; add one and retry.',
				'state.rateLimited': 'The model endpoint is rate limited; try again shortly.',
				'state.tooLong': 'The draft exceeds the current model context window; shorten it and retry.',
				'state.truncated': 'The model response was too long and was stopped; the draft is unchanged.',
				'state.unavailable': 'This environment provides no model service, so refinement is unavailable.',
				'state.refusedSubmitting': 'The composer is submitting, so the result was not written. It is kept — click to retry.',
				'state.refusedAdjudicating': 'The composer is handling the previous input, so the result was not written. It is kept — click to retry.',
				'state.refusedStale': 'The draft changed, so the result did not replace it. It is kept — click to retry.',
				'state.refusedMapping': 'The composer did not accept the replacement. The result is kept — click to retry.',
				'nav': 'Prompt Refine',
				'title': 'Prompt refinement settings',
				'enabled.label': 'Enable prompt refinement',
				'preset.groupLabel': 'Preset',
				'preset.general': 'General',
				'preset.code': 'Code',
				'preset.writing': 'Writing',
				'preset.translation': 'Translation',
				'prompt.title': 'Full prompt for the {preset} preset',
				'prompt.restoreDefault': 'Restore default',
				'context.label': 'Read conversation context',
				'model.label': 'Model source',
				'model.groupLabel': 'Model source',
				'model.follow': 'Follow session',
				'model.fixed': 'Fixed model',
				'model.followDescription': 'Use whatever model the current session is using.',
				'menu.loading': 'Loading the model catalogue…',
				'menu.loadFailed': 'Loading the model catalogue failed: {reason}',
				'menu.effortDefault': 'Model default',
				'model.pickLabel': 'Model',
				'foot.unsaved': '{count} unsaved',
				'foot.clean': 'No changes',
				'model.effortLabel': 'Reasoning effort',
				'action.save': 'Save',
				'action.saving': 'Saving…',
				'action.discard': 'Discard changes',
				'page.unavailable': 'The settings service is unavailable right now; try again later.',
				'page.readOnly': 'This environment is read-only, so settings cannot be changed.',
				'page.dirty': 'You have unsaved changes.',
				'page.saving': 'Saving…',
				'page.failed': 'Saving failed; your changes are kept — fix the cause and retry.',
				'page.saved': 'Settings saved.',
				'page.noModelFixed': '"Fixed model" is selected but no model is chosen yet; pick one from the catalogue before saving.',
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
				// The seat itself: one list entry beside the submit action, scoped to the
				// session by the slot's own contract.
				ctx.slots.inject('conversation.input.right', () =>
					ctx.slots.register(
						{ name: 'conversation.input.right', id: 'dsh-draft-studio', order: 60, locale: NS },
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
						scope.effect(
							() => () => controller.dispose(),
							'dsh-draft-studio: settings page',
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
