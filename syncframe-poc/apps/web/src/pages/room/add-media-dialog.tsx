/**
 * 「添加影片」弹窗（仅房主）：直链 / B 站链接 / OpenList 媒体库 / OpenList 路径。
 * 行为对齐旧 room.html 的 addMediaModal。
 */

import { useMemo, useState } from "react";
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
import { loadBiliSessdata } from "@/bili-credential.ts";
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

  const openlist = useMemo(() => providers.filter((p) => p.kind === "openlist"), [providers]);
  const biliBound = loadBiliSessdata() !== null;

  const submitDirect = async (): Promise<void> => {
    if (!directUrl.trim()) return;
    const ok = await actions.registerMedia({ provider: "direct", name: directName.trim(), url: directUrl.trim() });
    if (ok) setDirectUrl("");
  };

  const submitBili = async (): Promise<void> => {
    if (!biliUrl.trim()) return;
    const ok = await actions.registerMedia({ provider: "bilibili", url: biliUrl.trim() });
    if (ok) setBiliUrl("");
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
              <Select defaultValue="bilibili">
                <SelectTrigger aria-label="B 站来源">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bilibili">
                    {biliBound ? "使用本浏览器绑定的 B 站账号" : "匿名（未绑定，画质上限 480P）"}
                  </SelectItem>
                  {!biliBound && (
                    <SelectItem value="__hint" disabled>
                      （扫码绑定后画质更高：账户设置 → 哔哩哔哩）
                    </SelectItem>
                  )}
                  {providers
                    .filter((x) => x.kind === "bilibili")
                    .map((p) => (
                      <SelectItem key={p.id} value={`bilibili:${p.id}`}>
                        {p.label}（使用本浏览器 B 站凭证）
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Input
                className="mt-2"
                placeholder="B 站视频：BV 号 / av 号 / 视频或番剧（ep/ss）链接"
                value={biliUrl}
                onChange={(e) => setBiliUrl(e.target.value)}
              />
              <Button className="mt-3 w-full" onClick={() => void submitBili()}>
                添加到播放列表
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
                          （登录后可配置更多 provider）
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

            <p className={`mt-3 min-h-4 text-xs ${msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`} role="status">
              {msg.text}
            </p>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              需要添加 OpenList / B 站凭据？
              <button
                type="button"
                className="text-primary underline"
                onClick={() => (location.href = "/settings.html")}
              >
                点击打开账户设置
              </button>
              （也可点顶栏自己的昵称）
            </p>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
