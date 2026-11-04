import { button, methodBadge } from '../components';
import { el, icon } from '../dom';
import { app, countRequests, plural, post, store } from '../store';

export function renderWelcomeView(container: HTMLElement): void {
  const data = store.data;
  const collections = data?.collections ?? [];
  container.replaceChildren(
    el('section', { class: 'page welcome' }, [
      el('div', { class: 'hero' }, [
        el('div', { class: 'hero-icon' }, [icon('send', 30)]),
        el('h1', {}, ['HTTP Client']),
        el('p', { class: 'muted' }, ['Collections, environments and OpenAPI import — stored as plain JSON in your workspace.']),
        el('div', { class: 'hero-actions' }, [
          button('New collection', () => post({ type: 'action', action: 'newCollection' }), { icon: 'plus' }),
          button('Import OpenAPI / Swagger', () => post({ type: 'action', action: 'importOpenApi' }), { icon: 'download', secondary: true }),
          button('Manage variables', () => app.navigate({ view: 'variables', environmentId: data?.activeEnvironmentId ?? undefined }), { icon: 'braces', secondary: true }),
        ]),
      ]),
      collections.length
        ? el('div', { class: 'cards' }, collections.map((c) => {
            const first = c.items.flatMap((i) => (i.type === 'request' ? [i] : i.items.filter((x) => x.type === 'request'))).slice(0, 3);
            return el('button', { class: 'card collection-card', type: 'button', onclick: () => app.navigate({ view: 'collection', collectionId: c.id }) }, [
              el('div', { class: 'card-title' }, [icon('collection', 16), c.name]),
              el('div', { class: 'muted small' }, [`${plural(countRequests(c.items), 'request')} · ${plural(c.variables.length, 'variable')}`]),
              el('div', { class: 'card-requests' }, first.map((r) => el('div', {}, [r.type === 'request' ? methodBadge(r.method) : null, r.name]))),
            ]);
          }))
        : null,
      el('div', { class: 'tips' }, [
        tip('send', 'Send', 'Ctrl/Cmd+Enter sends the open request.'),
        tip('braces', 'Variables', 'Use {{name}} anywhere: URL, headers, body and auth.'),
        tip('lock', 'Secrets', 'Secret values live in VS Code SecretStorage, never in git.'),
        tip('bolt', 'Dynamic', '{{$uuid}}, {{$timestamp}}, {{$randomInt 1 100}}, {{$dotenv KEY}}'),
      ]),
    ]),
  );
}

function tip(iconName: Parameters<typeof icon>[0], title: string, text: string): HTMLElement {
  return el('div', { class: 'tip' }, [icon(iconName, 16), el('div', {}, [el('strong', {}, [title]), el('p', { class: 'muted small' }, [text])])]);
}
