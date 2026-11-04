/**
 * Browser stand-in for the extension host, used by `npm run preview`.
 * Holds demo collections/environments in memory and answers the webview with the same
 * messages as the real host. HTTP responses are simulated. Must be imported before the
 * webview entry point (it defines acquireVsCodeApi).
 *
 * Deep links for screenshots: #request=<id>[&send=1][&tab=params|headers|body|auth],#collection=<id>[&tab=variables|auth], #variables=<envId>, #welcome
 */
import {
  duplicateItem,
  findItem,
  insertItem,
  moveItem,
  removeItem,
} from "../src/core/collectionOps";
import {
  applyEnvironmentUpdate,
  toEnvironmentView,
} from "../src/core/environmentView";
import type {
  CollectionTab,
  HostToWebview,
  NavTarget,
  WebviewToHost,
  WorkbenchState,
} from "../src/shared/messages";
import {
  newRequest,
  type Collection,
  type Environment,
  type RequestItem,
  type ResponseData,
} from "../src/shared/model";

const kv = (key: string, value: string, enabled = true) => ({
  key,
  value,
  enabled,
});
const secret = (key: string, value: string) => ({
  key,
  value,
  enabled: true,
  secret: true,
});
const req = (
  id: string,
  name: string,
  method: RequestItem["method"],
  url: string,
  extra: Partial<RequestItem> = {},
): RequestItem => ({
  ...newRequest(id, name),
  method,
  url,
  ...extra,
});

const collections: Collection[] = [
  {
    version: 1,
    id: "petstore",
    name: "Petstore API",
    description:
      "Imported from https://petstore.example.com/api/v3/openapi.json — the classic OpenAPI 3 sample.",
    variables: [
      kv("baseUrl", "https://petstore.example.com/api/v3"),
      kv("petId", "42"),
    ],
    auth: { type: "bearer", token: "{{token}}" },
    items: [
      {
        type: "folder",
        id: "f-pets",
        name: "pets",
        items: [
          req("list-pets", "List pets", "GET", "{{baseUrl}}/pets", {
            params: [
              kv("limit", "20"),
              kv("status", "available"),
              kv("tags", "dog", false),
            ],
            headers: [
              kv("Accept", "application/json"),
              kv("X-Request-Id", "{{$uuid}}"),
              kv("User-Agent", "{{userAgent}}"),
            ],
          }),
          req("create-pet", "Create pet", "POST", "{{baseUrl}}/pets", {
            headers: [kv("Content-Type", "application/json")],
            body: {
              type: "json",
              raw: '{\n  "name": "doggie",\n  "status": "available",\n  "tags": ["{{tag}}"]\n}',
            },
          }),
          req("get-pet", "Get pet by id", "GET", "{{baseUrl}}/pets/{{petId}}"),
          req("update-pet", "Update pet", "PUT", "{{baseUrl}}/pets/{{petId}}", {
            body: { type: "json", raw: '{\n  "name": "doggie 2"\n}' },
          }),
          req(
            "delete-pet",
            "Delete pet",
            "DELETE",
            "{{baseUrl}}/pets/{{petId}}",
          ),
        ],
      },
      {
        type: "folder",
        id: "f-store",
        name: "store",
        items: [
          req("inventory", "Inventory", "GET", "{{baseUrl}}/store/inventory", {
            auth: {
              type: "apikey",
              key: "api_key",
              value: "{{apiKey}}",
              in: "header",
            },
          }),
          req("place-order", "Place order", "POST", "{{baseUrl}}/store/order", {
            body: {
              type: "json",
              raw: '{\n  "petId": {{petId}},\n  "quantity": 1\n}',
            },
          }),
        ],
      },
      req("health", "Health check", "GET", "{{baseUrl}}/health", {
        auth: { type: "none" },
      }),
    ],
  },
  {
    version: 1,
    id: "github",
    name: "GitHub API",
    variables: [kv("baseUrl", "https://api.github.com")],
    auth: { type: "bearer", token: "{{githubToken}}" },
    items: [
      req("gh-user", "Current user", "GET", "{{baseUrl}}/user"),
      req(
        "gh-repos",
        "List repositories",
        "GET",
        "{{baseUrl}}/users/{{owner}}/repos",
        { params: [kv("per_page", "50")] },
      ),
      req(
        "gh-issue",
        "Create issue",
        "POST",
        "{{baseUrl}}/repos/{{owner}}/{{repo}}/issues",
        { body: { type: "json", raw: '{\n  "title": "Found a bug"\n}' } },
      ),
    ],
  },
];

let globals: Environment = {
  version: 1,
  id: "globals",
  name: "Globals",
  variables: [kv("userAgent", "gui-http-client/0.1"), kv("tag", "friendly")],
};

let environments: Environment[] = [
  {
    version: 1,
    id: "dev",
    name: "Development",
    variables: [
      kv("baseUrl", "http://localhost:8080/api/v3"),
      secret("token", "dev-token-123"),
      secret("apiKey", "dev-api-key"),
      secret("githubToken", ""),
      kv("owner", "octocat"),
    ],
  },
  {
    version: 1,
    id: "prod",
    name: "Production",
    variables: [secret("token", "prod-token"), kv("owner", "m0d1xd")],
  },
];
let activeEnvironmentId: string | null = "dev";

// ---------- plumbing ----------

function emit(msg: HostToWebview): void {
  setTimeout(() => window.postMessage(msg, "*"), 0);
}

function snapshot(): WorkbenchState {
  return {
    collections: structuredClone(collections),
    globals: toEnvironmentView(globals),
    environments: environments.map(toEnvironmentView),
    activeEnvironmentId,
    dotenvKeys: ["API_KEY", "DATABASE_URL"],
  };
}

const pushState = () => emit({ type: "state", state: snapshot() });

function locate(id: string) {
  for (const collection of collections) {
    const found = findItem(collection, id);
    if (found) return { collection, found };
  }
  return undefined;
}

const hashParams = () => new URLSearchParams(location.hash.slice(1));

function deepLink(): NavTarget | undefined {
  const p = hashParams();
  if (p.has("request"))
    return { view: "request", requestId: p.get("request") ?? "" };
  if (p.has("collection"))
    return {
      view: "collection",
      collectionId: p.get("collection") ?? "",
      tab: (p.get("tab") ?? "overview") as CollectionTab,
    };
  if (p.has("variables"))
    return {
      view: "variables",
      environmentId: p.get("variables") || undefined,
    };
  if (p.has("welcome")) return { view: "welcome" };
  return undefined;
}

// ---------- fake HTTP ----------

const PETS = [
  {
    id: 42,
    name: "doggie",
    status: "available",
    category: { id: 1, name: "Dogs" },
    tags: ["friendly"],
  },
  {
    id: 43,
    name: "Garfield",
    status: "available",
    category: { id: 2, name: "Cats" },
    tags: ["lazy", "orange"],
  },
  {
    id: 44,
    name: "Nemo",
    status: "available",
    category: { id: 3, name: "Fish" },
    tags: [],
  },
];

function fakeBody(r: RequestItem): { status: number; body: unknown } {
  switch (r.id) {
    case "list-pets":
      return { status: 200, body: PETS };
    case "get-pet":
    case "update-pet":
      return { status: 200, body: PETS[0] };
    case "create-pet":
      return {
        status: 201,
        body: {
          id: 45,
          name: "doggie",
          status: "available",
          tags: ["friendly"],
        },
      };
    case "delete-pet":
      return { status: 204, body: undefined };
    case "inventory":
      return { status: 200, body: { available: 12, pending: 3, sold: 41 } };
    case "health":
      return {
        status: 200,
        body: { status: "ok", version: "3.1.4", uptimeSeconds: 86400 },
      };
    default:
      return r.id.startsWith("gh-")
        ? {
            status: 401,
            body: {
              message: "Requires authentication",
              documentation_url: "https://docs.github.com/rest",
            },
          }
        : { status: 200, body: { ok: true } };
  }
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  401: "Unauthorized",
};

function fakeResponse(r: RequestItem): ResponseData {
  const { status, body } = fakeBody(r);
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    statusText: STATUS_TEXT[status] ?? "",
    headers: [
      ["content-type", "application/json; charset=utf-8"],
      ["date", "Mon, 02 Nov 2026 10:24:00 GMT"],
      ["x-request-id", "7f3c2a9e-1b4d-4c8e-9a51-3d2f6b8e0c11"],
      ["cache-control", "no-cache"],
      ["content-length", String(text.length)],
    ],
    body: text,
    bodyEncoding: "utf8",
    contentType: "application/json; charset=utf-8",
    sizeBytes: text.length,
    truncated: false,
    timings: { ttfbMs: 61, totalMs: 84 },
    url: r.url,
    redirects: 0,
  };
}

function send(r: RequestItem): void {
  emit({ type: "sending", requestId: r.id });
  setTimeout(
    () =>
      emit({
        type: "response",
        requestId: r.id,
        response: fakeResponse(r),
        unresolved: [],
      }),
    350,
  );
}

// ---------- message handling ----------

function handleItemAction(
  msg: Extract<WebviewToHost, { type: "itemAction" }>,
): void {
  const c = collections.find((x) => x.id === msg.collectionId);
  if (!c) return;
  switch (msg.action) {
    case "newRequest": {
      const r = newRequest(crypto.randomUUID());
      r.url = "{{baseUrl}}/";
      insertItem(c, msg.itemId ?? null, r);
      pushState();
      emit({ type: "navigate", target: { view: "request", requestId: r.id } });
      return;
    }
    case "newFolder": {
      const name = window.prompt("Folder name", "New folder");
      if (name)
        insertItem(c, msg.itemId ?? null, {
          type: "folder",
          id: crypto.randomUUID(),
          name,
          items: [],
        });
      break;
    }
    case "rename": {
      const item = msg.itemId ? findItem(c, msg.itemId)?.item : c;
      const name = item && window.prompt("New name", item.name);
      if (item && name) item.name = name;
      break;
    }
    case "duplicate":
      if (msg.itemId) duplicateItem(c, msg.itemId);
      break;
    case "delete":
      if (!window.confirm("Delete?")) return;
      if (msg.itemId) removeItem(c, msg.itemId);
      else collections.splice(collections.indexOf(c), 1);
      break;
  }
  pushState();
}

function handle(msg: WebviewToHost): void {
  switch (msg.type) {
    case "ready": {
      pushState();
      const target = deepLink();
      if (target) emit({ type: "navigate", target });
      const tab = hashParams().get("tab");
      if (target?.view === "request" && tab) {
        setTimeout(() => {
          const button = [
            ...document.querySelectorAll<HTMLButtonElement>("button[role=tab]"),
          ].find((b) => b.textContent?.toLowerCase().startsWith(tab));
          button?.click();
        }, 50);
      }
      if (target?.view === "request" && hashParams().has("send")) {
        const item = locate(target.requestId)?.found.item;
        if (item?.type === "request") setTimeout(() => send(item), 100);
      }
      return;
    }
    case "updateRequest": {
      const loc = locate(msg.request.id);
      if (loc) loc.found.parent.items[loc.found.index] = msg.request;
      pushState();
      return;
    }
    case "updateCollection": {
      const c = collections.find((x) => x.id === msg.collectionId);
      if (c) {
        const { name, description, variables, auth } = msg.patch;
        if (name !== undefined) c.name = name;
        if (description !== undefined) c.description = description;
        if (variables !== undefined) c.variables = variables;
        if (auth !== undefined) c.auth = auth;
      }
      pushState();
      return;
    }
    case "saveEnvironment": {
      if (msg.environment.id === globals.id) {
        globals = {
          ...applyEnvironmentUpdate(
            globals,
            msg.environment,
            msg.secretUpdates,
          ),
          name: "Globals",
        };
      } else {
        environments = environments.map((e) =>
          e.id === msg.environment.id
            ? applyEnvironmentUpdate(e, msg.environment, msg.secretUpdates)
            : e,
        );
      }
      pushState();
      return;
    }
    case "setActiveEnvironment":
      activeEnvironmentId = msg.environmentId;
      pushState();
      return;
    case "action": {
      if (msg.action === "importOpenApi") {
        window.alert(
          "In VS Code this opens a file picker or asks for a URL to an OpenAPI/Swagger document.",
        );
        return;
      }
      const isEnv = msg.action === "newEnvironment";
      const name = window.prompt(
        isEnv ? "Environment name" : "Collection name",
        isEnv ? "Staging" : "My API",
      );
      if (!name) return;
      const id = crypto.randomUUID();
      if (isEnv) environments.push({ version: 1, id, name, variables: [] });
      else
        collections.push({
          version: 1,
          id,
          name,
          variables: [kv("baseUrl", "https://api.example.com")],
          auth: { type: "none" },
          items: [],
        });
      pushState();
      emit({
        type: "navigate",
        target: isEnv
          ? { view: "variables", environmentId: id }
          : { view: "collection", collectionId: id },
      });
      return;
    }
    case "itemAction":
      handleItemAction(msg);
      return;
    case "envAction": {
      const env = environments.find((e) => e.id === msg.environmentId);
      if (!env) return;
      if (msg.action === "delete" && window.confirm(`Delete ${env.name}?`))
        environments = environments.filter((e) => e !== env);
      if (msg.action === "duplicate")
        environments.push({
          ...structuredClone(env),
          id: crypto.randomUUID(),
          name: `${env.name} Copy`,
        });
      if (msg.action === "rename") {
        const name = window.prompt("New name", env.name);
        if (name) env.name = name;
      }
      pushState();
      return;
    }
    case "move": {
      const source = collections.find((x) => x.id === msg.collectionId);
      const target = collections.find((x) => x.id === msg.targetCollectionId);
      if (!source || !target) return;
      if (source === target)
        moveItem(source, msg.itemId, msg.targetParentId, msg.index);
      else {
        const item = removeItem(source, msg.itemId);
        if (item) insertItem(target, msg.targetParentId, item, msg.index);
      }
      pushState();
      return;
    }
    case "send":
      send(msg.request);
      return;
    case "copyAsCurl":
      void navigator.clipboard?.writeText(
        `curl -X ${msg.request.method} '${msg.request.url}'`,
      );
      return;
    case "cancel":
    case "saveResponse":
      return;
  }
}

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi =
  () => ({
    postMessage: (msg: WebviewToHost) => setTimeout(() => handle(msg), 0),
    getState: () => undefined,
    setState: () => undefined,
  });
