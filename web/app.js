// Gallery front-end. Reads the generated index.json (source of truth lives in
// the artifacts/ folder). Set window.NMT_INDEX_URL to force a specific URL
// (e.g. a remote raw URL); otherwise we probe the two known layouts:
//   - "./index.json"  → GitHub Pages build (index.html, index.json, artifacts/ are siblings)
//   - "../index.json" → local dev (web/index.html with index.json at repo root)
const INDEX_CANDIDATES = window.NMT_INDEX_URL ? [window.NMT_INDEX_URL] : ["./index.json", "../index.json"];
let indexUrl = INDEX_CANDIDATES[0];

const els = {
  search: document.getElementById("search"),
  type: document.getElementById("type-filter"),
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  empty: document.getElementById("empty"),
  emptyReset: document.getElementById("empty-reset"),
  dialog: document.getElementById("detail"),
  title: document.getElementById("detail-title"),
  desc: document.getElementById("detail-desc"),
  meta: document.getElementById("detail-meta"),
  tabs: document.getElementById("detail-tabs"),
  preview: document.getElementById("detail-preview"),
  frame: document.getElementById("detail-frame"),
  open: document.getElementById("detail-open"),
  source: document.getElementById("detail-source"),
  filename: document.getElementById("detail-filename"),
  code: document.getElementById("detail-code"),
  copy: document.getElementById("detail-copy"),
  close: document.getElementById("detail-close"),
};

let artifacts = [];

function baseDir() {
  // Artifact files live next to the resolved index.json, under <path>/.
  return indexUrl.replace(/index\.json$/, "");
}

function matches(a, query, type) {
  if (type && a.type !== type) return false;
  if (!query) return true;
  const hay = [a.name, a.description, a.type, ...(a.tags || [])].join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

function render() {
  const query = els.search.value.trim();
  const type = els.type.value;
  const shown = artifacts.filter((a) => matches(a, query, type));

  els.status.textContent = `${shown.length} of ${artifacts.length} artifact(s)`;
  els.empty.hidden = shown.length > 0;
  els.grid.replaceChildren(
    ...shown.map((a) => {
      const card = document.createElement("div");
      card.className = "card";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.innerHTML = `
        <div class="card-top">
          <h3></h3>
          <span class="badge"></span>
        </div>
        <p></p>
        <div class="tags"></div>`;
      card.querySelector("h3").textContent = a.name;
      const badge = card.querySelector(".badge");
      badge.textContent = a.type;
      badge.dataset.type = a.type;
      card.querySelector("p").textContent = a.description;
      const tags = card.querySelector(".tags");
      for (const t of (a.tags || []).slice(0, 6)) {
        const tag = document.createElement("button");
        tag.type = "button";
        tag.className = "tag";
        tag.textContent = t;
        tag.title = `Filter by "${t}"`;
        tag.addEventListener("click", (e) => {
          e.stopPropagation();
          els.search.value = t;
          render();
        });
        tags.appendChild(tag);
      }
      const open = () => openDetail(a);
      card.addEventListener("click", open);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
      return card;
    })
  );
}

async function openDetail(a) {
  els.title.textContent = a.name;
  els.desc.textContent = a.description;

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = a.type;
  badge.dataset.type = a.type;
  els.meta.replaceChildren(
    badge,
    ...[`v${a.version}`, a.language && `lang: ${a.language}`, a.license]
      .filter(Boolean)
      .map((text) => {
        const span = document.createElement("span");
        span.className = "tag";
        span.textContent = text;
        return span;
      })
  );

  // Renderable artifacts (HTML) get a live "Preview" tab; every file also gets
  // a source tab. Content/preview is loaded lazily and cached.
  const isRenderable = a.renderable || /\.html?$/i.test(a.entry || "");
  const files = [a.entry, ...(a.files || []).filter((f) => f !== a.entry)];
  const cache = new Map();
  let frameLoaded = false;

  function selectTab(key) {
    for (const tab of els.tabs.children) {
      tab.setAttribute("aria-selected", String(tab.dataset.key === key));
    }
  }

  function showPreview() {
    selectTab("__preview__");
    els.preview.hidden = false;
    els.source.hidden = true;
    if (!frameLoaded) {
      const url = `${baseDir()}${a.path}/${a.entry}`;
      els.frame.src = url;
      els.open.href = url;
      frameLoaded = true;
    }
  }

  async function showFile(file) {
    selectTab(file);
    els.preview.hidden = true;
    els.source.hidden = false;
    els.filename.textContent = file;
    if (!cache.has(file)) {
      els.code.textContent = "Loading…";
      try {
        const res = await fetch(`${baseDir()}${a.path}/${file}`);
        cache.set(file, res.ok ? await res.text() : `Could not load ${file} (${res.status})`);
      } catch (err) {
        cache.set(file, `Could not load ${file}: ${err.message}`);
      }
    }
    els.code.textContent = cache.get(file);
  }

  const tabs = [];
  if (isRenderable) tabs.push({ key: "__preview__", label: "⊳ Preview", onClick: showPreview });
  for (const file of files) tabs.push({ key: file, label: file, onClick: () => showFile(file) });

  els.tabs.replaceChildren(
    ...tabs.map((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filetab";
      btn.role = "tab";
      btn.dataset.key = t.key;
      btn.textContent = t.label;
      btn.addEventListener("click", t.onClick);
      return btn;
    })
  );

  // Clear any previously-rendered artifact before showing the new one.
  els.frame.removeAttribute("src");
  els.dialog.showModal();
  if (isRenderable) showPreview();
  else showFile(a.entry);
}

els.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.code.textContent);
  els.copy.textContent = "Copied!";
  setTimeout(() => (els.copy.textContent = "Copy"), 1200);
});
els.close.addEventListener("click", () => els.dialog.close());
els.search.addEventListener("input", render);
els.type.addEventListener("change", render);
els.emptyReset.addEventListener("click", () => {
  els.search.value = "";
  els.type.value = "";
  render();
});

(async function init() {
  els.status.textContent = "Loading index…";
  for (const candidate of INDEX_CANDIDATES) {
    try {
      const res = await fetch(candidate);
      if (!res.ok) continue;
      const index = await res.json();
      indexUrl = candidate;
      artifacts = index.artifacts || [];
      render();
      return;
    } catch {
      // try the next candidate
    }
  }
  els.status.textContent = `Failed to load index.json. Run "npm run build:index" first.`;
})();
