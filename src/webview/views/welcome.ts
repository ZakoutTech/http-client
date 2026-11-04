import { button, methodBadge } from '../components';
import { el, icon } from '../dom';
import { app, countRequests, plural, post, store } from '../store';
import { CARD_SURFACE, cx, PAGE } from '../ui';

export function renderWelcomeView(container: HTMLElement): void {
  const data = store.data;
  const collections = data?.collections ?? [];
  container.replaceChildren(
    el('section', { class: cx(PAGE, 'mx-auto max-w-[920px]') }, [
      el('div', { class: 'pt-[30px] pb-[22px] text-center' }, [
        el('div', { class: 'inline-flex rounded-[18px] bg-linear-135 from-[#22d3ee] to-[#3b82f6] p-3.5 text-white' }, [icon('send', 30)]),
        el('h1', { class: 'mt-2.5 mb-1.5 text-[1.8em] font-bold' }, ['HTTP Client']),
        el('p', { class: 'text-muted' }, ['Collections, environments and OpenAPI import — stored as plain JSON in your workspace.']),
        el('div', { class: 'mt-4 flex flex-wrap justify-center gap-2' }, [
          button('New collection', () => post({ type: 'action', action: 'newCollection' }), { icon: 'plus' }),
          button('Import OpenAPI / Swagger', () => post({ type: 'action', action: 'importOpenApi' }), { icon: 'download', secondary: true }),
          button('Manage variables', () => app.navigate({ view: 'variables', environmentId: data?.activeEnvironmentId ?? undefined }), { icon: 'braces', secondary: true }),
        ]),
      ]),
      collections.length
        ? el('div', { class: 'mt-2.5 mb-5 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3' }, collections.map((c) => {
            const first = c.items.flatMap((i) => (i.type === 'request' ? [i] : i.items.filter((x) => x.type === 'request'))).slice(0, 3);
            return el('button', { class: cx(CARD_SURFACE, 'flex flex-col gap-1.5 px-3.5 py-3 text-left hover:border-accent'), type: 'button', onclick: () => app.navigate({ view: 'collection', collectionId: c.id }) }, [
              el('div', { class: 'flex items-center gap-2 font-semibold' }, [icon('collection', 16), c.name]),
              el('div', { class: 'text-[0.88em] text-muted' }, [`${plural(countRequests(c.items), 'request')} · ${plural(c.variables.length, 'variable')}`]),
              el('div', { class: 'flex flex-col gap-[3px] text-[0.92em]' }, first.map((r) => el('div', { class: 'flex items-center gap-2' }, [r.type === 'request' ? methodBadge(r.method) : null, r.name]))),
            ]);
          }))
        : null,
      el('div', { class: 'grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3' }, [
        tip('send', 'Send', 'Ctrl/Cmd+Enter sends the open request.'),
        tip('braces', 'Variables', 'Use {{name}} anywhere: URL, headers, body and auth.'),
        tip('lock', 'Secrets', 'Secret values live in VS Code SecretStorage, never in git.'),
        tip('bolt', 'Dynamic', '{{$uuid}}, {{$timestamp}}, {{$randomInt 1 100}}, {{$dotenv KEY}}'),
      ]),
    ]),
  );
}

function tip(iconName: Parameters<typeof icon>[0], title: string, text: string): HTMLElement {
  return el('div', { class: 'flex items-start gap-2.5 rounded-md p-2.5 [&>svg]:mt-0.5 [&>svg]:text-accent' }, [
    icon(iconName, 16),
    el('div', {}, [el('strong', {}, [title]), el('p', { class: 'mt-[3px] text-[0.88em] text-muted' }, [text])]),
  ]);
}
