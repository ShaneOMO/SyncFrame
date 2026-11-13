/**
 * 房主媒体库面板（React 版，行为对齐旧 browse.ts）：
 * OpenList 目录浏览 / 搜索 / 分页；点选视频 → onPick。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, File, Folder, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface BrowseItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

interface SearchItem {
  name: string;
  parent: string;
  isDir: boolean;
  size: number;
}

const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".ts", ".m4v", ".webm", ".mpg", ".mpeg", ".rmvb"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

export function fmtSize(bytes: number): string {
  if (bytes <= 0) return "-";
  const mib = bytes / 1024 / 1024;
  return mib >= 1024 ? `${(mib / 1024).toFixed(2)} GiB` : `${mib.toFixed(1)} MiB`;
}

interface Props {
  roomId: string;
  getToken: () => string;
  getUserToken: () => string | null;
  providerId: string;
  onProviderChange: (id: string) => void;
  openlistProviders: { id: string; label: string; baseUrl?: string }[];
  onPick: (file: { path: string; name: string; size: number }) => void;
  onStatus: (line: string, warn?: boolean) => void;
}

export function BrowsePanel({ roomId, getToken, getUserToken, providerId, onProviderChange, openlistProviders, onPick, onStatus }: Props) {
  const [path, setPath] = useState("/");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<BrowseItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const searchMode = useRef<{ keywords: string; parent: string } | null>(null);

  const authedGet = useCallback(async (url: string): Promise<Record<string, unknown>> => {
    const userToken = getUserToken();
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${getToken()}`,
        ...(userToken ? { "X-User-Token": userToken } : {}),
      },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
    }
    return data;
  }, [getToken, getUserToken]);

  const loadDir = useCallback(async (dir: string, p: number): Promise<void> => {
    onStatus(`正在浏览 ${dir} …`);
    try {
      const qp = new URLSearchParams({ room: roomId, provider: providerId, path: dir, page: String(p) });
      const data = await authedGet(`/api/browse?${qp}`);
      searchMode.current = null;
      const cur = Number(data.page ?? 1);
      const total = Number(data.totalPages ?? 1);
      const content = (data.content as BrowseItem[]) ?? [];
      setItems(content);
      setPath(String(data.path ?? dir));
      setPage(cur);
      setTotalPages(total);
      onStatus(`目录 ${String(data.path ?? dir)}（第 ${cur}/${total} 页）`);
    } catch (err) {
      onStatus(`浏览失败：${err instanceof Error ? err.message : err}`, true);
    }
  }, [roomId, providerId, authedGet, onStatus]);

  const doSearch = useCallback(async (keywords: string, parent: string, p: number): Promise<void> => {
    onStatus(`正在搜索「${keywords}」…`);
    try {
      const qp = new URLSearchParams({ room: roomId, provider: providerId, keywords, parent, page: String(p) });
      const data = await authedGet(`/api/search?${qp}`);
      const raw = ((data.content as SearchItem[]) ?? []).map((c) => ({
        name: c.name,
        path: c.parent && c.parent !== "/" ? `${c.parent.replace(/\/+$/, "")}/${c.name}` : `/${c.name}`,
        isDir: c.isDir,
        size: c.size,
      }));
      const cur = Number(data.page ?? 1);
      const total = Number(data.totalPages ?? 1);
      searchMode.current = { keywords, parent };
      setItems(raw);
      setPage(cur);
      setTotalPages(total);
      onStatus(`搜索「${keywords}」：${raw.length} 条结果（第 ${cur}/${total} 页）`);
    } catch (err) {
      onStatus(`搜索失败：${err instanceof Error ? err.message : err}`, true);
    }
  }, [roomId, providerId, authedGet, onStatus]);

  // provider 切换 / 首次挂载时重载根目录。
  const first = useRef(true);
  useEffect(() => {
    void loadDir("/", 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const goUp = (): void => {
    const p = path.trim() || "/";
    const i = p.replace(/\/+$/, "").lastIndexOf("/");
    void loadDir(i <= 0 ? "/" : p.slice(0, i), 1);
  };

  const goPage = (p: number): void => {
    if (searchMode.current) void doSearch(searchMode.current.keywords, searchMode.current.parent, p);
    else void loadDir(path.trim() || "/", p);
  };

  void first;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-[180px] flex-1 items-center gap-2">
          <Select value={providerId} onValueChange={onProviderChange}>
            <SelectTrigger aria-label="选择 OpenList provider">
              <SelectValue placeholder="选择 OpenList provider" />
            </SelectTrigger>
            <SelectContent>
              {openlistProviders.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}（{p.baseUrl}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" className="size-8 shrink-0" title="上级目录" aria-label="上级目录" onClick={goUp}>
          <ArrowUp className="size-4" />
        </Button>
        <Input
          className="min-w-0 flex-1"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void loadDir(path.trim() || "/", 1);
          }}
          aria-label="目录路径"
        />
        <Button
          variant="outline"
          onClick={() => void loadDir(path.trim() || "/", 1)}
        >
          进入
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          className="min-w-0 flex-1"
          placeholder="搜索文件名…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && search.trim()) void doSearch(search.trim(), path.trim() || "/", 1);
          }}
          aria-label="搜索文件名"
        />
        <Button
          variant="outline"
          onClick={() => {
            if (search.trim()) void doSearch(search.trim(), path.trim() || "/", 1);
          }}
        >
          <Search className="size-4" />
          搜索
        </Button>
        <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => goPage(page - 1)}>
          上一页
        </Button>
        <span className="self-center text-xs text-muted-foreground">
          第 {page}/{totalPages} 页
        </span>
        <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => goPage(page + 1)}>
          下一页
        </Button>
      </div>
      <div className="mt-2 max-h-[300px] overflow-y-auto rounded-lg border bg-background">
        {items.length === 0 ? (
          <div className="py-5 text-center text-sm text-muted-foreground">（空）</div>
        ) : (
          items.map((item) => {
            const isVideo = !item.isDir && VIDEO_EXTS.has(extOf(item.name));
            const clickable = item.isDir || isVideo;
            return (
              <div
                key={item.path}
                className={
                  clickable
                    ? "flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 transition-colors last:border-b-0 hover:bg-muted/60"
                    : "flex cursor-default items-center gap-2 border-b px-3 py-1.5 last:border-b-0"
                }
                onClick={() => {
                  if (item.isDir) void loadDir(item.path, 1);
                  else if (isVideo) onPick(item);
                }}
              >
                <span className="shrink-0 text-muted-foreground">
                  {item.isDir ? <Folder className="size-4" /> : <File className="size-4" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{item.isDir ? "" : fmtSize(item.size)}</span>
                {isVideo && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-6 px-3 text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPick(item);
                    }}
                  >
                    添加
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
