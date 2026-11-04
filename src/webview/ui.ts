/**
 * Shared Tailwind class strings. Keep every class a complete literal so Tailwind's scanner finds it
 * (never build class names like `text-${color}`).
 */

/** Joins truthy class strings. */
export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

export const BTN = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-[5px]';
export const BTN_PRIMARY = 'bg-btn text-btn-fg hover:bg-btn-hover';
export const BTN_SECONDARY = 'bg-btn2 text-btn2-fg hover:bg-btn2-hover';

export const ICON_BTN = 'inline-flex size-[26px] items-center justify-center rounded border border-transparent text-fg opacity-80 hover:bg-toolbar-hover hover:opacity-100';
export const ICON_BTN_BORDERED = 'inline-flex w-8 items-center justify-center rounded border border-control text-fg opacity-80 hover:bg-toolbar-hover hover:opacity-100';
export const ICON_BTN_SMALL = 'inline-flex size-[22px] items-center justify-center rounded border border-transparent opacity-80 hover:bg-toolbar-hover hover:opacity-100';

export const LINK_BTN = 'inline-flex items-center gap-1 px-0.5 py-1 text-link hover:underline';

export const SECTION_TITLE = 'flex-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted';
export const HINT = 'my-2 text-[0.92em] leading-[1.45] text-muted';
export const HINT_TOP = 'mb-2 text-[0.92em] leading-[1.45] text-muted';
export const BADGE = 'rounded-lg bg-badge px-1.5 text-[10px] text-badge-fg';
export const PAGE = 'h-full overflow-auto px-5 pt-3.5 pb-[30px]';

export const VIEW_HEADER = 'mb-2.5 flex min-h-8 items-center gap-2';
export const HEADER_ICON = 'inline-flex text-accent';
export const HEADER_ACTIONS = 'ml-auto inline-flex items-center gap-1';
export const TITLE = 'm-0 text-[1.25em] font-semibold';
export const TITLE_INPUT = 'm-0 max-w-[520px] flex-auto border-transparent bg-transparent px-1.5 py-[3px] text-[1.25em] font-semibold hover:border-control';

export const TABS = 'mt-3 mb-2.5 flex gap-0.5 border-b border-line';
export const TABS_COMPACT = 'flex gap-0.5';
export const tab = (active: boolean): string =>
  cx('inline-flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 hover:opacity-100', active ? 'border-tab-active opacity-100' : 'border-transparent opacity-75');

export const SECTION_HEADING = 'mt-[18px] mb-2 flex items-center gap-1.5 text-[1em] font-bold';
export const FIELD_LABEL = 'mt-1 mb-1.5 block font-semibold';

/** Editable key/value tables (params, headers, variables). */
export const KV_TABLE =
  'w-full border-collapse [&_td]:py-0.5 [&_td]:pr-1.5 [&_th]:pr-1.5 [&_th]:pb-1 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.04em] [&_th]:text-muted [&_input:is([type=text],[type=password])]:w-full [&_input:is([type=text],[type=password])]:font-mono';
export const KV_ROW_DISABLED = '[&_input:is([type=text],[type=password])]:opacity-50';
export const KV_WRAP = 'flex flex-col items-start gap-1.5';

/** Read-only clickable lists (collection requests, effective variables). */
export const LIST_TABLE = 'w-full border-collapse [&_td]:px-2 [&_td]:align-middle [&_tr]:border-b [&_tr]:border-line';

export const FORM_GRID =
  'grid w-full max-w-[720px] grid-cols-[150px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 [&_input]:w-full [&_input]:font-mono [&_select]:w-full [&_select]:font-mono';

export const CARD_SURFACE = 'rounded-md border border-line bg-fg/[2%]';

export const SPINNER = 'inline-block size-4 animate-[spin_0.8s_linear_infinite] rounded-full border-2 border-fg border-r-transparent';
export const SPINNER_SMALL = 'inline-block size-2.5 animate-[spin_0.8s_linear_infinite] rounded-full border-[1.5px] border-fg border-r-transparent';

export const PLACEHOLDER = 'm-auto flex flex-col items-center gap-1.5 text-center text-muted';

export const CHIP = 'inline-flex items-center gap-1 rounded-[10px] border bg-fg/8 px-2 py-px font-mono text-[11.5px]';
export const CHIP_OK = 'border-green/45 text-green';
export const CHIP_MISSING = 'border-red/55 text-red';
export const CHIP_DYNAMIC = 'border-purple/45 text-purple';

export const METHOD_COLOR: Record<string, string> = {
  GET: 'text-green',
  POST: 'text-yellow',
  PUT: 'text-blue',
  PATCH: 'text-purple',
  DELETE: 'text-red',
  HEAD: 'text-muted',
  OPTIONS: 'text-muted',
};
export const methodColor = (method: string): string => METHOD_COLOR[method] ?? 'text-muted';
