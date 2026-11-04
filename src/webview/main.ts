import './style.css';
import type { HostToWebview, NavTarget } from '../shared/messages';
import { el, icon } from './dom';
import { renderSidebar } from './sidebar';
import { app, findCollection, findRequest, persist, post, store } from './store';
import { cx, PLACEHOLDER, SPINNER } from './ui';
import { flushCollectionDraft, renderCollectionView, syncCollectionView } from './views/collection';
import { flushRequestDraft, onRequestSendShortcut, renderRequestView, renderResponsePane, syncRequestView } from './views/request';
import { flushVariablesDraft, renderVariablesView, syncVariablesView } from './views/variables';
import { renderWelcomeView } from './views/welcome';

const MAIN = 'flex min-w-0 flex-auto flex-col overflow-hidden';

const root = document.getElementById('app') as HTMLElement;
root.className = 'flex h-screen flex-col';
const header = el('header', { class: 'flex flex-none items-center gap-2.5 border-b border-line bg-sidebar px-3 py-1.5' });
const sidebar = el('aside', { class: 'flex min-h-0 w-[270px] flex-none flex-col border-r border-line bg-sidebar', 'aria-label': 'Collections' });
const main = el('main', { class: MAIN });
root.append(header, el('div', { class: 'flex min-h-0 flex-auto' }, [sidebar, main]));

function renderHeader(): void {
  const data = store.data;
  const envSelect = el('select', {
    class: 'min-w-40',
    'aria-label': 'Active environment',
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      post({ type: 'setActiveEnvironment', environmentId: v || null });
    },
  }, [
    el('option', { value: '', selected: !data?.activeEnvironmentId }, ['No environment']),
    ...(data?.environments ?? []).map((e) => el('option', { value: e.id, selected: e.id === data?.activeEnvironmentId }, [e.name])),
  ]);
  const variablesActive = store.route.view === 'variables';
  header.replaceChildren(
    el('button', { class: 'inline-flex items-center gap-2 px-1 py-0.5 font-semibold [&>svg]:text-accent', type: 'button', onclick: () => app.navigate({ view: 'welcome' }) }, [icon('send', 16), 'HTTP Client']),
    el('span', { class: 'flex-1' }),
    el('label', { class: 'inline-flex items-center gap-1.5 text-muted' }, [icon('layers', 14), envSelect]),
    el('button', {
      class: cx('inline-flex items-center gap-1.5 rounded border px-2.5 py-[5px] hover:bg-hover', variablesActive ? 'border-accent bg-hover' : 'border-control'),
      type: 'button',
      onclick: () => app.navigate({ view: 'variables', environmentId: data?.activeEnvironmentId ?? undefined }),
    }, [icon('braces', 14), 'Variables']),
  );
}

function renderMain(): void {
  const r = store.route;
  if (!store.data) {
    main.replaceChildren(el('div', { class: PLACEHOLDER }, [el('span', { class: SPINNER }), el('p', {}, ['Loading…'])]));
    return;
  }
  main.className = MAIN;
  main.dataset.view = r.view;
  switch (r.view) {
    case 'request':
      renderRequestView(main, r.requestId);
      break;
    case 'collection':
      renderCollectionView(main, r.collectionId, r.tab ?? 'overview');
      break;
    case 'variables':
      renderVariablesView(main, r.environmentId);
      break;
    default:
      renderWelcomeView(main);
  }
}

function navigate(target: NavTarget): void {
  flushRequestDraft();
  flushCollectionDraft();
  flushVariablesDraft();
  store.route = target;
  // Reveal the target in the sidebar.
  if (target.view === 'request') {
    const loc = findRequest(target.requestId);
    if (loc) [loc.collection.id, ...loc.path.map((f) => f.id)].forEach((id) => store.expanded.add(id));
  }
  if (target.view === 'collection' && findCollection(target.collectionId)) store.expanded.add(target.collectionId);
  persist();
  renderHeader();
  renderSidebar(sidebar);
  renderMain();
}

app.navigate = navigate;
app.renderMain = renderMain;
app.renderSidebar = () => renderSidebar(sidebar);

/** On new server state, re-render the main view only if the current entity changed underneath us. */
function onState(): void {
  const r = store.route;
  let rerender = true;
  if (r.view === 'request') rerender = syncRequestView(r.requestId);
  else if (r.view === 'collection') rerender = syncCollectionView(r.collectionId) && !main.contains(document.activeElement);
  else if (r.view === 'variables') rerender = syncVariablesView(r.environmentId) || !main.contains(document.activeElement);
  renderHeader();
  renderSidebar(sidebar);
  if (rerender) renderMain();
}

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state': {
      const first = !store.data;
      store.data = msg.state;
      if (first) {
        navigate(store.route);
      } else {
        onState();
      }
      break;
    }
    case 'navigate':
      navigate(msg.target);
      break;
    case 'sending':
      store.responses.set(msg.requestId, { sending: true, unresolved: [] });
      refreshResponse(msg.requestId);
      break;
    case 'response':
      store.responses.set(msg.requestId, { sending: false, response: msg.response, unresolved: msg.unresolved });
      refreshResponse(msg.requestId);
      break;
    case 'error':
      if (msg.requestId) {
        store.responses.set(msg.requestId, { sending: false, error: msg.message, unresolved: msg.unresolved ?? [] });
        refreshResponse(msg.requestId);
      } else {
        showToast(msg.message);
      }
      break;
  }
});

function refreshResponse(requestId: string): void {
  renderSidebar(sidebar);
  if (store.route.view === 'request' && store.route.requestId === requestId) {
    // Re-render the request pane too (Send ⇄ Cancel button), then the response.
    renderMain();
    renderResponsePane();
  }
}

function showToast(message: string): void {
  const toast = el('div', { class: 'fixed right-4 bottom-4 max-w-[420px] rounded-md border border-line bg-notification px-3.5 py-2.5 text-error shadow-[0_6px_20px_rgba(0,0,0,0.35)]', role: 'alert' }, [message]);
  document.body.append(toast);
  setTimeout(() => toast.remove(), 5000);
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    onRequestSendShortcut();
  }
});

renderHeader();
renderMain();
post({ type: 'ready' });
