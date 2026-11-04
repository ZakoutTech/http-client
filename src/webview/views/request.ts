import { HTTP_METHODS, type BodyType, type HttpMethod, type KeyValue, type RequestItem, type ResponseData } from '../../shared/model';
import { authEditor, button, emptyState, kvTable } from '../components';
import { el, highlightJson, icon, iconButton } from '../dom';
import { app, Draft, findRequest, persist, post, store, variableScope, type ResponseSlot } from '../store';
import {
  BADGE,
  CHIP,
  CHIP_DYNAMIC,
  CHIP_MISSING,
  CHIP_OK,
  cx,
  FORM_GRID,
  HEADER_ACTIONS,
  HINT,
  ICON_BTN_BORDERED,
  LINK_BTN,
  methodColor,
  PLACEHOLDER,
  SPINNER,
  tab,
  TABS,
  TABS_COMPACT,
  TITLE_INPUT,
  VIEW_HEADER,
} from '../ui';

const CRUMB = 'inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted';
const SEP = 'opacity-60';
const META = 'font-mono text-[0.92em] text-muted';
const methodSelectClass = (method: string): string => cx('font-mono font-bold', methodColor(method));

let draft: Draft<RequestItem> | undefined;
/** `content` holds the request pane's children; its height is the pane's minimum (the pane never scrolls). */
let section: { request: HTMLElement; content: HTMLElement; response: HTMLElement } | undefined;

function ensureDraft(requestId: string): Draft<RequestItem> | undefined {
  const loc = findRequest(requestId);
  if (!loc) return undefined;
  if (!draft || draft.key !== requestId) {
    draft?.flush();
    draft = new Draft(requestId, loc.request, (request) => post({ type: 'updateRequest', request }));
  }
  return draft;
}

/** Called on every state update; returns true if the view must re-render. */
export function syncRequestView(requestId: string): boolean {
  const loc = findRequest(requestId);
  if (!loc) return true;
  return ensureDraft(requestId)?.sync(loc.request) ?? true;
}

export function flushRequestDraft(): void {
  draft?.flush();
}

function sendRequest(): void {
  if (!draft) return;
  const slot = store.responses.get(draft.key);
  if (slot?.sending) return;
  draft.flush();
  post({ type: 'send', request: structuredClone(draft.value) });
}

export function renderRequestView(container: HTMLElement, requestId: string): void {
  const loc = findRequest(requestId);
  const d = ensureDraft(requestId);
  if (!loc || !d) {
    container.replaceChildren(
      emptyState('search', 'Request not found', 'It may have been deleted or moved.', [button('Back to start', () => app.navigate({ view: 'welcome' }), { secondary: true })]),
    );
    return;
  }
  // The height is set by applySplit(). overflow-auto is only a fallback for when the content alone
  // is taller than the view leaves room for.
  const contentEl = el('div', { class: 'flow-root' });
  const requestEl = el('section', { class: 'flex-none overflow-auto px-4 pt-3 pb-1.5' }, [contentEl]);
  const responseEl = el('section', { class: 'flex min-h-0 flex-[1_1_0] flex-col overflow-hidden px-4 pt-2 pb-3', 'aria-live': 'polite' });
  section = { request: requestEl, content: contentEl, response: responseEl };
  container.replaceChildren(requestEl, splitter(container, requestEl), responseEl);
  renderRequestPane();
  renderResponsePane();
  applySplit(container, requestEl);
  observeSplit(container, requestEl, contentEl);
}

// ---------- resizable split ----------

/** Space always left for the response pane (status line + a few lines of body). */
const MIN_RESPONSE_PX = 120;
const KEY_STEP_PX = 24;

let splitObserver: ResizeObserver | undefined;

/** Natural height of the request pane: its content plus vertical padding, so nothing needs to scroll. */
function contentHeight(requestEl: HTMLElement): number {
  const content = requestEl.firstElementChild as HTMLElement | null;
  const cs = getComputedStyle(requestEl);
  return Math.ceil((content?.offsetHeight ?? 0) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
}

/** Clamps a request-pane height between its content height and the room left above the response pane. */
function clampSplit(container: HTMLElement, requestEl: HTMLElement, px: number): number {
  const max = container.clientHeight - MIN_RESPONSE_PX;
  return Math.max(0, Math.min(Math.max(px, contentHeight(requestEl)), max));
}

/** Sizes the request pane: its content height by default, or the user's share of the view (never less than the content). */
function applySplit(container: HTMLElement, requestEl: HTMLElement): void {
  const h = container.clientHeight;
  if (!h) return;
  const wanted = store.requestSplit === undefined ? 0 : store.requestSplit * h;
  requestEl.style.flexBasis = `${clampSplit(container, requestEl, wanted)}px`;
}

/** Re-applies the split when the view is resized or the request content changes height. */
function observeSplit(container: HTMLElement, requestEl: HTMLElement, contentEl: HTMLElement): void {
  splitObserver?.disconnect();
  splitObserver = new ResizeObserver(() => {
    if (!requestEl.isConnected) {
      splitObserver?.disconnect();
      return;
    }
    applySplit(container, requestEl);
  });
  splitObserver.observe(container);
  splitObserver.observe(contentEl);
}

function setSplit(container: HTMLElement, requestEl: HTMLElement, px: number | undefined): void {
  const h = container.clientHeight;
  // Store the clamped value so dragging past the limit doesn't leave a hidden "debt" to drag back through.
  store.requestSplit = px === undefined || h === 0 ? undefined : clampSplit(container, requestEl, px) / h;
  applySplit(container, requestEl);
}

function splitter(container: HTMLElement, requestEl: HTMLElement): HTMLElement {
  const handle = el('div', {
    class:
      'relative z-[1] -my-[3px] h-[7px] flex-none cursor-row-resize touch-none bg-[linear-gradient(var(--color-line),var(--color-line))] bg-[length:100%_1px] bg-center bg-no-repeat hover:bg-[linear-gradient(var(--color-accent),var(--color-accent))] hover:bg-[length:100%_3px] focus-visible:bg-[linear-gradient(var(--color-accent),var(--color-accent))] focus-visible:bg-[length:100%_3px] focus-visible:outline-none data-dragging:bg-[linear-gradient(var(--color-accent),var(--color-accent))] data-dragging:bg-[length:100%_3px]',
    role: 'separator',
    'aria-orientation': 'horizontal',
    'aria-label': 'Resize request and response panes',
    tabindex: '0',
    title: 'Drag to resize · double-click to reset',
  });
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.dataset.dragging = '';
    const offset = e.clientY - requestEl.getBoundingClientRect().bottom;
    const top = container.getBoundingClientRect().top;
    const move = (ev: PointerEvent): void => setSplit(container, requestEl, ev.clientY - top - offset);
    const end = (): void => {
      delete handle.dataset.dragging;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      persist();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  handle.addEventListener('dblclick', () => {
    setSplit(container, requestEl, undefined);
    persist();
  });
  handle.addEventListener('keydown', (e) => {
    const current = requestEl.getBoundingClientRect().height;
    let next: number | undefined;
    if (e.key === 'ArrowUp') next = current - KEY_STEP_PX;
    else if (e.key === 'ArrowDown') next = current + KEY_STEP_PX;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = container.clientHeight;
    else if (e.key === 'Escape' || e.key === 'Enter') {
      setSplit(container, requestEl, undefined);
      persist();
      return;
    } else return;
    e.preventDefault();
    setSplit(container, requestEl, next);
    persist();
  });
  return handle;
}

function changed(): void {
  draft?.touch();
}

function renderRequestPane(): void {
  if (!draft || !section) return;
  const r = draft.value;
  const loc = findRequest(r.id);
  const root = section.content;
  root.replaceChildren();
  if (!loc) return;

  // Header: breadcrumb + inline name + actions
  root.append(
    el('div', { class: VIEW_HEADER }, [
      el('div', { class: 'inline-flex items-center gap-1 overflow-hidden whitespace-nowrap text-muted' }, [
        el('button', { class: cx(CRUMB, 'hover:bg-hover hover:text-fg'), type: 'button', onclick: () => app.navigate({ view: 'collection', collectionId: loc.collection.id }) }, [
          icon('collection', 13),
          loc.collection.name,
        ]),
        ...loc.path.flatMap((f) => [el('span', { class: SEP }, ['›']), el('span', { class: CRUMB }, [icon('folder', 13), f.name])]),
        el('span', { class: SEP }, ['›']),
      ]),
      el('input', {
        class: TITLE_INPUT,
        type: 'text',
        value: r.name,
        'aria-label': 'Request name',
        oninput: (e: Event) => {
          r.name = (e.target as HTMLInputElement).value;
          changed();
        },
        onchange: () => app.renderSidebar(),
      }),
      el('div', { class: HEADER_ACTIONS }, [
        iconButton('copy', 'Duplicate request', () => post({ type: 'itemAction', action: 'duplicate', collectionId: loc.collection.id, itemId: r.id })),
        iconButton('trash', 'Delete request', () => post({ type: 'itemAction', action: 'delete', collectionId: loc.collection.id, itemId: r.id })),
      ]),
    ]),
  );

  const sending = store.responses.get(r.id)?.sending;
  root.append(
    el('div', { class: 'flex items-stretch gap-1.5' }, [
      el('select', {
        class: methodSelectClass(r.method),
        'aria-label': 'HTTP method',
        onchange: (e: Event) => {
          r.method = (e.target as HTMLSelectElement).value as HttpMethod;
          (e.target as HTMLSelectElement).className = methodSelectClass(r.method);
          changed();
          app.renderSidebar();
        },
      }, HTTP_METHODS.map((m) => el('option', { value: m, selected: m === r.method }, [m]))),
      el('input', {
        class: 'flex-auto font-mono',
        type: 'text',
        value: r.url,
        placeholder: '{{baseUrl}}/path',
        'aria-label': 'URL',
        spellcheck: 'false',
        oninput: (e: Event) => {
          r.url = (e.target as HTMLInputElement).value;
          changed();
          renderVariableChips();
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') sendRequest();
        },
      }),
      sending
        ? button('Cancel', () => post({ type: 'cancel', requestId: r.id }), { secondary: true })
        : button('Send', sendRequest, { icon: 'send', title: 'Send (Ctrl/Cmd+Enter)' }),
      iconButton('terminal', 'Copy as cURL', () => post({ type: 'copyAsCurl', request: structuredClone(r) }), ICON_BTN_BORDERED),
    ]),
    el('div', { class: 'mt-2 flex min-h-1 flex-wrap items-center gap-1.5 text-[0.9em]', 'data-role': 'var-chips' }),
  );
  renderVariableChips();

  const count = (list: KeyValue[]) => list.filter((x) => x.enabled && x.key).length;
  const tabs: ['params' | 'headers' | 'body' | 'auth', string, string?][] = [
    ['params', 'Params', count(r.params) ? String(count(r.params)) : undefined],
    ['headers', 'Headers', count(r.headers) ? String(count(r.headers)) : undefined],
    ['body', 'Body', r.body.type !== 'none' ? r.body.type.toUpperCase() : undefined],
    ['auth', 'Auth', r.auth.type === 'none' ? undefined : r.auth.type],
  ];
  root.append(
    el('div', { class: TABS, role: 'tablist' }, tabs.map(([id, label, badge]) =>
      el('button', {
        class: tab(store.requestTab === id),
        role: 'tab',
        type: 'button',
        'aria-selected': String(store.requestTab === id),
        onclick: () => {
          store.requestTab = id;
          renderRequestPane();
        },
      }, [label, badge ? el('span', { class: cx(BADGE, 'lowercase') }, [badge]) : null]),
    )),
  );

  const panel = el('div', { role: 'tabpanel' });
  root.append(panel);
  const rerender = () => renderRequestPane();
  switch (store.requestTab) {
    case 'params':
      panel.append(kvTable(r.params, { noun: 'Parameter', changed, rerender }));
      break;
    case 'headers':
      panel.append(kvTable(r.headers, { noun: 'Header', changed, rerender }));
      break;
    case 'body':
      panel.append(bodyEditor(r));
      break;
    case 'auth':
      panel.append(authEditor(() => r.auth, (a) => (r.auth = a), changed, rerender, true));
      break;
  }
}

/** Shows every {{variable}} the request uses and whether it resolves in the current environment. */
function renderVariableChips(): void {
  if (!draft || !section) return;
  const holder = section.request.querySelector('[data-role=var-chips]');
  if (!holder) return;
  const r = draft.value;
  const loc = findRequest(r.id);
  const scope = variableScope(loc?.collection);
  const text = [r.url, ...r.params.flatMap((p) => [p.key, p.value]), ...r.headers.flatMap((h) => [h.key, h.value]), r.body.raw ?? '', JSON.stringify(r.auth)].join('\n');
  const names = [...new Set([...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1].trim()))];
  if (!names.length) {
    holder.replaceChildren();
    return;
  }
  holder.replaceChildren(
    el('span', { class: 'text-muted' }, ['Variables:']),
    ...names.map((name) => {
      if (name.startsWith('$')) {
        const isDotenv = name.startsWith('$dotenv');
        const ok = !isDotenv || store.data?.dotenvKeys.includes(name.split(/\s+/)[1] ?? '');
        return el('span', { class: cx(CHIP, ok ? CHIP_DYNAMIC : CHIP_MISSING), title: isDotenv ? 'Value from the workspace .env file' : 'Dynamic value generated on send' }, [icon('bolt', 12), name]);
      }
      const v = scope.get(name);
      return el('button', {
        class: cx(CHIP, v ? CHIP_OK : CHIP_MISSING, 'hover:bg-hover'),
        type: 'button',
        title: v ? `${v.secret ? '(secret) ' : ''}${v.value || '(empty)'} — from ${v.source}` : 'Not defined — click to manage variables',
        onclick: () => app.navigate({ view: 'variables', environmentId: store.data?.activeEnvironmentId ?? undefined }),
      }, [icon(v ? (v.secret ? 'lock' : 'check') : 'close', 12), name]);
    }),
  );
}

const BODY_TYPES: [BodyType, string][] = [
  ['none', 'None'],
  ['json', 'JSON'],
  ['text', 'Text'],
  ['xml', 'XML'],
  ['form', 'Form URL-encoded'],
  ['multipart', 'Multipart'],
  ['binary', 'Binary file'],
];

function bodyEditor(r: RequestItem): HTMLElement {
  const b = r.body;
  const rerender = () => renderRequestPane();
  const wrap = el('div', { class: 'flex flex-col items-start gap-2' });
  wrap.append(
    el('div', { class: 'mb-0.5 inline-flex flex-wrap overflow-hidden rounded border border-control', role: 'radiogroup', 'aria-label': 'Body type' }, BODY_TYPES.map(([type, label]) =>
      el('button', {
        class: cx('border-r border-control px-2.5 py-1 last:border-r-0', b.type === type && 'bg-btn2 font-semibold text-btn2-fg'),
        type: 'button',
        role: 'radio',
        'aria-checked': String(b.type === type),
        onclick: () => {
          b.type = type;
          if (type === 'form') b.form ??= [];
          if (type === 'multipart') b.multipart ??= [];
          changed();
          rerender();
        },
      }, [label]),
    )),
  );

  switch (b.type) {
    case 'json':
    case 'text':
    case 'xml': {
      const area = el('textarea', {
        class: 'min-h-[180px] font-mono leading-[1.45]',
        spellcheck: 'false',
        'aria-label': 'Request body',
        placeholder: b.type === 'json' ? '{\n  "name": "{{userName}}"\n}' : '',
        oninput: (e: Event) => {
          b.raw = (e.target as HTMLTextAreaElement).value;
          changed();
          renderVariableChips();
        },
      });
      area.value = b.raw ?? '';
      wrap.append(area);
      if (b.type === 'json') {
        wrap.append(
          button('Beautify', () => {
            try {
              b.raw = JSON.stringify(JSON.parse(b.raw ?? ''), null, 2);
              area.value = b.raw;
              changed();
            } catch {
              area.setCustomValidity('Not valid JSON');
              area.reportValidity();
              setTimeout(() => area.setCustomValidity(''), 1500);
            }
          }, { secondary: true }),
        );
      }
      break;
    }
    case 'form':
      wrap.append(kvTable((b.form ??= []), { noun: 'Field', changed, rerender }));
      break;
    case 'multipart':
      wrap.append(kvTable((b.multipart ??= []), { noun: 'Part', changed, rerender, multipart: true, isLive: () => draft?.value === r }));
      if (r.headers.some((h) => h.enabled && h.key.trim().toLowerCase() === 'content-type')) {
        wrap.append(
          el('div', { class: 'flex items-center gap-2 text-warning' }, [
            icon('braces', 14),
            'Your Content-Type header is ignored for multipart — the boundary is generated when sending.',
          ]),
        );
      }
      break;
    case 'binary':
      wrap.append(
        el('div', { class: FORM_GRID }, [
          el('label', {}, ['File path']),
          el('input', {
            type: 'text',
            value: b.file ?? '',
            placeholder: 'path/to/file.bin (relative to workspace)',
            oninput: (e: Event) => {
              b.file = (e.target as HTMLInputElement).value;
              changed();
            },
          }),
        ]),
      );
      break;
    default:
      wrap.append(el('p', { class: HINT }, ['This request has no body.']));
  }
  return wrap;
}

// ---------- response ----------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function statusClass(status: number): string {
  if (status < 300) return 'bg-green/16 text-green';
  if (status < 400) return 'bg-blue/16 text-blue';
  if (status < 500) return 'bg-orange/18 text-orange';
  return 'bg-red/18 text-red';
}

function unresolvedWarning(slot: ResponseSlot): HTMLElement | null {
  if (!slot.unresolved.length) return null;
  return el('div', { class: 'mt-1 mb-2 flex items-center gap-2 text-warning' }, [
    icon('braces', 14),
    `Unresolved: ${slot.unresolved.map((n) => `{{${n}}}`).join(', ')}`,
    el('button', { class: LINK_BTN, type: 'button', onclick: () => app.navigate({ view: 'variables', environmentId: store.data?.activeEnvironmentId ?? undefined }) }, ['Manage variables']),
  ]);
}

export function renderResponsePane(): void {
  if (!draft || !section) return;
  const root = section.response;
  const slot = store.responses.get(draft.key);
  root.replaceChildren();
  if (!slot) {
    root.append(el('div', { class: PLACEHOLDER }, [icon('send', 22), el('p', {}, ['Press Send or Ctrl/Cmd+Enter to execute the request.'])]));
    return;
  }
  if (slot.sending) {
    root.append(el('div', { class: PLACEHOLDER }, [el('span', { class: SPINNER }), el('p', {}, ['Sending request…'])]));
    return;
  }
  if (slot.error) {
    root.append(el('div', { class: 'whitespace-pre-wrap rounded bg-red/10 px-3 py-2.5 text-error', role: 'alert' }, [slot.error]));
    const warn = unresolvedWarning(slot);
    if (warn) root.append(warn);
    return;
  }
  const res = slot.response as ResponseData;
  const views: ['pretty' | 'raw' | 'headers', string][] = [
    ['pretty', 'Pretty'],
    ['raw', 'Raw'],
    ['headers', `Headers (${res.headers.length})`],
  ];
  root.append(
    el('div', { class: 'mb-1.5 flex flex-wrap items-center gap-3' }, [
      el('span', { class: cx('rounded-[10px] px-2.5 py-0.5 font-mono font-bold', statusClass(res.status)) }, [`${res.status} ${res.statusText}`]),
      el('span', { class: META, title: `Time to first byte: ${res.timings.ttfbMs} ms` }, [`${res.timings.totalMs} ms`]),
      el('span', { class: META }, [formatBytes(res.sizeBytes) + (res.truncated ? ' (truncated)' : '')]),
      res.redirects ? el('span', { class: META, title: res.url }, [`${res.redirects} redirect(s)`]) : null,
      el('span', { class: 'flex-1' }),
      el('div', { class: TABS_COMPACT }, views.map(([id, label]) =>
        el('button', {
          class: tab(store.responseView === id),
          type: 'button',
          onclick: () => {
            store.responseView = id;
            renderResponsePane();
          },
        }, [label]),
      )),
      iconButton('save', 'Save response body to file', () => post({ type: 'saveResponse', requestId: draft?.key ?? '' })),
    ]),
  );
  const warn = unresolvedWarning(slot);
  if (warn) root.append(warn);

  // min-h-0 lets the flex child shrink below its content so large bodies scroll inside it.
  const view = el('pre', {
    class: 'm-0 min-h-0 flex-auto overflow-auto whitespace-pre-wrap break-words rounded bg-code px-3 py-2.5 font-mono text-editor-size leading-normal [&_img]:max-w-full',
    tabindex: '0',
  });
  root.append(view);
  if (store.responseView === 'headers') {
    view.replaceChildren(el('table', { class: 'border-collapse [&_td]:py-[3px] [&_td]:pr-4 [&_td]:align-top [&_td:first-child]:whitespace-nowrap [&_td:first-child]:font-semibold [&_td:first-child]:text-blue' }, res.headers.map(([k, v]) => el('tr', {}, [el('td', {}, [k]), el('td', {}, [v])]))));
    return;
  }
  if (res.bodyEncoding === 'base64') {
    if (/^image\/(png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon)/i.test(res.contentType)) {
      view.append(el('img', { src: `data:${res.contentType.split(';')[0]};base64,${res.body}`, alt: 'Image response' }));
    } else {
      view.append(`Binary response (${res.contentType || 'unknown type'}, ${formatBytes(res.sizeBytes)}). Use Save to write it to a file.`);
    }
    return;
  }
  if (store.responseView === 'pretty' && /json/i.test(res.contentType)) {
    try {
      const pretty = JSON.stringify(JSON.parse(res.body), null, 2);
      view.append(...(pretty.length < 1_000_000 ? highlightJson(pretty) : [pretty]));
      return;
    } catch {
      // fall through to raw
    }
  }
  view.append(res.body || '(empty body)');
}

export function onRequestSendShortcut(): void {
  if (store.route.view === 'request') sendRequest();
}
