/**
 * P3 房主选片面板：OpenList 目录浏览 / 搜索 / 分页。
 *
 * 仅房主可见（观众端不挂载）。所有请求带成员令牌；观众令牌在服务端会被 403 拒绝（双保险）。
 * 点选视频文件 → onPick(path, name, size) → 由 room-main 注册 mediaId 并广播 load。
 */

export interface BrowseItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface SearchItem {
  name: string;
  parent: string;
  isDir: boolean;
  size: number;
}

/** 静态 SVG 图标（目录/文件），禁止 emoji 图标 */
function iconSvg(name: "folder" | "file"): string {
  const body =
    name === "folder"
      ? '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
      : '<path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>';
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

export interface BrowseHandlers {
  roomId: string;
  getToken: () => string;
  onPick: (file: { path: string; name: string; size: number }) => void;
  onStatus: (line: string, warn?: boolean) => void;
}

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`缺少元素 ${sel}`);
  return el;
};

const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".ts", ".m4v", ".webm", ".mpg", ".mpeg", ".rmvb"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

function fmtSize(bytes: number): string {
  if (bytes <= 0) return "-";
  const mib = bytes / 1024 / 1024;
  return mib >= 1024 ? `${(mib / 1024).toFixed(2)} GiB` : `${mib.toFixed(1)} MiB`;
}

async function authedGet(handlers: BrowseHandlers, url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${handlers.getToken()}` } });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
  }
  return data;
}

export function initBrowsePanel(handlers: BrowseHandlers): void {
  const pathInput = $("#browsePath") as HTMLInputElement;
  const listEl = $("#browseList");
  const pageInfo = $("#browsePageInfo");
  const searchInput = $("#browseSearch") as HTMLInputElement;

  let currentPage = 1;
  let totalPages = 1;
  let searchMode: { keywords: string; parent: string; page: number; totalPages: number } | null = null;

  async function loadDir(dir: string, page: number): Promise<void> {
    handlers.onStatus(`正在浏览 ${dir} …`);
    try {
      const qp = new URLSearchParams({ room: handlers.roomId, path: dir, page: String(page) });
      const data = await authedGet(handlers, `/api/browse?${qp}`);
      searchMode = null;
      currentPage = Number(data.page ?? 1);
      totalPages = Number(data.totalPages ?? 1);
      pathInput.value = String(data.path ?? dir);
      renderList(
        (data.content as BrowseItem[]) ?? [],
        (item) => (item.isDir ? loadDir(item.path, 1) : pick(item.path, item.name, item.size)),
      );
      handlers.onStatus(`目录 ${String(data.path ?? dir)}（第 ${currentPage}/${totalPages} 页）`);
    } catch (err) {
      handlers.onStatus(`浏览失败：${err instanceof Error ? err.message : err}`, true);
    }
  }

  async function doSearch(keywords: string, parent: string, page: number): Promise<void> {
    handlers.onStatus(`正在搜索「${keywords}」…`);
    try {
      const qp = new URLSearchParams({ room: handlers.roomId, keywords, parent, page: String(page) });
      const data = await authedGet(handlers, `/api/search?${qp}`);
      const items = ((data.content as SearchItem[]) ?? []).map((c) => ({
        name: c.name,
        path: c.parent && c.parent !== "/" ? `${c.parent.replace(/\/+$/, "")}/${c.name}` : `/${c.name}`,
        isDir: c.isDir,
        size: c.size,
      }));
      searchMode = { keywords, parent, page: Number(data.page ?? 1), totalPages: Number(data.totalPages ?? 1) };
      renderList(items, (item) => (item.isDir ? loadDir(item.path, 1) : pick(item.path, item.name, item.size)));
      handlers.onStatus(`搜索「${keywords}」：${items.length} 条结果（第 ${searchMode.page}/${searchMode.totalPages} 页）`);
    } catch (err) {
      handlers.onStatus(`搜索失败：${err instanceof Error ? err.message : err}`, true);
    }
  }

  function renderList(items: BrowseItem[], onClick: (item: BrowseItem) => void): void {
    listEl.textContent = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "browse-empty";
      empty.textContent = "（空）";
      listEl.appendChild(empty);
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "browse-row";
      const icon = document.createElement("span");
      icon.className = "browse-icon";
      icon.innerHTML = item.isDir ? iconSvg("folder") : iconSvg("file");
      const name = document.createElement("span");
      name.className = "browse-name";
      name.textContent = item.name;
      const size = document.createElement("span");
      size.className = "browse-size";
      size.textContent = item.isDir ? "" : fmtSize(item.size);
      row.append(icon, name, size);
      if (!item.isDir && VIDEO_EXTS.has(extOf(item.name))) {
        row.classList.add("video");
        // 整行可点（不仅是「选片」按钮）
        row.addEventListener("click", () => onClick(item));
        const btn = document.createElement("button");
        btn.className = "browse-pick";
        btn.textContent = "选片";
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          onClick(item);
        });
        row.appendChild(btn);
      } else if (item.isDir) {
        row.addEventListener("click", () => onClick(item));
      }
      listEl.appendChild(row);
    }
    updatePager();
  }

  function updatePager(): void {
    const page = searchMode ? searchMode.page : currentPage;
    const pages = searchMode ? searchMode.totalPages : totalPages;
    pageInfo.textContent = `第 ${page}/${pages} 页`;
    ($("#browsePrev") as HTMLButtonElement).disabled = page <= 1;
    ($("#browseNext") as HTMLButtonElement).disabled = page >= pages;
  }

  function pick(path: string, name: string, size: number): void {
    handlers.onPick({ path, name, size });
  }

  $("#browseGo").addEventListener("click", () => void loadDir(pathInput.value.trim() || "/", 1));
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void loadDir(pathInput.value.trim() || "/", 1);
  });
  $("#browseUp").addEventListener("click", () => {
    const p = pathInput.value.trim() || "/";
    const i = p.replace(/\/+$/, "").lastIndexOf("/");
    void loadDir(i <= 0 ? "/" : p.slice(0, i), 1);
  });
  $("#browseSearchBtn").addEventListener("click", () => {
    const kw = searchInput.value.trim();
    if (kw) void doSearch(kw, pathInput.value.trim() || "/", 1);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const kw = searchInput.value.trim();
      if (kw) void doSearch(kw, pathInput.value.trim() || "/", 1);
    }
  });
  $("#browsePrev").addEventListener("click", () => {
    if (searchMode) void doSearch(searchMode.keywords, searchMode.parent, searchMode.page - 1);
    else void loadDir(pathInput.value.trim() || "/", currentPage - 1);
  });
  $("#browseNext").addEventListener("click", () => {
    if (searchMode) void doSearch(searchMode.keywords, searchMode.parent, searchMode.page + 1);
    else void loadDir(pathInput.value.trim() || "/", currentPage + 1);
  });

  // 初始加载根目录
  void loadDir("/", 1);
}
