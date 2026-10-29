/**
 * 持久化测试：账户（含 provider 凭据）与房间落盘 DATA_DIR，重启后恢复。
 *
 * 运行：node --import tsx --test tests/p4/persistence.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UserAccounts } from "../../apps/server/src/user-accounts.ts";
import { RoomRegistry } from "../../apps/server/src/room-auth.ts";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "syncframe-store-"));
}

test("账户持久化：管理员/用户/provider 凭据重启后保留，令牌不持久化", () => {
  const dir = tempDir();
  try {
    const a = new UserAccounts(dir);
    assert.equal(a.initAdmin("admin", "adminpw123"), true);
    assert.equal(a.createUser("admin", "alice", "pw123456").ok, true);
    assert.equal(
      a.setProviders("alice", [
        { kind: "openlist", label: "家里", baseUrl: "http://nas.local:5244", username: "u", password: "p" },
        { kind: "bilibili", label: "B站", cookie: "SESSDATA=xyz" },
      ]).ok,
      true,
    );
    const token = a.login("alice", "pw123456");
    assert.ok(token);

    // 模拟重启：新实例读同一目录
    const b = new UserAccounts(dir);
    assert.equal(b.isAdmin("admin"), true);
    const relogin = b.login("alice", "pw123456");
    assert.ok(relogin, "用户哈希应可验证（密码正确）");
    assert.notEqual(relogin, token, "重新登录签发新令牌即可，不做断言外要求");
    // 旧令牌不应跨重启有效（令牌纯内存）
    assert.equal(b.authenticate(token), null, "用户令牌不持久化，重启后应失效");
    const providers = b.listProviders("alice");
    assert.equal(providers.length, 2);
    assert.equal(providers[0].kind, "openlist");
    assert.equal(providers[1].kind, "bilibili");
    assert.ok(!("password" in providers[0]) && !("cookie" in providers[1]), "对外仍不回显凭据");
    // 内部凭据保留（grant 解析要用）
    assert.equal(b.getUser("alice")?.providers.size, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("房间持久化：房间/成员令牌/邀请码/媒体映射重启后恢复", () => {
  const dir = tempDir();
  try {
    const r = new RoomRegistry({ dataDir: dir });
    const { room, member } = r.createRoom("房主", "alice");
    const viewer = r.joinRoom(room.roomId, "观众", { inviteCode: room.inviteCode })!;
    assert.ok(viewer);
    const reg = r.registerMedia(room.roomId, member, "", { name: "视频", size: 0 }, [], {
      provider: "直链",
      directUrl: "https://example.com/v.mp4",
    });
    assert.ok("mediaId" in reg);

    // 模拟重启
    const r2 = new RoomRegistry({ dataDir: dir });
    assert.equal(r2.roomCount(), 1);
    const peeked = r2.peek(room.roomId);
    assert.ok(peeked);
    assert.equal(peeked.inviteCode, room.inviteCode);
    assert.equal(peeked.hostUser, "alice");
    // 成员令牌仍可鉴权（刷新/断网恢复能力跨重启保留）
    assert.ok(r2.authenticate(room.roomId, member.token));
    assert.ok(r2.authenticate(room.roomId, viewer.token));
    // 媒体映射恢复
    const media = r2.listMedia(room.roomId);
    assert.equal(media?.length, 1);
    assert.equal(media?.[0].name, "视频");
    assert.ok(r2.isRoomOwner(room.roomId, "alice"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dataDir 为 null（未配置）时纯内存，不写文件", () => {
  const a = new UserAccounts(null);
  assert.equal(a.initAdmin("admin", "adminpw123"), true);
  const r = new RoomRegistry({});
  assert.equal(r.roomCount(), 0);
});
