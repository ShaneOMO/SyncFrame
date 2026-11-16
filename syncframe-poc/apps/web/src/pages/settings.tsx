/**
 * 账户设置页（React 版，行为对齐旧 settings-main.ts）：
 * - 视频 Provider 管理：OpenList 增删（全量替换）、B 站本机会话 + 扫码登录；
 * - 管理员「用户管理」：账户表 / 创建 / 重置密码 / 删除；
 * - 页签走 URL hash（#providers / #users），大厅管理员入口 #users 直达不变。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, LogOut, Trash2, UserPlus, Users, Video } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { ToastProvider, useToast } from "@/components/toaster";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BiliLocalError,
  clearLocalBiliSession,
  getLocalBiliStatus,
  pollLocalBiliLogin,
  startLocalBiliLogin,
  validateLocalBiliSession,
  type LocalBiliStatus,
} from "@/bili-local.ts";
import { loadUser as loadLocalUser, clearUser, type LocalUser } from "@/lib/user.ts";

interface PublicProvider {
  id: string;
  kind: "openlist" | "bilibili";
  label: string;
  baseUrl?: string;
  username?: string;
  /** 仅在「添加 provider」请求体内使用（服务端签发 id 后不再返回）。 */
  password?: string;
}

interface AdminUser {
  username: string;
  role: "admin" | "user";
  providerCount: number;
}

type Tab = "providers" | "users";

function currentTab(isAdmin: boolean): Tab {
  return location.hash === "#users" && isAdmin ? "users" : "providers";
}

function SettingsPage() {
  const { toast } = useToast();
  const [user, setUser] = useState<LocalUser | null>(loadLocalUser);
  const [isAdmin, setIsAdmin] = useState(false);
  const [me, setMe] = useState<{ username: string; role?: string; providers: PublicProvider[] } | null>(null);
  const [tab, setTab] = useState<Tab>("providers");
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);

  // 表单状态
  const [kind, setKind] = useState<"openlist" | "bilibili">("openlist");
  const [pLabel, setPLabel] = useState("");
  const [pBaseUrl, setPBaseUrl] = useState("");
  const [pUsername, setPUsername] = useState("");
  const [pPassword, setPPassword] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");

  // B 站扫码
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [qrStatus, setQrStatus] = useState("");
  const [qrVisible, setQrVisible] = useState(false);
  const [biliStatus, setBiliStatus] = useState<LocalBiliStatus>({ available: false, authenticated: false, uname: "" });
  const qrPollTimer = useRef<number | null>(null);

  // 删除/重置确认
  const [deleteUserTarget, setDeleteUserTarget] = useState<AdminUser | null>(null);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetPw, setResetPw] = useState("");

  const authHeaders = useCallback((): Record<string, string> => {
    return user ? { Authorization: `Bearer ${user.token}` } : {};
  }, [user]);

  const fetchMe = useCallback(async (): Promise<{ username: string; role?: string; providers: PublicProvider[] } | null> => {
    if (!user) return null;
    try {
      const res = await fetch("/api/me", { headers: authHeaders() });
      if (!res.ok) return null;
      return (await res.json()) as { username: string; role?: string; providers: PublicProvider[] };
    } catch {
      return null;
    }
  }, [user, authHeaders]);

  // 入口：未登录回大厅。
  useEffect(() => {
    if (!loadLocalUser()) {
      location.replace("/lobby.html");
      return;
    }
    void (async () => {
      const m = await fetchMe();
      if (!m) {
        location.replace("/lobby.html");
        return;
      }
      setMe(m);
      setIsAdmin(m.role === "admin");
      syncTab(m.role === "admin");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncTab = (admin: boolean): void => {
    const t = currentTab(admin);
    setTab(t);
    document.title = t === "users" ? "SyncFrame · 用户管理" : "SyncFrame · 账户设置";
  };

  useEffect(() => {
    const onHash = (): void => syncTab(isAdmin);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const switchTab = (t: Tab): void => {
    location.hash = t === "users" ? "#users" : "#providers";
    setTab(t);
    document.title = t === "users" ? "SyncFrame · 用户管理" : "SyncFrame · 账户设置";
  };

  const refreshAdminUsers = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/admin/users", { headers: authHeaders() });
      const body = (await res.json().catch(() => ({}))) as { users?: AdminUser[]; error?: string };
      if (!res.ok || !body.users) {
        toast(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setAdminUsers(body.users);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  }, [authHeaders, toast]);

  useEffect(() => {
    if (isAdmin && tab === "users") void refreshAdminUsers();
  }, [isAdmin, tab, refreshAdminUsers]);

  // ── provider ─────────────────────────────────────────

  const saveProviders = async (next: PublicProvider[]): Promise<boolean> => {
    try {
      const res = await fetch("/api/me/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ providers: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { providers?: PublicProvider[]; error?: string };
      if (!res.ok || !body.providers) {
        toast(body.error ?? `HTTP ${res.status}`);
        return false;
      }
      setMe((m) => (m ? { ...m, providers: body.providers! } : m));
      toast("已保存");
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const onAddProvider = async (): Promise<void> => {
    if (kind === "bilibili") {
      toast("B 站会话由本机助手统一保存，不用添加 provider：直接扫码登录即可");
      return;
    }
    const baseUrl = pBaseUrl.trim();
    const username = pUsername.trim();
    const password = pPassword;
    if (!baseUrl || !username || !password) {
      toast("请填完整的 OpenList 地址、用户名和密码");
      return;
    }
    const m = await fetchMe();
    if (!m) return;
    const next: PublicProvider = { id: "", kind: "openlist", label: pLabel.trim() || "OpenList", baseUrl, username, password };
    const ok = await saveProviders([...m.providers, next]);
    if (ok) {
      setPLabel("");
      setPBaseUrl("");
      setPUsername("");
      setPPassword("");
    }
  };

  // ── B 站本机扫码与会话 ───────────────────────────────

  const refreshBiliStatus = async (validate = true): Promise<void> => {
    try {
      const status = await getLocalBiliStatus();
      setBiliStatus(status);
      if (status.authenticated && validate) {
        try {
          setBiliStatus(await validateLocalBiliSession());
        } catch (err) {
          if (err instanceof BiliLocalError && err.status === 401) {
            setBiliStatus({ available: true, authenticated: false, uname: "" });
          }
          setQrStatus(err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      setBiliStatus({ available: false, authenticated: false, uname: "" });
      setQrStatus(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refreshBiliStatus();
  }, []);

  const clearBiliLogin = async (): Promise<void> => {
    try {
      await clearLocalBiliSession();
      setBiliStatus({ available: true, authenticated: false, uname: "" });
      setQrStatus("已退出本机 B 站账号");
      toast("本机 B 站会话已清除");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const stopQrPolling = (): void => {
    if (qrPollTimer.current !== null) {
      window.clearInterval(qrPollTimer.current);
      qrPollTimer.current = null;
    }
  };

  useEffect(() => stopQrPolling, []);

  const pollBiliQr = async (qrcodeKey: string): Promise<void> => {
    try {
      const body = await pollLocalBiliLogin(qrcodeKey);
      if (body.status === "scanned") {
        setQrStatus("已扫码，请在手机上确认登录…");
      } else if (body.status === "expired") {
        stopQrPolling();
        setQrStatus("二维码已过期，点按钮重新获取");
      } else if (body.status === "confirmed") {
        stopQrPolling();
        setQrVisible(false);
        setBiliStatus({ available: true, authenticated: true, uname: body.uname ?? "" });
        setQrStatus(`登录成功${body.uname ? `：${body.uname}` : ""}，会话已由本机助手保存`);
        toast("B 站账号已登录本机助手，云端不保存会话");
      }
    } catch {
      /* 单次轮询失败忽略，下轮重试。 */
    }
  };

  const startBiliQrLogin = async (): Promise<void> => {
    stopQrPolling();
    setQrVisible(false);
    setQrStatus("正在获取二维码…");
    try {
      const body = await startLocalBiliLogin();
      const { toCanvas } = await import("qrcode");
      if (!canvasRef.current) return;
      await toCanvas(canvasRef.current, body.url, { width: 180, margin: 1 });
      setQrVisible(true);
      setQrStatus("请用哔哩哔哩 App 扫码并确认登录");
      qrPollTimer.current = window.setInterval(() => void pollBiliQr(body.qrcodeKey), 2000);
    } catch (err) {
      setQrStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const biliBound = biliStatus.authenticated;

  // ── 管理员动作 ───────────────────────────────────────

  const createUser = async (): Promise<void> => {
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(body.error ?? `HTTP ${res.status}`);
        return;
      }
      toast(`已创建账户 ${newUsername.trim()}`);
      setNewUsername("");
      setNewPassword("");
      void refreshAdminUsers();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteUser = async (): Promise<void> => {
    if (!deleteUserTarget) return;
    try {
      const r = await fetch(`/api/admin/users/${encodeURIComponent(deleteUserTarget.username)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      toast(r.ok ? `已删除 ${deleteUserTarget.username}` : (b.error ?? `HTTP ${r.status}`));
      if (r.ok) void refreshAdminUsers();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteUserTarget(null);
    }
  };

  const resetPassword = async (): Promise<void> => {
    if (!resetTarget) return;
    try {
      const r = await fetch(`/api/admin/users/${encodeURIComponent(resetTarget.username)}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ password: resetPw }),
      });
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      toast(r.ok ? `已重置 ${resetTarget.username} 的密码` : (b.error ?? `HTTP ${r.status}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setResetTarget(null);
      setResetPw("");
    }
  };

  if (!user || !me) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">加载中…</div>;  }

  const providers = me.providers;

  return (
    <div className="min-h-screen">
      <AppHeader>
        <a href="/lobby.html">
          <Button variant="ghost" size="sm">
            ← 返回大厅
          </Button>
        </a>
      </AppHeader>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-6 px-4 py-6 md:grid-cols-[220px_minmax(0,1fr)] md:px-6">
        {/* 侧栏 */}
        <aside className="flex flex-col gap-2 self-start md:sticky md:top-[72px]">
          <Card className="flex items-center gap-3 p-4">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary">
              {me.username.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <b className="block truncate text-sm">{me.username}</b>
              <span className="text-xs text-muted-foreground">{isAdmin ? "管理员" : "用户"}</span>
            </div>
          </Card>
          <div className="flex gap-1 overflow-x-auto md:flex-col">
            <Button
              variant={tab === "providers" ? "secondary" : "ghost"}
              className="justify-start"
              onClick={() => switchTab("providers")}
            >
              <Video className="size-4" />
              视频源
            </Button>
            {isAdmin && (
              <Button
                variant={tab === "users" ? "secondary" : "ghost"}
                className="justify-start"
                onClick={() => switchTab("users")}
              >
                <Users className="size-4" />
                用户管理
              </Button>
            )}
          </div>
          <Button
            variant="outline"
            className="text-destructive hover:text-destructive md:mt-4"
            onClick={() => {
              clearUser();
              location.href = "/lobby.html";
            }}
          >
            <LogOut className="size-4" />
            退出登录
          </Button>
        </aside>

        <main className="min-w-0">
          {tab === "providers" ? (
            <>
              <div className="mb-6">
                <h1 className="mb-2 text-xl font-bold tracking-tight">视频源</h1>
                <p className="text-sm leading-7 text-muted-foreground">
                  管理你的 OpenList 网盘。B 站登录、解析和播放均在本机完成，云端只负责同步。
                </p>
              </div>

              <h2 className="mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                已配置（{providers.length + (biliBound ? 1 : 0)}）
              </h2>
              {providers.length === 0 && !biliBound ? (
                <div className="rounded-lg border py-5 text-center text-sm text-muted-foreground">
                  还没有配置视频源。可以添加 OpenList，或者进房后直接贴直链、B 站链接。
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                  {biliBound && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm">
                          <Badge variant="outline" className="rounded-full text-[11px] font-normal">哔哩哔哩</Badge>
                          <b className="truncate">{biliStatus.uname || "本机已登录"}</b>
                        </CardTitle>
                        <CardDescription>会话只存在本机助手，云端不保存</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => void clearBiliLogin()}
                        >
                          清除
                        </Button>
                      </CardContent>
                    </Card>
                  )}
                  {providers.map((p) => (
                    <Card key={p.id}>
                      <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm">
                          <Badge variant="outline" className="rounded-full text-[11px] font-normal">
                            {p.kind === "openlist" ? "OpenList" : "哔哩哔哩"}
                          </Badge>
                          <b className="truncate">{p.label}</b>
                        </CardTitle>
                        <CardDescription className="truncate">
                          {p.kind === "openlist" ? `${p.baseUrl} · ${p.username}` : "B 站凭证存在浏览器，服务端不保存"}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => void saveProviders(providers.filter((x) => x.id !== p.id))}
                        >
                          删除
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              <h2 className="mt-6 mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                添加视频源
              </h2>
              <Card className="p-5">
                <div className="flex flex-col gap-3">
                  <Select value={kind} onValueChange={(v) => setKind(v as "openlist" | "bilibili")}>
                    <SelectTrigger aria-label="provider 类型" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openlist">OpenList（自建网盘）</SelectItem>
                      <SelectItem value="bilibili">哔哩哔哩（本机助手）</SelectItem>
                    </SelectContent>
                  </Select>

                  {kind === "openlist" ? (
                    <div className="flex flex-col gap-3">
                      <Input
                        maxLength={24}
                        placeholder="名称（如：家里 OpenList）"
                        value={pLabel}
                        onChange={(e) => setPLabel(e.target.value)}
                      />
                      <Input
                        placeholder="https://openlist.example.com"
                        value={pBaseUrl}
                        onChange={(e) => setPBaseUrl(e.target.value)}
                      />
                      <Input
                        maxLength={64}
                        placeholder="OpenList 用户名"
                        autoComplete="off"
                        value={pUsername}
                        onChange={(e) => setPUsername(e.target.value)}
                      />
                      <Input
                        type="password"
                        maxLength={64}
                        placeholder="OpenList 密码"
                        autoComplete="new-password"
                        value={pPassword}
                        onChange={(e) => setPPassword(e.target.value)}
                      />
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <p className="text-xs leading-6 break-words text-muted-foreground">
                        {biliBound
                          ? `本机已登录${biliStatus.uname ? `：${biliStatus.uname}` : ""}。所有房间、标签页和 SyncFrame 账户复用此会话，直到 B 站会话失效或主动退出。`
                          : biliStatus.available
                            ? "本机助手已运行。B 站视频必须扫码登录，不提供匿名播放。"
                            : "未连接本机助手。请在 syncframe-poc 目录运行 npm run p1:local，然后点「重新检测」。"}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" disabled={!biliStatus.available} onClick={() => void startBiliQrLogin()}>
                          {biliBound ? "重新扫码登录" : "扫码登录 B 站"}
                        </Button>
                        <Button variant="outline" onClick={() => void refreshBiliStatus()}>
                          重新检测
                        </Button>
                        {biliBound && (
                          <Button variant="outline" onClick={() => void clearBiliLogin()}>
                            退出本机 B 站账号
                          </Button>
                        )}
                      </div>
                      <canvas ref={canvasRef} width={180} height={180} className={qrVisible ? "" : "hidden"} />
                      <p className="min-h-4 text-xs text-muted-foreground">{qrStatus}</p>
                    </div>
                  )}

                  <Button className="self-start" onClick={() => void onAddProvider()}>
                    添加
                  </Button>
                  <p className="text-xs leading-6 break-words text-muted-foreground">
                    「直链」「B 站视频」不用配置：进房后点「添加影片」，直接贴地址或 BV 号就行。
                  </p>
                </div>
              </Card>
            </>
          ) : (
            <>
              <div className="mb-6">
                <h1 className="mb-2 text-xl font-bold tracking-tight">用户管理</h1>
                <p className="text-sm leading-7 text-muted-foreground">
                  创建、删除账户或重置密码。删除后凭据和会话立即失效；重置密码后需要重新登录。
                </p>
              </div>

              <h2 className="mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">全部账户</h2>
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户名</TableHead>
                      <TableHead>角色</TableHead>
                      <TableHead>视频源</TableHead>
                      <TableHead className="text-right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {adminUsers.map((u) => (
                      <TableRow key={u.username}>
                        <TableCell>
                          <b>{u.username}</b>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={
                              "rounded-full text-[11px] font-normal " +
                              (u.role === "admin" ? "border-amber-500/40 text-amber-600 dark:text-amber-400" : "")
                            }
                          >
                            {u.role === "admin" ? "管理员" : "用户"}
                          </Badge>
                        </TableCell>
                        <TableCell>{u.providerCount} 个</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => setResetTarget(u)}>
                            <KeyRound className="size-3.5" />
                            重置密码
                          </Button>
                          {u.username !== me.username && (
                            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleteUserTarget(u)}>
                              <Trash2 className="size-3.5" />
                              删除
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <h2 className="mt-6 mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">创建账户</h2>
              <Card className="p-5">
                <div className="flex flex-col gap-3">
                  <Input
                    maxLength={24}
                    placeholder="新用户名（2-24 位字母数字/下划线/横线）"
                    autoComplete="off"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                  />
                  <Input
                    type="password"
                    maxLength={64}
                    placeholder="密码（至少 8 位）"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <Button className="self-start" onClick={() => void createUser()}>
                    <UserPlus className="size-4" />
                    创建账户
                  </Button>
                </div>
              </Card>
            </>
          )}
        </main>
      </div>

      {/* 删除账户确认 */}
      <AlertDialog open={deleteUserTarget !== null} onOpenChange={(open) => !open && setDeleteUserTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除账户 {deleteUserTarget?.username}？</AlertDialogTitle>
            <AlertDialogDescription>删除后，该用户的凭据和会话会立即失效。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void deleteUser();
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 重置密码 */}
      <Dialog open={resetTarget !== null} onOpenChange={(open) => !open && setResetTarget(null)}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>为 {resetTarget?.username} 设置新密码</DialogTitle>
          </DialogHeader>
          <Input
            type="password"
            placeholder="新密码（至少 8 位）"
            value={resetPw}
            onChange={(e) => setResetPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && resetPw) void resetPassword();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)}>
              取消
            </Button>
            <Button disabled={!resetPw} onClick={() => void resetPassword()}>
              确认重置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function SettingsApp() {
  return (
    <ToastProvider>
      <SettingsPage />
    </ToastProvider>
  );
}
