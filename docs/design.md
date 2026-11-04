# Design — VS Code GUI HTTP Client

Implements step 1 of `docs/plan/http-client-extension.md`.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | VS Code standard |
| Bundler | tsdown (`tsdown.config.mts`) — two bundles: `dist/extension.js` (node/cjs) and `dist/webview.js` + `webview.css` (browser/iife) | Same setup as the SSH config extension. All libraries are devDependencies so they are bundled (packaged with `vsce --no-dependencies`) |
| Webview UI | Vanilla TS + a tiny `h()` DOM helper, styled with `--vscode-*` theme variables | No framework runtime in the webview; small, CSP-friendly |
| HTTP engine | `undici` (v7) in the **extension host only** | Webviews are subject to CORS and cannot hold secrets; undici gives proxy, TLS and redirect control |
| OpenAPI | `@apidevtools/swagger-parser` (dereference) + `yaml` | Handles Swagger 2.0 and OpenAPI 3.0/3.1 `$ref` resolution |
| Tests | `vitest` for all `src/core/**` modules (no `vscode` import there) | Fast; core logic is testable without an Electron host |

## Module boundaries

```
src/shared/   types + message protocol (imported by host and webview)
src/core/     pure logic, NO `vscode` import — unit tested
  variables.ts        {{var}} resolution, scopes, dynamic vars, $dotenv
  dotenv.ts           .env parser
  requestBuilder.ts   RequestItem + resolver + inherited auth → ResolvedRequest
  httpEngine.ts       undici execution, timing, cancellation, redirects, proxy, TLS
  oauth2.ts           client-credentials token fetch + cache
  collectionStore.ts  read/write collection files
  environmentStore.ts read/write environment files
  openapi/            importer + schema example generator
src/vscode/   thin adapters: tree views, webview panel, secrets, commands
src/webview/  request editor + response viewer UI
```

## On-disk format (git-friendly)

```
<workspace>/.httpclient/
  collections/<slug>.json     one file per collection (folders + requests tree)
  environments/<slug>.json    one file per environment
  globals.json                global variables
```

One file per collection (rather than per request) keeps renames, moves and drag-and-drop atomic,
while pretty-printed, stable-ordered JSON keeps diffs readable.

Variables marked `"secret": true` are written to disk with an **empty value**; the real value lives
in VS Code `SecretStorage` keyed `httpClient:<envId>:<key>`.

## Variable resolution

Precedence (highest first): dynamic (`{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`,
`{{$randomInt min max}}`, `{{$dotenv NAME}}`) → active environment → collection → globals.
Values can reference other variables; recursion depth is capped at 10. Unresolved variables are
left as-is and reported to the UI.

## Host ⇄ webview protocol

Defined in `src/shared/messages.ts`. Webview → host: `ready`, `update`, `send`, `cancel`,
`saveResponse`, `copyAsCurl`. Host → webview: `load`, `sending`, `response`, `error`. Every inbound
message is validated by a type guard before use; the webview never receives secret values except
inside the response it requested.

## Security

- Webview CSP: `default-src 'none'`; scripts only by nonce; styles only from the extension.
- TLS verification on by default (`httpClient.strictSSL`).
- OpenAPI imported from a URL may not resolve `file:` `$ref`s (prevents local file disclosure).
- Secrets never written to collection/environment files or to logs.
