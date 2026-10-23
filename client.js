/**
 * dsh-pa — prompt enhancer (client half).
 *
 * Renders one compact diamond button in the composer tool row, immediately left of the
 * model selector (`conversation.input.right`). Pressing it sends the current draft to the
 * host half (`POST /api/dsh-pa/enhance`), which rewrites it with the session's selected
 * model. The original draft is remembered per session, so pressing the button again
 * restores it exactly — including when the enhanced text was never submitted.
 *
 * Two local shortcuts keep a click cheap: a draft that already reads like a structured
 * prompt is not sent at all (the button idles with an explanation), and the same draft
 * within a few minutes reuses the previous result instead of calling the model again.
 *
 * Boundaries kept on purpose:
 * - own slot entry id (`dsh-pa/enhance`) and order, so no other occupant of that list is
 *   displaced and the list keeps working if this plugin is absent;
 * - own route, request header, locale namespace, and style element, all prefixed `dsh-pa`;
 * - no DOM traversal into other plugins, no harness CSS classes, no global state.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pa',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-pa';
    const ENDPOINT = '/api/dsh-pa/enhance';
    const MAX_RECORDS = 32;
    const ERROR_VISIBLE_MS = 6000;
    const MAX_CACHE = 20;
    /**
     * Local fallbacks for the two settings the Host half owns. The row config
     * (`structuredMinChars`, `cacheTtlMs`) is fetched from `GET ENDPOINT` on mount and
     * replaces these, so the composer keeps working before that answer arrives.
     */
    const DEFAULT_SETTINGS = { structuredMinChars: 800, cacheTtlMs: 5 * 60 * 1000 };

    const DICTIONARIES = {
      zh: {
        'button.enhance': '增强提示词',
        'button.enhancing': '正在增强提示词…',
        'button.restore': '恢复原始输入',
        'button.empty': '请先输入内容',
        'button.blocked': '草稿正在提交，请稍候',
        'button.structured': '这段草稿已经是结构化提示词了',
        'button.unsupported': '当前版本不支持改写草稿',
        'error.prefix': '增强失败：',
        'error.network': '无法连接增强服务',
        'error.restore': '已恢复原始输入',
        'announce.enhanced': '已增强当前草稿，再次点击按钮可恢复原文。',
        'announce.restored': '已恢复原始草稿。',
      },
      en: {
        'button.enhance': 'Enhance prompt',
        'button.enhancing': 'Enhancing the prompt…',
        'button.restore': 'Restore original draft',
        'button.empty': 'Type something to enhance',
        'button.blocked': 'The draft is being submitted',
        'button.structured': 'This draft is already a structured prompt',
        'button.unsupported': 'This version cannot rewrite the draft',
        'error.prefix': 'Enhancement failed: ',
        'error.network': 'Cannot reach the enhancer service',
        'error.restore': 'Original draft restored',
        'announce.enhanced': 'Draft enhanced. Press the button again to restore the original.',
        'announce.restored': 'Original draft restored.',
      },
    };

    const CSS = `
.dsh-pa-button{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;min-width:28px;padding:0 6px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#6b6b6b);cursor:pointer;font:inherit;line-height:1;transition:background-color .15s ease,color .15s ease,opacity .15s ease}
.dsh-pa-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsh-pa-button:active:not(:disabled){transform:translateY(.5px)}
.dsh-pa-button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#247bbf));outline-offset:1px}
.dsh-pa-button:disabled{opacity:.45;cursor:default}
.dsh-pa-button[data-dsh-pa-state="active"]{color:var(--dsw-alias-brand-primary,#247bbf);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 12%,transparent)}
.dsh-pa-button[data-dsh-pa-state="error"]{color:var(--dsw-alias-state-error-primary,#d93026)}
.dsh-pa-button[data-dsh-pa-state="busy"]{color:var(--dsw-alias-brand-primary,#247bbf)}
.dsh-pa-button[data-dsh-pa-state="busy"] .dsh-pa-mark{animation:dsh-pa-pulse 1s ease-in-out infinite}
.dsh-pa-mark{display:block;flex:none}
.dsh-pa-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@keyframes dsh-pa-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dsh-pa-button[data-dsh-pa-state="busy"] .dsh-pa-mark{animation:none;opacity:.6}}
`;

    /** Original/enhanced pair per session; never leaves this module. */
    const records = new Map();

    const NO_SELECTOR_HOOK = () => void 0;

    function remember(sessionId, original, enhanced) {
      if (records.size >= MAX_RECORDS && !records.has(sessionId)) {
        const oldest = records.keys().next();
        if (!oldest.done) records.delete(oldest.value);
      }
      records.set(sessionId, { original, enhanced });
    }

    /** Recent rewrites, keyed by model + draft; the same draft never pays twice in a row. */
    const cache = new Map();

    function cacheKey(selection, draft) {
      return `${selection?.provider ?? ''}|${selection?.model ?? ''}|${draft}`;
    }

    function readCache(key, ttlMs) {
      if (!(ttlMs > 0)) return null;
      const hit = cache.get(key);
      if (hit === void 0) return null;
      if (Date.now() - hit.at > ttlMs) {
        cache.delete(key);
        return null;
      }
      return hit.text;
    }

    function writeCache(key, text) {
      if (cache.size >= MAX_CACHE && !cache.has(key)) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(key, { text, at: Date.now() });
    }

    /**
     * True when the draft already reads like a finished prompt: numbered or bulleted items
     * plus an explicit output expectation, or simply a very long text. Sending that to the
     * model spends a call to make it worse, so the button idles instead.
     */
    function looksStructured(text, minChars) {
      const body = text.trim();
      if (body.length === 0) return false;
      if (minChars > 0 && body.length >= minChars) return true;
      if (body.length < 40) return false;
      const listed =
        /(?:^|\n)[ \t]*(?:\d+[.)、]|[-*+•])[ \t]+\S/u.test(body)
        || /第[一二三四五六七八九十]+[条步点]/u.test(body);
      const output =
        /(输出|验收|完成后|逐条|说明改(?:动)?|output|acceptance|report back)/iu.test(body);
      return listed && output;
    }

    function readSelection(projection) {
      if (projection === null || typeof projection !== 'object') return null;
      const next = projection.next !== null && typeof projection.next === 'object' ? projection.next : projection;
      const provider = typeof next.provider === 'string' && next.provider !== '' ? next.provider : void 0;
      const model = typeof next.model === 'string' && next.model !== '' ? next.model : void 0;
      if (provider === void 0 && model === void 0) return null;
      return { provider, model };
    }

    function Diamond() {
      return h(
        'svg',
        {
          className: 'dsh-pa-mark',
          viewBox: '0 0 24 24',
          width: 15,
          height: 15,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M12 2 20.5 12 12 22 3.5 12Z',
          fill: 'currentColor',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinejoin: 'round',
        }),
      );
    }

    function EnhanceButton(props) {
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      const useInput = typeof props.useInput === 'function' ? props.useInput : NO_SELECTOR_HOOK;
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : NO_SELECTOR_HOOK;

      const inputState = useInput((state) => state);
      const projection = useProjection('modelSelection');
      // The slot framework injects `t` when a registration declares its locale; fall back
      // to the namespace translator bound in `apply` for older loaders.
      const tm = typeof props.t === 'function' ? props.t : t;

      const draft = inputState !== null && typeof inputState === 'object' && typeof inputState.draft === 'string'
        ? inputState.draft
        : '';
      const phase = inputState !== null && typeof inputState === 'object' ? inputState.phase : void 0;

      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [announcement, setAnnouncement] = React.useState('');
      const [settings, setSettings] = React.useState(DEFAULT_SETTINGS);
      const mounted = React.useRef(true);

      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      // The row config owns the gate threshold and the reuse window; ask once per mount.
      // A failed or refused request leaves the local defaults in place.
      React.useEffect(() => {
        let live = true;
        fetch(ENDPOINT, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { 'x-dsh-pa': '1' },
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (!live || payload === null || typeof payload !== 'object') return;
            const remote = payload.config;
            if (remote === null || typeof remote !== 'object') return;
            setSettings({
              structuredMinChars:
                typeof remote.structuredMinChars === 'number' && Number.isFinite(remote.structuredMinChars)
                  ? remote.structuredMinChars
                  : DEFAULT_SETTINGS.structuredMinChars,
              cacheTtlMs:
                typeof remote.cacheTtlMs === 'number' && Number.isFinite(remote.cacheTtlMs)
                  ? remote.cacheTtlMs
                  : DEFAULT_SETTINGS.cacheTtlMs,
            });
          })
          .catch(() => {
            /* the local defaults are the fallback */
          });
        return () => {
          live = false;
        };
      }, []);

      React.useEffect(() => {
        if (error === null) return void 0;
        const timer = setTimeout(() => {
          if (mounted.current) setError(null);
        }, ERROR_VISIBLE_MS);
        return () => clearTimeout(timer);
      }, [error]);

      // Drop a stored pair once the draft no longer matches it in either direction,
      // so a manual edit never leaves a stale restore target behind.
      React.useEffect(() => {
        if (sessionId === void 0) return;
        const record = records.get(sessionId);
        if (record === void 0) return;
        if (draft !== record.enhanced && draft !== record.original) records.delete(sessionId);
      }, [sessionId, draft]);

      if (sessionId === void 0) return null;

      const record = records.get(sessionId);
      const canRestore = record !== void 0 && draft === record.enhanced;
      const unsupported = inputActions === void 0 || typeof inputActions.setDraft !== 'function';
      const blockedPhase = phase === 'submitting' || phase === 'adjudicating';
      const hasText = draft.trim() !== '';
      const tooStructured = !canRestore && !busy && hasText && looksStructured(draft, settings.structuredMinChars);
      const disabled = unsupported || busy || (!canRestore && (blockedPhase || !hasText || tooStructured));

      const label = unsupported
        ? tm('button.unsupported')
        : busy
          ? tm('button.enhancing')
          : canRestore
            ? tm('button.restore')
            : blockedPhase
              ? tm('button.blocked')
              : !hasText
                ? tm('button.empty')
                : tooStructured
                  ? tm('button.structured')
                  : tm('button.enhance');

      const state = unsupported || tooStructured
        ? 'disabled'
        : busy
          ? 'busy'
          : canRestore
            ? 'active'
            : error !== null
              ? 'error'
              : 'idle';
      const title = error !== null ? `${tm('error.prefix')}${error}` : label;

      async function onClick(event) {
        event.preventDefault();
        if (disabled) return;
        setError(null);
        if (canRestore) {
          inputActions.setDraft(record.original);
          records.delete(sessionId);
          setAnnouncement(tm('announce.restored'));
          return;
        }
        const selection = readSelection(projection);
        const original = draft;
        const key = cacheKey(selection, original);
        const cached = readCache(key, settings.cacheTtlMs);
        if (cached !== null) {
          remember(sessionId, original, cached);
          inputActions.setDraft(cached);
          setAnnouncement(tm('announce.enhanced'));
          return;
        }
        setBusy(true);
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-dsh-pa': '1' },
            body: JSON.stringify({
              draft: original,
              provider: selection?.provider,
              model: selection?.model,
            }),
          });
          const payload = await response.json().catch(() => null);
          const failure = payload !== null && typeof payload === 'object' ? payload.error : null;
          if (!response.ok || payload?.ok !== true || typeof payload?.text !== 'string' || payload.text.trim() === '') {
            const reason =
              failure !== null && typeof failure === 'object' && typeof failure.message === 'string' && failure.message !== ''
                ? failure.message
                : failure !== null && typeof failure === 'object' && typeof failure.code === 'string'
                  ? failure.code
                  : `${response.status}`;
            throw new Error(reason);
          }
          if (!mounted.current) return;
          const enhanced = payload.text.trim();
          writeCache(key, enhanced);
          remember(sessionId, original, enhanced);
          inputActions.setDraft(enhanced);
          setAnnouncement(tm('announce.enhanced'));
        } catch (cause) {
          if (!mounted.current) return;
          const message = cause instanceof Error && cause.message !== '' ? cause.message : tm('error.network');
          setError(message);
          setAnnouncement('');
        } finally {
          if (mounted.current) setBusy(false);
        }
      }

      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-pa-button',
          'data-dsh-pa-state': state,
          'aria-label': label,
          'aria-pressed': canRestore ? 'true' : 'false',
          'aria-busy': busy ? 'true' : 'false',
          title,
          disabled,
          onClick,
        },
        h(Diamond),
        h('span', { className: 'dsh-pa-sr-only', role: 'status', 'aria-live': 'polite' }, announcement),
      );
    }

    /** Translator bound in `apply`; falls back to the zh dictionary before binding exists. */
    let translate = (key) => (DICTIONARIES.zh[key] ?? key);
    function t(key) {
      try {
        const value = translate(key);
        if (typeof value === 'string' && value !== '') return value;
      } catch {
        /* the locale service is optional at call time */
      }
      return DICTIONARIES.zh[key] ?? key;
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = NS;
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'dsh-pa: composer button styles');

        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-pa: dictionaries');
        translate = ctx.locale.bind(NS);

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'dsh-pa/enhance',
              order: 40,
              locale: NS,
            },
            EnhanceButton,
          ),
        );
      },
    };
  },
});
