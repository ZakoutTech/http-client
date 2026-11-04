# Plan: VS Code GUI HTTP Client Extension

Goal: a VS Code extension for building and executing HTTP requests through a GUI (webview),
with user collections, environment variables, and OpenAPI/Swagger import. Think
"JetBrains HTTP Client / REST Client, but with a form-based GUI like Postman/Thunder Client".

Prior art (checked 2026-11-02):
- Thunder Client: closed source, freemium; OpenAPI import and Git sync are paid tiers.
- REST Client (huachao/vscode-restclient): MIT, free, but text-file (.http) based, no GUI.
- Bruno VS Code extension (usebruno/bruno-ide-extensions): MIT, free, GUI, git-friendly .bru files.
- Telegraph REST API Client (riturajshakti/telegraph-rest-api-client): free/open source, GUI, collections, environments, OpenAPI import.
- REST-API-Client/API-Client-VSCode-Extension: MIT, GUI, history/favorites; no OpenAPI import seen.

Differentiator to aim for: fully free, git-friendly plain-JSON collections stored in the workspace,
first-class OpenAPI 2.0/3.x import, and interop with `.http` files.

## Step 1. Design the architecture
Choose webview UI stack (e.g. React or Svelte + @vscode-elements), on-disk collection format
(one JSON/YAML file per request under `.httpclient/` in the workspace), HTTP engine (undici in the
extension host, never in the webview), and the extension-host <-> webview message protocol.
Output: approved design doc with module boundaries.

## Step 2. Create the extension scaffold
Create a TypeScript VS Code extension with esbuild bundling, a webview panel host with strict CSP,
a typed message bridge, lint, and a unit test harness (vitest) plus @vscode/test-electron.

## Step 3. Implement collections and the sidebar tree
Add a Collections tree view (collections > folders > requests) with create, rename, duplicate,
delete, and drag-and-drop; persist to workspace files so collections are committable to git.

## Step 4. Implement environments and variables
Add environments (global, collection, environment scope) and `{{var}}` substitution in URL,
headers, query, body and auth; support dynamic vars ({{$uuid}}, {{$timestamp}}) and `.env` files.
Secret values must be stored in VS Code SecretStorage, never in workspace files.

## Step 5. Implement the HTTP execution engine
Execute requests in the extension host with undici: all methods, query/headers/body
(JSON, form-urlencoded, multipart, raw, binary), auth (Basic, Bearer, API key, OAuth2 client
credentials), timeouts, cancellation, redirects, proxy and TLS settings; return status, headers,
body, timing and size.

## Step 6. Implement the request editor and response viewer GUI
Webview with method/URL bar, tabs for Params, Headers, Body, Auth, and a response pane with
pretty/raw views, syntax highlighting, headers, timing, and save-response-to-file.

## Step 7. Implement OpenAPI / Swagger import
Import Swagger 2.0 and OpenAPI 3.0/3.1 from file or URL (JSON or YAML), resolve $refs, map tags
to folders, operations to requests, servers to a `baseUrl` variable, generate example bodies from
schemas, and map securitySchemes to auth config.

## Step 8. Add tests for the engine, variables and importer
Unit tests for variable resolution, the importer (fixtures: Petstore 2.0 and 3.1), and the HTTP
engine against a local mock server; target 80% coverage.

## Step 9. Security audit of request execution and secret handling
Audit webview CSP, message-bridge input validation, secret storage, and that no secrets are
written to collection files or logs.

## Step 10. Write README and marketplace docs
README with features, screenshots, collection file format, and comparison to alternatives.
