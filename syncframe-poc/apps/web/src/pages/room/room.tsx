/**
 * 观影房间页 UI：顶栏徽标 / 邀请行 / 播放器 / 成员统计 / 播放列表 / 各弹窗。
 * 逻辑全部在 useRoom；本文件只渲染。
 */

import { useState } from "react";
import { Crown, LogOut, Play, Trash2, Users } from "lucide-react";
import { AppHeader, LogoMark } from "@/components/app-header";
import { ToastProvider } from "@/components/toaster";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRoom } from "@/pages/room/useRoom.ts";
import type { MediaListItem, RoomActions } from "@/pages/room/useRoom.ts";
import { AddMediaDialog } from "@/pages/room/add-media-dialog.tsx";
import type { MoviElement } from "@/pages/room/engine.ts";

function mediaBadgeVariant(state: string): "secondary" | "default" | "destructive" | "outline" {
  if (state === "ok") return "default";
  if (state === "loading") return "secondary";
  if (state === "fail") return "destructive";
  return "outline";
}

function MediaList({
  items,
  currentId,
  isHost,
  canControl,
  actions,
}: {
  items: MediaListItem[];
  currentId: string;
  /** 房主身份（决定空列表文案与删除按钮，与旧版一致）。 */
  isHost: boolean;
  /** player 模式下房主可点击播放/添加（clock 模式禁用）。 */
  canControl: boolean;
  actions: RoomActions;
}) {
  const [deleteTarget, setDeleteTarget] = useState<MediaListItem | null>(null);

  return (
    <div className="overflow-hidden rounded-lg border">
      {items.length === 0 ? (
        <div className="py-5 text-center text-sm text-muted-foreground">
          {isHost ? "（播放列表为空，点右上角「＋ 添加影片」）" : "（等待房主添加视频）"}
        </div>
      ) : (
        items.map((item) => {
          const isCurrent = item.mediaId === currentId;
          return (
            <div
              key={item.mediaId}
              className={
                (item.kind === "video" && isHost ? "cursor-pointer " : "cursor-default ") +
                (isCurrent ? "bg-primary/10 " : "") +
                "flex flex-wrap items-center gap-2 border-b px-3 py-2 transition-colors last:border-b-0 hover:bg-muted/50"
              }
              onClick={() => {
                if (item.kind === "video" && canControl) {
                  void actions.hostLoad(item.mediaId, { name: item.name, size: item.size });
                }
              }}
            >
              <Badge variant="outline" className="rounded-full text-[11px] font-normal">
                {item.kind === "subtitle" ? "字幕" : "视频"}
              </Badge>
              {item.provider && (
                <Badge variant="outline" className="rounded-full border-primary/35 text-[11px] font-normal text-primary">
                  {item.provider}
                </Badge>
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
              {item.kind === "subtitle" && (
                <Button size="sm" variant="secondary" className="h-6 px-3 text-xs" onClick={(e) => {
                  e.stopPropagation();
                  void actions.verifySubtitleGrant(item);
                }}>
                  验证授权
                </Button>
              )}
              {item.kind === "video" && canControl && (
                <Button
                  size="sm"
                  variant={isCurrent ? "default" : "secondary"}
                  className="h-6 px-3 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    void actions.hostLoad(item.mediaId, { name: item.name, size: item.size });
                  }}
                >
                  {isCurrent ? "播放中" : "播放"}
                </Button>
              )}
              {isHost && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  title="从播放列表移除"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(item);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          );
        })
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>从播放列表删除「{deleteTarget?.name}」？</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) void actions.removeMediaItem(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RoomPage() {
  const room = useRoom();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteRoomOpen, setDeleteRoomOpen] = useState(false);
  const [addMsg, setAddMsg] = useState({ text: "", ok: false });

  if (room.phase === "loading") {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">初始化…</div>;
  }
  if (room.phase === "redirect") return null;

  const { ui, actions } = room;
  const isHost = room.role === "host";

  return (
    <div className="min-h-screen pb-12">
      <AppHeader>
        {room.invite.available && (
          <Button variant="ghost" size="sm" onClick={() => setInviteOpen((v) => !v)}>
            <Users className="size-3.5" />
            邀请
          </Button>
        )}
        {isHost && (
          <Button variant="destructive" size="sm" onClick={() => setDeleteRoomOpen(true)}>
            <Trash2 className="size-3.5" />
            删除房间
          </Button>
        )}
        <a href="/lobby.html">
          <Button variant="ghost" size="sm">
            <LogOut className="size-3.5" />
            退出房间
          </Button>
        </a>
      </AppHeader>

      {/* 房间徽标行（顶栏下方） */}
      <div className="mx-auto mt-4 flex max-w-7xl flex-wrap items-center gap-2 px-4">
        <span className="text-sm font-semibold">{room.roomLabel}</span>
        <Badge variant="outline" className="rounded-full font-mono text-xs">
          {room.roomId}
          {room.mode === "clock" ? " · clock" : ""}
        </Badge>
        <Badge variant={isHost ? "default" : "secondary"} className="rounded-full text-xs">
          {isHost ? "房主" : "观众"}
        </Badge>
        <Badge
          variant="outline"
          className={
            "rounded-full text-xs " + (ui.connOk ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-amber-500/40 text-amber-600 dark:text-amber-400")
          }
        >
          {ui.connText}
        </Badge>
        {ui.routeBadge && (
          <Badge
            variant="outline"
            className={
              "rounded-full text-xs " +
              (ui.routeBadge.direct
                ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                : "border-amber-500/40 text-amber-600 dark:text-amber-400")
            }
            title={
              ui.routeBadge.direct
                ? "浏览器直接连接源站拉流，不占用服务器带宽"
                : `经服务端反代，占用服务器带宽${ui.routeBadge.reason ? `（${ui.routeBadge.reason}）` : ""}`
            }
          >
            {ui.routeBadge.direct ? "直连" : "代理"}
          </Badge>
        )}
        <Badge variant={mediaBadgeVariant(ui.mediaBadgeState)} className="rounded-full text-xs">
          {ui.mediaBadgeText}
        </Badge>
        {/* 成员 chips */}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {ui.members.map((m) => (
            <Badge
              key={m.id}
              variant="outline"
              className={
                "gap-1 rounded-full text-xs " +
                (m.id === room.clientId ? "cursor-pointer border-border-strong" : "")
              }
              title={m.id === room.clientId ? "账户设置（provider 管理）" : undefined}
              onClick={m.id === room.clientId ? () => (location.href = "/settings.html") : undefined}
            >
              {m.role === "host" && <Crown className="size-3 text-amber-500" />}
              {m.name}
            </Badge>
          ))}
        </span>
      </div>

      {/* 邀请行 */}
      {isHost && room.invite.available && inviteOpen && (
        <div className="mx-auto mt-4 flex max-w-7xl flex-wrap items-center gap-2.5 rounded-xl border bg-card px-4 py-2.5">
          <Label htmlFor="invite-link" className="shrink-0 text-xs text-muted-foreground">
            邀请链接
          </Label>
          <Input id="invite-link" readOnly className="h-8 min-w-[220px] flex-1 text-xs" value={room.invite.link} />
          <Button size="sm" onClick={() => void actions.copyInvite()}>
            复制链接
          </Button>
          <Button
            size="sm"
            variant="destructive"
            title="旧链接立即失效，已加入成员不受影响"
            onClick={() => void actions.rotateInvite()}
          >
            重置链接
          </Button>
        </div>
      )}

      <main className="mx-auto mt-4 grid max-w-7xl grid-cols-1 gap-4 px-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <Card className="p-2.5">
            {room.mode === "clock" ? (
              <div className="py-8">
                <div className="py-2 text-center font-mono text-5xl font-bold tracking-widest">{ui.clockFace}</div>
                <div className="pb-6 text-center text-sm text-muted-foreground">{ui.clockSub}</div>
              </div>
            ) : (
              <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
                {/* movi-player 是非 React 自定义元素：callback ref 交给引擎管理 */}
                <movi-player
                  ref={(el: unknown) => {
                    if (el) room.playerRef.current = el as MoviElement;
                  }}
                  theme="dark"
                  wasmurl=""
                />
                {ui.gesture && (
                  <div className="absolute inset-0 z-[5] flex items-center justify-center bg-black/70 backdrop-blur-sm">
                    <Button onClick={actions.joinPlay}>
                      <Play className="size-4" />
                      点击加入播放
                    </Button>
                  </div>
                )}
              </div>
            )}
            {!isHost && (
              <div className="flex items-center gap-2 px-1 pt-3 text-xs text-muted-foreground">
                <span
                  className={
                    "inline-block size-1.5 shrink-0 rounded-full " +
                    (ui.viewerPaused ? "bg-amber-500" : "bg-emerald-500")
                  }
                />
                <span>{ui.viewerText}</span>
                <span className="ml-auto font-mono text-xs">{ui.viewerTime}</span>
              </div>
            )}
            <p
              className={
                "min-h-5 px-1 pt-2 text-xs " +
                (ui.statusWarn ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")
              }
              role="status"
            >
              {ui.statusText}
            </p>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">
                在线人数 <span className="text-xs font-normal text-muted-foreground">房主 + 游客</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-1.5">
                {[
                  { label: "同步用户", value: ui.statTotal },
                  { label: "房主", value: ui.statHost },
                  { label: "游客", value: ui.statGuest },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="min-w-[72px] flex-1 rounded-lg border py-2.5 text-center text-xs text-muted-foreground"
                  >
                    {s.label}
                    <b className="mt-0.5 block font-mono text-lg font-semibold text-foreground">{s.value}</b>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                播放列表
                <span className="text-xs font-normal text-muted-foreground">点击播放（房主）</span>
                {isHost && room.isPlayer && (
                  <Button size="sm" className="ml-auto h-7" onClick={() => setAddOpen(true)}>
                    ＋ 添加影片
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <MediaList
                items={ui.mediaItems}
                currentId={ui.currentMediaId}
                isHost={isHost}
                canControl={isHost && room.isPlayer}
                actions={actions}
              />
            </CardContent>
          </Card>
        </div>
      </main>

      {/* B 站未绑定提示 */}
      <Dialog open={ui.biliHint} onOpenChange={(open) => !open && actions.closeBiliHint()}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>未绑定 B 站账号，播放将受限制</DialogTitle>
            <DialogDescription>
              当前以匿名身份解析 B 站视频：画质上限 720P，番剧与会员内容可能无法播放。绑定后凭证只保存在本浏览器，服务器不会保存，也不会共享给其他人。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={actions.closeBiliHint}>
              继续观看（受限）
            </Button>
            <Button onClick={() => (location.href = "/settings.html")}>去绑定 B 站账号</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除房间确认 */}
      <AlertDialog open={deleteRoomOpen} onOpenChange={setDeleteRoomOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除房间「{room.roomId}」？</AlertDialogTitle>
            <AlertDialogDescription>删除后不可恢复，房间内的所有成员将被请出。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void actions.deleteRoom();
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 添加影片 */}
      {isHost && room.isPlayer && (
        <AddMediaDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          roomId={room.roomId}
          memberToken={room.session.memberToken}
          userToken={room.userToken}
          providers={ui.providers}
          actions={actions}
          msg={addMsg}
          onStatus={(line, warn) => {
            setAddMsg({ text: line, ok: !warn });
          }}
        />
      )}
    </div>
  );
}

export default function RoomApp() {
  return (
    <ToastProvider>
      <RoomPage />
    </ToastProvider>
  );
}
