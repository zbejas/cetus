import fs from "node:fs";

const client = fs.readFileSync(new URL("./apiDocsClient.js", import.meta.url), "utf8");

export function apiDocsHtml() {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <title>Cetus API reference</title>
  <link rel="icon" href="/icon.svg" type="image/svg+xml" />
  <style>
    :root {
      --bg: #070b0f;
      --surface: #0f161d;
      --raised: #151f28;
      --border: #22303b;
      --text: #e6edf3;
      --muted: #8b9aa7;
      --accent: #2dd4bf;
      --accent-soft: rgba(45, 212, 191, 0.12);
      --warn: #f5a524;
      --danger: #f87171;
      --success: #34d399;
      --mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
      --sans: "Public Sans", Inter, system-ui, sans-serif;
    }
    html[data-theme="light"] {
      --bg: #f6f8fa;
      --surface: #ffffff;
      --raised: #f0f3f6;
      --border: #d8dee4;
      --text: #101820;
      --muted: #5b6b78;
      --accent: #0f766e;
      --accent-soft: rgba(15, 118, 110, 0.1);
      --warn: #b45309;
      --danger: #b91c1c;
      --success: #047857;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 14px;
      line-height: 1.5;
    }
    button, input, textarea, select { font: inherit; color: inherit; }
    a { color: var(--accent); text-decoration: none; }
    .shell { display: grid; grid-template-rows: 56px 1fr; min-height: 100vh; }
    .topbar {
      display: flex; align-items: center; gap: 14px;
      padding: 0 20px; border-bottom: 1px solid var(--border);
      background: color-mix(in oklab, var(--surface) 90%, transparent);
      position: sticky; top: 0; z-index: 10;
    }
    .brand { display: flex; align-items: center; gap: 9px; font-weight: 650; letter-spacing: -0.01em; }
    .brand img { width: 22px; height: 22px; }
    .topbar .spacer { flex: 1; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid var(--border); background: var(--raised);
      border-radius: 999px; padding: 4px 9px; font-size: 11px; color: var(--muted);
    }
    .btn {
      display: inline-flex; align-items: center; gap: 7px;
      border: 1px solid var(--border); background: var(--surface);
      border-radius: 8px; padding: 6px 11px; cursor: pointer;
      font-size: 12px; font-weight: 550;
    }
    .btn:hover { border-color: color-mix(in oklab, var(--accent) 45%, var(--border)); }
    .btn.primary { background: var(--accent); border-color: transparent; color: #041312; }
    html[data-theme="light"] .btn.primary { color: #ffffff; }
    .btn.ghost { background: transparent; }
    .input {
      width: 100%; border: 1px solid var(--border); background: var(--surface);
      border-radius: 8px; padding: 8px 10px; outline: none;
    }
    .input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); min-height: 0; }
    .sidebar {
      border-right: 1px solid var(--border); background: var(--surface);
      min-height: 0; overflow: auto; padding: 16px 12px 32px;
    }
    .sidebar h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.11em; color: var(--muted); margin: 18px 8px 7px; }
    .nav-item {
      display: flex; align-items: center; gap: 8px; width: 100%;
      border: 0; background: transparent; color: var(--text);
      padding: 6px 8px; border-radius: 7px; cursor: pointer; text-align: left;
    }
    .nav-item:hover { background: var(--raised); }
    .nav-item[data-active="true"] { background: var(--accent-soft); }
    .nav-item .path { font-family: var(--mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .method {
      flex: 0 0 auto; width: 48px; text-align: center; border-radius: 5px;
      padding: 2px 0; font-family: var(--mono); font-size: 9.5px; font-weight: 700;
      letter-spacing: 0.02em; background: var(--raised); color: var(--muted);
    }
    .method[data-method="GET"] { color: var(--accent); }
    .method[data-method="POST"] { color: var(--success); }
    .method[data-method="PUT"], .method[data-method="PATCH"] { color: var(--warn); }
    .method[data-method="DELETE"] { color: var(--danger); }
    .main { min-width: 0; padding: 26px 32px 64px; overflow: auto; }
    .op-head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
    .op-head h1 { font-size: 22px; margin: 0; letter-spacing: -0.02em; }
    .op-path { font-family: var(--mono); font-size: 13px; color: var(--muted); }
    .op-summary { color: var(--muted); margin: 4px 0 20px; max-width: 76ch; }
    .card {
      border: 1px solid var(--border); background: var(--surface);
      border-radius: 10px; margin-bottom: 16px; overflow: hidden;
    }
    .card h3 {
      margin: 0; padding: 10px 14px; font-size: 12px; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--muted); border-bottom: 1px solid var(--border);
      background: var(--raised);
    }
    .card-body { padding: 14px; }
    .field { display: grid; gap: 5px; margin-bottom: 12px; }
    .field label { font-size: 11.5px; color: var(--muted); }
    .field .hint { font-size: 11px; color: var(--muted); }
    .required { color: var(--danger); }
    .mono { font-family: var(--mono); }
    .muted { color: var(--muted); }
    .tag { display: inline-block; background: var(--raised); border-radius: 999px; padding: 2px 8px; font-size: 10.5px; color: var(--muted); }
    pre, textarea.code {
      margin: 0; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
      padding: 12px; overflow: auto; font-family: var(--mono); font-size: 11.5px; line-height: 1.6;
      max-height: 420px; white-space: pre-wrap; word-break: break-word;
    }
    textarea.code { width: 100%; resize: vertical; min-height: 132px; }
    .auth-row { display: flex; gap: 8px; align-items: center; min-width: min(560px, 100%); }
    .auth-row .input { font-family: var(--mono); font-size: 12px; }
    .response-line { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; font-size: 12px; }
    .status { font-family: var(--mono); font-weight: 700; }
    .status[data-ok="true"] { color: var(--success); }
    .status[data-ok="false"] { color: var(--danger); }
    .empty { max-width: 60ch; color: var(--muted); padding: 32px 0; }
    .error { border: 1px solid color-mix(in oklab, var(--danger) 40%, var(--border)); background: color-mix(in oklab, var(--danger) 8%, transparent); color: var(--danger); border-radius: 9px; padding: 12px 14px; }
    .split { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
    .schema-row { display: flex; gap: 8px; padding: 5px 0; border-bottom: 1px dashed color-mix(in oklab, var(--border) 65%, transparent); font-size: 12px; }
    .schema-row:last-child { border-bottom: 0; }
    .schema-name { font-family: var(--mono); min-width: 130px; color: var(--text); }
    .schema-type { font-family: var(--mono); color: var(--muted); }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { border-right: 0; border-bottom: 1px solid var(--border); max-height: 42vh; }
      .main { padding: 20px 16px 48px; }
      .topbar { padding: 0 12px; }
      .topbar .pill { display: none; }
      .auth-row { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand"><img src="/icon.svg" alt="" /> Cetus <span class="muted" style="font-weight:400">API</span></div>
      <span class="pill" id="version-pill">loading</span>
      <span class="spacer"></span>
      <div class="auth-row" style="min-width:0">
        <input id="token" class="input" type="password" placeholder="Bearer API key (optional)" autocomplete="off" spellcheck="false" />
        <button class="btn ghost" id="clear-token" type="button">Clear</button>
      </div>
      <a class="btn ghost" id="spec-link" href="/api/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a>
      <button class="btn ghost" id="theme" type="button" aria-label="Toggle theme">Light</button>
    </header>
    <div class="layout">
      <aside class="sidebar">
        <input id="search" class="input" type="search" placeholder="Filter endpoints" aria-label="Filter endpoints" />
        <nav id="nav" aria-label="API endpoints"></nav>
      </aside>
      <main class="main" id="main">
        <div class="empty">Select an endpoint from the sidebar.</div>
      </main>
    </div>
  </div>
  <script src="/api/docs/client.js" defer></script>
</body>
</html>`;
}

export function apiDocsClient() {
  return client;
}
