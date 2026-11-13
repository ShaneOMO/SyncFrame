/**
 * 大厅页（React 版，行为与旧 lobby-main.ts 对齐）：
 * - 房间列表：GET /api/rooms，15s 轮询刷新；行右侧「直接加入」预填加入弹窗；
 * - 「创建房间 / 加入房间」弹窗；创建需登录，房间名必填，可自定义房间号/访问码；
 * - 右上角用户按钮：未登录 → 登录弹窗；已登录 → 跳转设置页；管理员额外有「用户管理」；
 * - 邀请链接 ?room=<id>&key=<code> 自动加入；成员令牌写入 sessionStorage 后跳房间页。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LogIn, Play, Plus, RefreshCw, Trash2, Users, Video } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { ToastProvider, useToast } from "@/components/toaster";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { postJson } from "@/lib/api";
import { clearUser, loadUser, saveUser, userHeaders, type LocalUser } from "@/lib/user";
import { saveSession } from "@/session.ts";

interface RoomSummary {
  roomId: string;
  roomName: string;
  hostName: string;
  createdAt: number;
  memberCount: number;
  mediaCount: number;
  hasInvite: boolean;
  deletable: boolean;
}

const params = new URLSearchParams(location.search);
const linkKey = params.get("key");

function enterRoom(roomId: string, data: Record<string, unknown>, name: string): void {
  saveSession({
    roomId,
    memberToken: String(data.memberToken),
    clientId: String(data.clientId),
    role: data.role === "host" ? "host" : "viewer",
    name,
    expiresAt: Number(data.expiresAt ?? 0),
    ...(typeof data.roomName === "string" && data.roomName ? { roomName: data.roomName } : {}),
    ...(typeof data.hostSecret === "string" ? { hostSecret: data.hostSecret } : {}),
  });
  location.href = `/room.html?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name)}`;
}

function LobbyPage() {
  const { toast } = useToast();

  // ── 用户 / 登录态 ─────────────────────────────────────
  const [user, setUser] = useState<LocalUser | null>(loadUser);
  const [isAdmin, setIsAdmin] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authErr, setAuthErr] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const refreshAuthState = useCallback(async (current: LocalUser | null) => {
    if (!current) {
      setIsAdmin(false);
      return;
    }
    try {
      const res = await fetch("/api/me", { headers: userHeaders(current) });
      if (!res.ok) throw new Error("expired");
      const body = (await res.json()) as { username: string; role?: string };
      const next = { token: current.token, username: body.username };
      saveUser(next);
      setUser(next);
      setIsAdmin(body.role === "admin");
    } catch {
      // 服务端重启等导致令牌失效：清理本地状态回登录态。
      clearUser();
      setUser(null);
      setIsAdmin(false);
    }
  }, []);

  useEffect(() => {
    void refreshAuthState(user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitLogin = async () => {
    setAuthErr("");
    setAuthBusy(true);
    try {
      const data = await postJson("/api/auth/login", { username: authUsername, password: authPassword });
      const next: LocalUser = {
        token: String(data.userToken),
        username: String(data.username ?? authUsername).trim(),
      };
      saveUser(next);
      setUser(next);
      setAuthPassword("");
      setAuthOpen(false);
      await refreshAuthState(next);
      toast(`已登录 ${next.username}，点右上角头像管理视频源（OpenList / B 站）`);
    } catch (err) {
      setAuthErr(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  // ── 房间列表 ──────────────────────────────────────────
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [roomsError, setRoomsError] = useState(false);
  const userRef = useRef(user);
  userRef.current = user;

  const refreshRoomList = useCallback(async () => {
    try {
      const res = await fetch("/api/rooms", { headers: userHeaders(userRef.current) });
      const body = (await res.json().catch(() => ({}))) as { rooms?: RoomSummary[] };
      setRooms(body.rooms ?? []);
      setRoomsError(false);
    } catch {
      setRooms([]);
      setRoomsError(true);
    }
  }, []);

  useEffect(() => {
    void refreshRoomList();
    const timer = window.setInterval(() => void refreshRoomList(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshRoomList]);

  const [deleteTarget, setDeleteTarget] = useState<RoomSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const deleteRoom = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(deleteTarget.roomId)}`, {
        method: "DELETE",
        headers: userHeaders(userRef.current),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(`删除失败：${body.error ?? `HTTP ${res.status}`}`);
        return;
      }
      toast(`房间「${deleteTarget.roomId}」已移除`);
      await refreshRoomList();
    } catch (err) {
      toast(`删除失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  };

  // ── 创建房间弹窗 ──────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createRoomId, setCreateRoomId] = useState("");
  const [createHasInvite, setCreateHasInvite] = useState(true);
  const [createInvite, setCreateInvite] = useState("");
  const [createErr, setCreateErr] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  const openCreate = () => {
    setCreateErr("");
    if (!user) {
      setAuthOpen(true);
      return;
    }
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    setCreateErr("");
    if (!user) {
      setCreateOpen(false);
      setAuthOpen(true);
      return;
    }
    const name = createName.trim();
    if (!name) {
      setCreateErr("请填写房间名");
      return;
    }
    setCreateBusy(true);
    try {
      const data = await postJson(
        "/api/rooms",
        { name, roomId: createRoomId.trim(), inviteCode: createInvite.trim(), noInvite: !createHasInvite },
        user.token,
      );
      const newRoomId = String(data.roomId);
      // 邀请码/hostSecret 只在创建响应出现一次：存档供房间页展示与房主重建会话。
      if (typeof data.inviteCode === "string" && data.inviteCode) {
        sessionStorage.setItem(`syncframe-invite-${newRoomId}`, data.inviteCode);
      } else {
        sessionStorage.removeItem(`syncframe-invite-${newRoomId}`);
      }
      sessionStorage.setItem(`syncframe-hostsecret-${newRoomId}`, String(data.hostSecret));
      enterRoom(newRoomId, data, name);
    } catch (err) {
      setCreateErr(`创建失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setCreateBusy(false);
    }
  };

  // ── 加入房间弹窗 ──────────────────────────────────────
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinRoom, setJoinRoom] = useState(params.get("room") ?? "");
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinErr, setJoinErr] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const joinBtnRef = useRef<HTMLButtonElement>(null);

  const openJoin = (roomId?: string) => {
    setJoinErr("");
    if (roomId !== undefined) setJoinRoom(roomId);
    setJoinOpen(true);
  };

  /** 加入房间核心逻辑：手动提交与邀请链接自动加入共用（不依赖弹窗内的按钮 ref）。 */
  const doJoin = async (roomIdRaw: string, codeRaw: string, nameRaw: string) => {
    setJoinErr("");
    const roomId = roomIdRaw.trim().toLowerCase();
    const trimmedCode = codeRaw.trim();
    const code = trimmedCode ? trimmedCode.toUpperCase() : undefined;
    // 昵称留空时服务端会回落到登录用户名（未登录才是 Guest）。
    const name = nameRaw.trim();
    if (!roomId) {
      setJoinErr("请填写房间号");
      return;
    }
    setJoinBusy(true);
    try {
      // 房主重建会话：本浏览器若持有该房间的 hostSecret，自动带上。
      const hostSecret = sessionStorage.getItem(`syncframe-hostsecret-${roomId}`) ?? undefined;
      const data = await postJson(
        `/api/rooms/${encodeURIComponent(roomId)}/join`,
        {
          name,
          ...(code ? { inviteCode: code } : {}),
          ...(hostSecret ? { hostSecret } : {}),
        },
        userRef.current?.token,
      );
      enterRoom(roomId, data, typeof data.name === "string" && data.name ? data.name : name || "Guest");
    } catch (err) {
      setJoinErr(`加入失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setJoinBusy(false);
    }
  };

  const submitJoin = () => void doJoin(joinRoom, joinCode, joinName);

  // 邀请链接自动加入（?room=&key=）：游客点开链接直接进房，无需任何点击。
  // 注意不能用 ref 防重入：StrictMode 开发态会「 effect → cleanup → effect 」，
  // ref 防重入会让第二次 effect 直接返回，而第一次的定时器已被 cleanup 清掉，导致永远不触发。
  // 正确模式：effect 里总是调度、cleanup 清理，重挂载后自然只生效一次。
  useEffect(() => {
    const linkRoom = params.get("room");
    if (!linkRoom || !linkKey) return;
    setJoinRoom(linkRoom);
    setJoinCode(linkKey);
    const linkName = params.get("name") ?? "";
    if (linkName) setJoinName(linkName);
    // 打开弹窗展示进度/错误（失败时用户可直接在弹窗里重试）。
    setJoinOpen(true);
    // 等首帧渲染后触发，与旧版 click() 时序等价。
    const t = window.setTimeout(() => void doJoin(linkRoom, linkKey, linkName), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen">
      <AppHeader>
        {isAdmin && (
          <Button variant="ghost" size="sm" onClick={() => (location.href = "/settings.html#users")}>
            <Users className="size-3.5" />
            用户管理
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => (user ? (location.href = "/settings.html") : setAuthOpen(true))}>
          <LogIn className="size-3.5" />
          {user ? user.username : "登录"}
        </Button>
      </AppHeader>

      <main className="mx-auto w-full max-w-2xl px-4 pb-24 pt-16 sm:pt-24">
        {/* 首屏：一个核心信息 + 主行动 */}
        <div className="mb-14 text-center sm:mb-16">
          <Badge variant="outline" className="mb-4 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-widest">
            SyncFrame
          </Badge>
          <h1 className="mb-3 text-3xl font-bold tracking-tight sm:text-4xl">和朋友，同步看每一帧</h1>
          <p className="mx-auto max-w-[40ch] text-sm leading-7 text-muted-foreground">
            开一个房间，把链接丢给朋友。点开就进房，播放、暂停、进度全程同步。
          </p>
          {params.get("expired") && (
            <p className="mt-4 text-sm text-amber-600 dark:text-amber-400">房间会话已过期，请重新加入</p>
          )}
        </div>

        <div className="mb-10 flex justify-center gap-3">
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            创建房间
          </Button>
          <Button variant="outline" onClick={() => openJoin()}>
            <LogIn className="size-4" />
            加入房间
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Video className="size-4 text-muted-foreground" />
              进行中的房间
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {rooms !== null && rooms.length > 0 ? `${rooms.length} 个房间` : ""}
              </span>
            </CardTitle>
            <CardDescription>正在同步观影的房间。点「立即加入」即可进房；游客点开房主分享的链接可免输入直接进。</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-lg border">
              {rooms === null ? (
                <div className="py-5 text-center text-sm text-muted-foreground">加载中…</div>
              ) : roomsError ? (
                <div className="py-5 text-center text-sm text-muted-foreground">房间列表加载失败，请稍后重试</div>
              ) : rooms.length === 0 ? (
                <div className="py-5 text-center text-sm text-muted-foreground">
                  还没有房间，来开第一个吧。房间只会在被删除后消失。
                </div>
              ) : (
                rooms.map((r) => (
                  <div
                    key={r.roomId}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3.5 transition-colors last:border-b-0 hover:bg-muted/50"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {r.roomName}
                      <span className="ml-1 font-normal text-muted-foreground">· {r.hostName}</span>
                    </span>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      {r.memberCount} 人在线 · {r.mediaCount} 个视频
                    </span>
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={() => openJoin(r.roomId)}>
                        <Play className="size-3.5" />
                        立即加入
                      </Button>
                      {r.deletable && (
                        <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(r)}>
                          <Trash2 className="size-3.5" />
                          删除
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void refreshRoomList()}>
              <RefreshCw className="size-3" />
              刷新
            </Button>
          </CardContent>
        </Card>

        <p className="mt-10 break-words border-t pt-6 text-center text-xs leading-7 text-muted-foreground">
          进房后，房主点「添加影片」加入直链、B 站或 OpenList 片源，播放、暂停、进度、倍速全员同步。
          <br />
          房间会话保存在浏览器中，过期后回到本页重新加入即可。
        </p>
      </main>

      {/* 登录弹窗 */}
      <Dialog open={authOpen} onOpenChange={setAuthOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">登录</DialogTitle>
            <DialogDescription>
              没有账户？联系管理员开通。游客无需账户，点邀请链接就能进房观看。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="auth-username">用户名</Label>
              <Input
                id="auth-username"
                maxLength={24}
                autoComplete="username"
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="auth-password">密码</Label>
              <Input
                id="auth-password"
                type="password"
                maxLength={64}
                autoComplete="current-password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitLogin();
                }}
              />
            </div>
            <Button className="w-full" disabled={authBusy} onClick={() => void submitLogin()}>
              登录
            </Button>
            {authErr && (
              <p className="min-h-4 text-xs text-amber-600 dark:text-amber-400" role="status">
                {authErr}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 创建房间弹窗 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              创建房间
              <Badge variant="outline" className="ml-auto rounded-full border-amber-500/30 text-amber-600 dark:text-amber-400">
                需登录
              </Badge>
            </DialogTitle>
            <DialogDescription>当房主：添加直链、B 站或 OpenList 影片，播放节奏由你掌控。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="create-name">房间名（必填，会显示在房间列表）</Label>
              <Input
                id="create-name"
                maxLength={24}
                placeholder="例如：周末电影夜"
                autoComplete="off"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-roomid">
                房间号 <span className="font-normal text-muted-foreground">（可选，3-24 位字母/数字/连字符）</span>
              </Label>
              <Input
                id="create-roomid"
                maxLength={24}
                placeholder="留空则自动生成"
                autoComplete="off"
                value={createRoomId}
                onChange={(e) => setCreateRoomId(e.target.value)}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
              <Checkbox checked={createHasInvite} onCheckedChange={(v) => setCreateHasInvite(v === true)} />
              生成访问码 <span className="text-muted-foreground">（只限制游客；登录用户凭房间号就能加入）</span>
            </label>
            {createHasInvite && (
              <div className="space-y-2">
                <Label htmlFor="create-invite">
                  访问码（邀请码） <span className="font-normal text-muted-foreground">（可选，4-16 位字母/数字）</span>
                </Label>
                <Input
                  id="create-invite"
                  maxLength={16}
                  placeholder="留空则自动生成"
                  autoComplete="off"
                  value={createInvite}
                  onChange={(e) => setCreateInvite(e.target.value)}
                />
              </div>
            )}
            <Button className="w-full" disabled={createBusy} onClick={() => void submitCreate()}>
              创建房间
            </Button>
            {createErr && (
              <p className="min-h-4 text-xs text-amber-600 dark:text-amber-400" role="status">
                {createErr}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 加入房间弹窗 */}
      <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>加入房间</DialogTitle>
            <DialogDescription>一般点房主发的链接就能直接进房，这里也可以手动输入房间号和访问码。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="join-room">房间号</Label>
              <Input
                id="join-room"
                maxLength={24}
                placeholder="例如：movie-night"
                autoComplete="off"
                value={joinRoom}
                onChange={(e) => setJoinRoom(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="join-code">
                访问码 <span className="font-normal text-muted-foreground">（游客必填，登录用户可留空）</span>
              </Label>
              <Input
                id="join-code"
                maxLength={16}
                placeholder="邀请码"
                autoComplete="off"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="join-name">你的昵称</Label>
              <Input
                id="join-name"
                maxLength={24}
                placeholder={user ? `${user.username}（留空用登录名）` : "例如：小红"}
                autoComplete="nickname"
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") joinBtnRef.current?.click();
                }}
              />
            </div>
            <Button ref={joinBtnRef} className="w-full" disabled={joinBusy} onClick={() => void submitJoin()}>
              加入房间
            </Button>
            {joinErr && (
              <p className="min-h-4 text-xs text-amber-600 dark:text-amber-400" role="status">
                {joinErr}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除房间确认 */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除房间「{deleteTarget?.roomName}」？</AlertDialogTitle>
            <AlertDialogDescription>删除后无法恢复，房间内所有成员都会被请出。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={deleteBusy} onClick={(e) => {
              e.preventDefault();
              void deleteRoom();
            }}>
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function LobbyApp() {
  return (
    <ToastProvider>
      <LobbyPage />
    </ToastProvider>
  );
}
