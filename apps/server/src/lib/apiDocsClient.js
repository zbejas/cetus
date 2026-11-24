const state = {
  spec: null,
  selected: null,
  filter: "",
  token: sessionStorage.getItem("cetus-api-token") || "",
  baseUrl: sessionStorage.getItem("cetus-api-base") || window.location.origin,
};

const main = document.getElementById("main");
const nav = document.getElementById("nav");
const search = document.getElementById("search");
const tokenInput = document.getElementById("token");
const versionPill = document.getElementById("version-pill");
const themeButton = document.getElementById("theme");

function make(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function resolveRef(spec, schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref && typeof schema.$ref === "string") {
    const parts = schema.$ref.replace(/^#\//, "").split("/");
    let current = spec;
    for (const part of parts) current = current?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    return resolveRef(spec, current);
  }
  return schema;
}

function mergeSchema(spec, schema) {
  const resolved = resolveRef(spec, schema);
  if (!resolved || typeof resolved !== "object") return resolved || {};
  if (Array.isArray(resolved.allOf)) {
    return resolved.allOf.reduce((acc, entry) => ({ ...acc, ...mergeSchema(spec, entry) }), { ...resolved, allOf: undefined });
  }
  if (Array.isArray(resolved.oneOf) && resolved.oneOf.length) return mergeSchema(spec, resolved.oneOf[0]);
  if (Array.isArray(resolved.anyOf) && resolved.anyOf.length) return mergeSchema(spec, resolved.anyOf[0]);
  return resolved;
}

function typeLabel(spec, schema) {
  if (!schema) return "any";
  if (schema.$ref) return schema.$ref.split("/").pop();
  const resolved = mergeSchema(spec, schema);
  if (resolved.enum) return `enum(${resolved.enum.map(String).join(", ")})`;
  if (resolved.type === "array") return `array<${typeLabel(spec, resolved.items)}>`;
  if (resolved.type) return resolved.type;
  if (resolved.properties) return "object";
  return "any";
}

function exampleFor(spec, schema, depth = 0) {
  if (!schema || depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  const resolved = mergeSchema(spec, schema);
  if (!resolved || typeof resolved !== "object") return null;
  if (resolved.example !== undefined) return resolved.example;
  if (resolved.default !== undefined) return resolved.default;
  if (resolved.enum?.length) return resolved.enum[0];
  if (Array.isArray(resolved.allOf)) return exampleFor(spec, mergeSchema(spec, resolved), depth + 1);
  if (resolved.type === "object" || resolved.properties) {
    const object = {};
    for (const [name, child] of Object.entries(resolved.properties || {})) {
      object[name] = exampleFor(spec, child, depth + 1);
    }
    return object;
  }
  if (resolved.type === "array") return [exampleFor(spec, resolved.items, depth + 1)];
  if (resolved.type === "integer" || resolved.type === "number") return 0;
  if (resolved.type === "boolean") return false;
  if (resolved.type === "string") {
    if (resolved.format === "date-time") return new Date(0).toISOString();
    if (resolved.format === "email") return "admin@example.com";
    if (resolved.format === "uri" || resolved.format === "url") return "https://example.com";
    return "";
  }
  return null;
}

function operationList() {
  if (!state.spec?.paths) return [];
  const entries = [];
  for (const [path, pathItem] of Object.entries(state.spec.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      const op = pathItem?.[method];
      if (!op) continue;
      entries.push({
        path,
        method: method.toUpperCase(),
        op,
        tag: op.tags?.[0] || "General",
        summary: op.summary || op.operationId || `${method.toUpperCase()} ${path}`,
      });
    }
  }
  return entries;
}

function filterEntries(entries) {
  const query = state.filter.trim().toLowerCase();
  if (!query) return entries;
  return entries.filter((entry) =>
    `${entry.method} ${entry.path} ${entry.summary} ${entry.tag}`.toLowerCase().includes(query),
  );
}

function renderNav() {
  const entries = filterEntries(operationList());
  nav.replaceChildren();
  if (!entries.length) {
    nav.append(make("p", { class: "empty", text: "No endpoints match." }));
    return;
  }
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.tag)) groups.set(entry.tag, []);
    groups.get(entry.tag).push(entry);
  }
  for (const [tag, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    nav.append(make("h2", { text: tag }));
    for (const entry of items.sort((a, b) => `${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`))) {
      const active = state.selected && state.selected.path === entry.path && state.selected.method === entry.method;
      const button = make("button", {
        class: "nav-item",
        type: "button",
        title: entry.summary,
        "data-active": active ? "true" : "false",
        onclick: () => select(entry.path, entry.method),
      }, [
        make("span", { class: "method", "data-method": entry.method, text: entry.method }),
        make("span", { class: "path", text: entry.path }),
      ]);
      nav.append(button);
    }
  }
}

function select(path, method) {
  state.selected = { path, method };
  history.replaceState(null, "", `#${method.toLowerCase()} ${path}`);
  renderNav();
  renderDetail();
}

function parameterRows(op) {
  return (op.parameters || []).map((parameter) => ({ ...resolveRef(state.spec, parameter), in: parameter.in }));
}

function renderParameters(entry) {
  const parameters = parameterRows(entry.op);
  if (!parameters.length) return null;
  const card = make("section", { class: "card" }, [make("h3", { text: "Parameters" })]);
  const body = make("div", { class: "card-body" });
  for (const parameter of parameters) {
    const schema = mergeSchema(state.spec, parameter.schema);
    const id = `param-${parameter.in}-${parameter.name}`;
    body.append(make("div", { class: "field" }, [
      make("label", { for: id }, [
        make("span", { class: "mono", text: parameter.name }),
        parameter.required ? make("span", { class: "required", text: " *" }) : null,
        make("span", { class: "muted", text: `  ${parameter.in} · ${typeLabel(state.spec, parameter.schema)}` }),
      ]),
      parameter.in === "path" || parameter.in === "query"
        ? make("input", {
            class: "input mono",
            id,
            "data-param-in": parameter.in,
            "data-param-name": parameter.name,
            placeholder: schema?.default !== undefined ? String(schema.default) : parameter.description || "",
            value: schema?.default !== undefined ? String(schema.default) : "",
            autocomplete: "off",
            spellcheck: "false",
          })
        : make("input", {
            class: "input mono",
            id,
            "data-param-in": parameter.in,
            "data-param-name": parameter.name,
            placeholder: parameter.description || "",
            autocomplete: "off",
            spellcheck: "false",
          }),
      parameter.description ? make("span", { class: "hint", text: parameter.description }) : null,
    ]));
  }
  card.append(body);
  return card;
}

function renderBody(entry) {
  const requestBody = resolveRef(state.spec, entry.op.requestBody);
  if (!requestBody) return null;
  const content = requestBody.content || {};
  const mediaType = content["application/json"] ? "application/json" : Object.keys(content)[0];
  if (!mediaType) return null;
  const schema = content[mediaType]?.schema;
  const example = exampleFor(state.spec, schema);
  const card = make("section", { class: "card" }, [make("h3", { text: `Request body · ${mediaType}` })]);
  const body = make("div", { class: "card-body" });
  if (requestBody.description) body.append(make("p", { class: "muted", text: requestBody.description }));
  body.append(make("div", { class: "field" }, [
    make("label", { for: "request-body" }, [
      make("span", { text: "JSON body" }),
      requestBody.required ? make("span", { class: "required", text: " *" }) : null,
    ]),
    make("textarea", {
      class: "code",
      id: "request-body",
      spellcheck: "false",
      "aria-label": "JSON request body",
    }),
  ]));
  const textarea = body.querySelector("#request-body");
  textarea.value = example === null ? "" : JSON.stringify(example, null, 2);
  const rows = schemaFieldRows(schema);
  if (rows.length) body.append(make("div", { style: "margin-top:10px" }, rows));
  card.append(body);
  return card;
}

function schemaFieldRows(schema) {
  const resolved = mergeSchema(state.spec, schema);
  const properties = resolved?.properties;
  if (!properties) return [];
  return Object.entries(properties).slice(0, 48).map(([name, child]) => {
    const meta = mergeSchema(state.spec, child);
    const required = Array.isArray(resolved.required) && resolved.required.includes(name);
    return make("div", { class: "schema-row" }, [
      make("span", { class: "schema-name", text: name + (required ? " *" : "") }),
      make("span", { class: "schema-type", text: typeLabel(state.spec, child) }),
      make("span", { class: "muted", text: meta?.description || "" }),
    ]);
  });
}

function renderResponses(entry) {
  const responses = entry.op.responses || {};
  const card = make("section", { class: "card" }, [make("h3", { text: "Responses" })]);
  const body = make("div", { class: "card-body" });
  for (const [status, response] of Object.entries(responses)) {
    const resolved = resolveRef(state.spec, response);
    const content = resolved?.content || {};
    const mediaType = content["application/json"] ? "application/json" : Object.keys(content)[0];
    const schema = mediaType ? content[mediaType]?.schema : null;
    body.append(make("div", { class: "schema-row" }, [
      make("span", { class: "schema-name", text: status }),
      make("span", { class: "schema-type", text: schema ? typeLabel(state.spec, schema) : "no body" }),
      make("span", { class: "muted", text: resolved?.description || "" }),
    ]));
  }
  card.append(body);
  return card;
}

function renderTry(entry) {
  const card = make("section", { class: "card" }, [make("h3", { text: "Try it" })]);
  const body = make("div", { class: "card-body" });
  body.append(make("div", { class: "field" }, [
    make("label", { for: "base-url", text: "Base URL" }),
    make("input", {
      class: "input mono",
      id: "base-url",
      value: state.baseUrl,
      spellcheck: "false",
      autocomplete: "off",
    }),
  ]));
  body.append(make("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px" }, [
    make("button", { class: "btn primary", type: "button", id: "send", text: "Send request" }),
    make("span", { class: "muted", text: state.token ? "Using the bearer token from the top bar." : "Using the current browser session." }),
  ]));
  const result = make("div", { id: "result" });
  body.append(result);
  card.append(body);

  const send = body.querySelector("#send");
  const baseUrl = body.querySelector("#base-url");
  const resultBox = body.querySelector("#result");
  send.addEventListener("click", async () => {
    resultBox.replaceChildren(make("p", { class: "muted", text: "Sending..." }));
    try {
      state.baseUrl = baseUrl.value.trim().replace(/\/$/, "") || window.location.origin;
      sessionStorage.setItem("cetus-api-base", state.baseUrl);
      let path = entry.path;
      const query = new URLSearchParams();
      for (const input of main.querySelectorAll("[data-param-in]")) {
        const value = input.value.trim();
        if (!value) continue;
        if (input.dataset.paramIn === "path") {
          path = path.replace(`{${input.dataset.paramName}}`, encodeURIComponent(value));
        } else if (input.dataset.paramIn === "query") {
          query.set(input.dataset.paramName, value);
        }
      }
      const url = new URL(state.baseUrl + path + (query.size ? `?${query}` : ""));
      const headers = { Accept: "application/json" };
      if (state.token) headers.Authorization = `Bearer ${state.token}`;
      const init = { method: entry.method, headers, credentials: "include" };
      const bodyField = main.querySelector("#request-body");
      if (bodyField && bodyField.value.trim()) {
        headers["Content-Type"] = "application/json";
        init.body = bodyField.value;
      }
      const started = performance.now();
      const response = await fetch(url, init);
      const elapsed = Math.round(performance.now() - started);
      const text = await response.text();
      let output = text;
      try {
        output = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Keep plain text responses.
      }
      const ok = response.ok;
      resultBox.replaceChildren(
        make("div", { class: "response-line" }, [
          make("span", { class: "status", "data-ok": ok ? "true" : "false", text: `${response.status} ${response.statusText}` }),
          make("span", { class: "muted", text: `${elapsed} ms · ${response.headers.get("content-type") || "unknown type"}` }),
        ]),
        make("pre", { text: output || "(empty response)" }),
      );
    } catch (error) {
      resultBox.replaceChildren(make("div", { class: "error", text: error instanceof Error ? error.message : String(error) }));
    }
  });
  return card;
}

function renderDetail() {
  const entry = state.selected
    ? operationList().find((item) => item.path === state.selected.path && item.method === state.selected.method)
    : null;
  if (!entry) {
    main.replaceChildren(make("div", { class: "empty", text: "Select an endpoint from the sidebar." }));
    return;
  }
  const op = entry.op;
  const children = [
    make("div", { class: "op-head" }, [
      make("span", { class: "method", "data-method": entry.method, text: entry.method }),
      make("h1", { text: op.summary || op.operationId || entry.path }),
    ]),
    make("div", { class: "op-path", text: entry.path }),
    make("p", { class: "op-summary", text: op.description || "No description." }),
    make("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px" }, [
      make("span", { class: "tag", text: entry.tag }),
      ...(op.security || state.spec.security ? [make("span", { class: "tag", text: "Bearer API key or session" })] : []),
      ...(op.operationId ? [make("span", { class: "tag mono", text: op.operationId })] : []),
    ]),
  ];
  const parameters = renderParameters(entry);
  if (parameters) children.push(parameters);
  const body = renderBody(entry);
  if (body) children.push(body);
  children.push(renderTry(entry));
  children.push(renderResponses(entry));
  main.replaceChildren(...children);
}

function renderError(error) {
  main.replaceChildren(
    make("h1", { text: "API reference unavailable" }),
    make("div", { class: "error", text: error instanceof Error ? error.message : String(error) }),
    make("p", { class: "muted", text: "The OpenAPI document could not be loaded. Check that the server is running and reload this page." }),
  );
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("cetus-api-theme", theme);
  themeButton.textContent = theme === "dark" ? "Light" : "Dark";
}

function initTheme() {
  const saved = localStorage.getItem("cetus-api-theme");
  const preferred = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  setTheme(saved || preferred);
  themeButton.addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
}

function initAuth() {
  tokenInput.value = state.token;
  tokenInput.addEventListener("input", () => {
    state.token = tokenInput.value.trim();
    if (state.token) sessionStorage.setItem("cetus-api-token", state.token);
    else sessionStorage.removeItem("cetus-api-token");
  });
  document.getElementById("clear-token").addEventListener("click", () => {
    state.token = "";
    tokenInput.value = "";
    sessionStorage.removeItem("cetus-api-token");
  });
}

function initSearch() {
  search.addEventListener("input", () => {
    state.filter = search.value;
    renderNav();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== search && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      search.focus();
    }
    if (event.key === "Escape" && document.activeElement === search) {
      search.value = "";
      state.filter = "";
      renderNav();
      search.blur();
    }
  });
}

async function boot() {
  initTheme();
  initAuth();
  initSearch();
  try {
    const response = await fetch("/api/openapi.json", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`OpenAPI request failed with ${response.status}.`);
    state.spec = await response.json();
    versionPill.textContent = `${state.spec.info?.title || "Cetus"} ${state.spec.info?.version || ""}`;
    const hash = location.hash.replace(/^#/, "").trim();
    const match = hash.match(/^([a-z]+)\s+(.+)$/i);
    if (match) {
      const entry = operationList().find((item) => item.method === match[1].toUpperCase() && item.path === match[2]);
      if (entry) state.selected = { path: entry.path, method: entry.method };
    }
    if (!state.selected) {
      const first = operationList().find((entry) => entry.method === "GET") || operationList()[0];
      if (first) state.selected = { path: first.path, method: first.method };
    }
    renderNav();
    renderDetail();
  } catch (error) {
    renderError(error);
  }
}

void boot();
