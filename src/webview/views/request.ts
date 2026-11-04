import { HTTP_METHODS, type BodyType, type HttpMethod, type KeyValue, type RequestItem, type ResponseData } from '../../shared/model';
import { authEditor, button, emptyState, kvTable } from '../components';
import { el, highlightJson, icon, iconButton } from '../dom';
import { app, Draft, findRequest, post, store, variableScope, type ResponseSlot } from '../store';

let draft: Draft<RequestItem> | undefined;
let section: { request: HTMLElement; response: HTMLElement } | undefined;

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
  const requestEl = el('section', { class: 'request-pane' });
  const responseEl = el('section', { class: 'response-pane', 'aria-live': 'polite' });
  section = { request: requestEl, response: responseEl };
  container.replaceChildren(requestEl, el('div', { class: 'splitter' }), responseEl);
  renderRequestPane();
  renderResponsePane();
}

function changed(): void {
  draft?.touch();
}

function renderRequestPane(): void {
  if (!draft || !section) return;
  const r = draft.value;
  const loc = findRequest(r.id);
  const root = section.request;
  root.replaceChildren();
  if (!loc) return;

  // Header: breadcrumb + inline name + actions
  root.append(
    el('div', { class: 'view-header' }, [
      el('div', { class: 'crumbs' }, [
        el('button', { class: 'crumb', type: 'button', onclick: () => app.navigate({ view: 'collection', collectionId: loc.collection.id }) }, [
          icon('collection', 13),
          loc.collection.name,
        ]),
        ...loc.path.flatMap((f) => [el('span', { class: 'sep' }, ['›']), el('span', { class: 'crumb static' }, [icon('folder', 13), f.name])]),
        el('span', { class: 'sep' }, ['›']),
      ]),
      el('input', {
        class: 'title-input',
        type: 'text',
        value: r.name,
        'aria-label': 'Request name',
        oninput: (e: Event) => {
          r.name = (e.target as HTMLInputElement).value;
          changed();
        },
        onchange: () => app.renderSidebar(),
      }),
      el('div', { class: 'header-actions' }, [
        iconButton('copy', 'Duplicate request', () => post({ type: 'itemAction', action: 'duplicate', collectionId: loc.collection.id, itemId: r.id })),
        iconButton('trash', 'Delete request', () => post({ type: 'itemAction', action: 'delete', collectionId: loc.collection.id, itemId: r.id })),
      ]),
    ]),
  );

  const sending = store.responses.get(r.id)?.sending;
  root.append(
    el('div', { class: 'urlbar' }, [
      el('select', {
        class: `method-select method-${r.method}`,
        'aria-label': 'HTTP method',
        onchange: (e: Event) => {
          r.method = (e.target as HTMLSelectElement).value as HttpMethod;
          (e.target as HTMLSelectElement).className = `method-select method-${r.method}`;
          changed();
          app.renderSidebar();
        },
      }, HTTP_METHODS.map((m) => el('option', { value: m, selected: m === r.method }, [m]))),
      el('input', {
        class: 'url-input',
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
      iconButton('terminal', 'Copy as cURL', () => post({ type: 'copyAsCurl', request: structuredClone(r) }), 'icon-btn bordered'),
    ]),
    el('div', { class: 'var-chips' }),
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
    el('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label, badge]) =>
      el('button', {
        class: `tab${store.requestTab === id ? ' active' : ''}`,
        role: 'tab',
        type: 'button',
        'aria-selected': String(store.requestTab === id),
        onclick: () => {
          store.requestTab = id;
          renderRequestPane();
        },
      }, [label, badge ? el('span', { class: 'tab-badge' }, [badge]) : null]),
    )),
  );

  const panel = el('div', { class: 'tab-panel', role: 'tabpanel' });
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
  const holder = section.request.querySelector('.var-chips');
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
    el('span', { class: 'muted' }, ['Variables:']),
    ...names.map((name) => {
      if (name.startsWith('$')) {
        const isDotenv = name.startsWith('$dotenv');
        const ok = !isDotenv || store.data?.dotenvKeys.includes(name.split(/\s+/)[1] ?? '');
        return el('span', { class: `chip ${ok ? 'dynamic' : 'missing'}`, title: isDotenv ? 'Value from the workspace .env file' : 'Dynamic value generated on send' }, [icon('bolt', 12), name]);
      }
      const v = scope.get(name);
      return el('button', {
        class: `chip ${v ? 'ok' : 'missing'}`,
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
  const wrap = el('div', { class: 'body-editor' });
  wrap.append(
    el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Body type' }, BODY_TYPES.map(([type, label]) =>
      el('button', {
        class: b.type === type ? 'active' : '',
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
        class: 'code',
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
      wrap.append(kvTable((b.multipart ??= []), { noun: 'Part', changed, rerender, multipart: true }));
      break;
    case 'binary':
      wrap.append(
        el('div', { class: 'form-grid' }, [
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
      wrap.append(el('p', { class: 'hint' }, ['This request has no body.']));
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
  if (status < 300) return 'ok';
  if (status < 400) return 'redirect';
  if (status < 500) return 'client';
  return 'server';
}

function unresolvedWarning(slot: ResponseSlot): HTMLElement | null {
  if (!slot.unresolved.length) return null;
  return el('div', { class: 'warning' }, [
    icon('braces', 14),
    `Unresolved: ${slot.unresolved.map((n) => `{{${n}}}`).join(', ')}`,
    el('button', { class: 'link-btn', type: 'button', onclick: () => app.navigate({ view: 'variables', environmentId: store.data?.activeEnvironmentId ?? undefined }) }, ['Manage variables']),
  ]);
}

export function renderResponsePane(): void {
  if (!draft || !section) return;
  const root = section.response;
  const slot = store.responses.get(draft.key);
  root.replaceChildren();
  if (!slot) {
    root.append(el('div', { class: 'placeholder' }, [icon('send', 22), el('p', {}, ['Press Send or Ctrl/Cmd+Enter to execute the request.'])]));
    return;
  }
  if (slot.sending) {
    root.append(el('div', { class: 'placeholder' }, [el('span', { class: 'spinner' }), el('p', {}, ['Sending request…'])]));
    return;
  }
  if (slot.error) {
    root.append(el('div', { class: 'error', role: 'alert' }, [slot.error]));
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
    el('div', { class: 'response-head' }, [
      el('span', { class: `pill ${statusClass(res.status)}` }, [`${res.status} ${res.statusText}`]),
      el('span', { class: 'meta', title: `Time to first byte: ${res.timings.ttfbMs} ms` }, [`${res.timings.totalMs} ms`]),
      el('span', { class: 'meta' }, [formatBytes(res.sizeBytes) + (res.truncated ? ' (truncated)' : '')]),
      res.redirects ? el('span', { class: 'meta', title: res.url }, [`${res.redirects} redirect(s)`]) : null,
      el('span', { class: 'spacer' }),
      el('div', { class: 'tabs compact' }, views.map(([id, label]) =>
        el('button', {
          class: `tab${store.responseView === id ? ' active' : ''}`,
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

  const view = el('pre', { class: 'body-view', tabindex: '0' });
  root.append(view);
  if (store.responseView === 'headers') {
    view.replaceChildren(el('table', { class: 'headers' }, res.headers.map(([k, v]) => el('tr', {}, [el('td', {}, [k]), el('td', {}, [v])]))));
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
