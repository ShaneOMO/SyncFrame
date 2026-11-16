/**
 * 「添加影片」弹窗（仅房主）：直链 / B 站链接 / OpenList 媒体库 / OpenList 路径。
 * 行为对齐旧 room.html 的 addMediaModal。
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BrowsePanel } from "@/pages/room/browse-panel.tsx";
import { getLocalBiliStatus, resolveLocalBiliVideo, type LocalBiliStatus } from "@/bili-local.ts";
import type { PublicProvider, RoomActions } from "@/pages/room/useRoom.ts";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  memberToken: string;
  userToken: string | null;
  providers: PublicProvider[];
  actions: RoomActions;
  msg: { text: string; ok: boolean };
  onStatus: (line: string, warn?: boolean) => void;
}

export function AddMediaDialog({ open, onOpenChange, roomId, memberToken, userToken, providers, actions, msg, onStatus }: Props) {
  const [directName, setDirectName] = useState("");
  const [directUrl, setDirectUrl] = useState("");
  const [biliUrl, setBiliUrl] = useState("");
  const [pathProvider, setPathProvider] = useState("");
  const [pathValue, setPathValue] = useState("");
  const [browseProvider, setBrowseProvider] = useState("");
  const [biliStatus, setBiliStatus] = useState<LocalBiliStatus>({ available: false, authenticated: false, uname: "" });
  const [biliSubmitting, setBiliSubmitting] = useState(false);

  const openlist = useMemo(() => providers.filter((p) => p.kind === "openlist"), [providers]);

  useEffect(() => {
    if (!open) return;
    void getLocalBiliStatus().then(setBiliStatus).catch(() => {
      setBiliStatus({ available: false, authenticated: false, uname: "" });
    });
  }, [open]);

  const submitDirect = async (): Promise<void> => {
    if (!directUrl.trim()) return;
    const ok = await actions.registerMedia({ provider: "direct", name: directName.trim(), url: directUrl.trim() });
    if (ok) setDirectUrl("");
  };

  const submitBili = async (): Promise<void> => {
    if (!biliUrl.trim() || biliSubmitting) return;
    setBiliSubmitting(true);
    onStatus("正在通过本机助手解析 B 站视频…");
    try {
      const info = await resolveLocalBiliVideo(biliUrl.trim());
      const ok = await actions.registerMedia({ provider: "bilibili", name: info.name, bilibili: info.bilibili });
      if (ok) setBiliUrl("");
    } catch (err) {
      onStatus(`B 站视频添加失败：${err instanceof Error ? err.message : err}`, true);
    } finally {
      setBiliSubmitting(false);
    }
  };

  const submitPath = async (): Promise<void> => {
    if (!pathProvider) return;
    if (!pathValue.trim()) return;
    const ok = await actions.registerMedia({ provider: pathProvider, path: pathValue.trim() });
    if (ok) setPathValue("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[84vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>添加影片</DialogTitle>
          <DialogDescription className="sr-only">直链、B 站链接或 OpenList 媒体库</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="direct" orientation="vertical" className="flex flex-col gap-4 sm:flex-row">
          <TabsList className="h-auto flex-row justify-start overflow-x-auto sm:w-[132px] sm:flex-col sm:items-stretch sm:justify-start">
            <TabsTrigger value="direct" className="justify-start sm:justify-start">
              直链
            </TabsTrigger>
            <TabsTrigger value="bili" className="justify-start">
              B 站链接
            </TabsTrigger>
            {openlist.length > 0 && (
              <>
                <TabsTrigger value="openlist" className="justify-start">
                  OpenList 媒体库
                </TabsTrigger>
                <TabsTrigger value="path" className="justify-start">
                  OpenList 路径
                </TabsTrigger>
              </>
            )}
          </TabsList>

          <div className="min-w-0 flex-1">
            <TabsContent value="direct">
              <Input
                placeholder="视频名称（可选）"
                maxLength={128}
                value={directName}
                onChange={(e) => setDirectName(e.target.value)}
              />
              <Input
                className="mt-2"
                placeholder="直链视频地址（http/https）"
                value={directUrl}
                onChange={(e) => setDirectUrl(e.target.value)}
              />
              <Button className="mt-3 w-full" onClick={() => void submitDirect()}>
                添加到播放列表
              </Button>
            </TabsContent>

            <TabsContent value="bili">
              <p className="text-xs leading-6 text-muted-foreground">
                {biliStatus.authenticated
                  ? `本机已登录${biliStatus.uname ? `：${biliStatus.uname}` : ""}，按账号权限解析画质。`
                  : biliStatus.available
                    ? "本机助手已运行，但尚未登录 B 站；请先到账户设置扫码。"
                    : "未连接本机助手，请运行 npm run p1:local；B 站不支持匿名播放。"}
              </p>
              <Input
                className="mt-2"
                placeholder="B 站链接或 BV / av 号（也支持 ep / ss 番剧链接）"
                value={biliUrl}
                onChange={(e) => setBiliUrl(e.target.value)}
              />
              <Button className="mt-3 w-full" disabled={biliSubmitting || !biliStatus.authenticated} onClick={() => void submitBili()}>
                {biliSubmitting ? "本机解析中…" : "添加到播放列表"}
              </Button>
            </TabsContent>

            {openlist.length > 0 && (
              <>
                <TabsContent value="openlist">
                  <BrowsePanel
                    roomId={roomId}
                    getToken={() => memberToken}
                    getUserToken={() => userToken}
                    providerId={browseProvider || openlist[0].id}
                    onProviderChange={setBrowseProvider}
                    openlistProviders={openlist}
                    onPick={(file) => void actions.pickBrowseFile(file, browseProvider || openlist[0].id)}
                    onStatus={(line, warn) => {
                      onStatus(line, warn);
                    }}
                  />
                </TabsContent>

                <TabsContent value="path">
                  <Select value={pathProvider || openlist[0].id} onValueChange={setPathProvider}>
                    <SelectTrigger aria-label="选择 OpenList provider">
                      <SelectValue placeholder="选择 OpenList provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {openlist.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.label}（{p.baseUrl}）
                        </SelectItem>
                      ))}
                      {!userToken && (
                        <SelectItem value="__hint" disabled>
                          （登录后可以配置更多视频源）
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <Input
                    className="mt-2"
                    placeholder="OpenList 文件路径，如 /movies/a.mkv"
                    value={pathValue}
                    onChange={(e) => setPathValue(e.target.value)}
                  />
                  <Button className="mt-3 w-full" onClick={() => void submitPath()}>
                    添加到播放列表
                  </Button>
                </TabsContent>
              </>
            )}

            <p className={`mt-3 min-h-4 break-words text-xs ${msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`} role="status">
              {msg.text}
            </p>
            <p className="mt-2 text-xs leading-6 break-words text-muted-foreground">
              要添加 OpenList / B 站凭据？
              <button
                type="button"
                className="text-primary underline"
                onClick={() => (location.href = "/settings.html")}
              >
                打开账户设置
              </button>
              （也可以点顶栏自己的昵称）
            </p>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
