# P3 最小观影室集成：实现说明与安全测试记录

> 状态：已实现并通过自动化测试 + 真实 OpenList 人工验收（2026-10-27，多用户同步播放确认）
> 前置：P0/P1/P2 已通过（见 `../reports/` 与本文 §6）
> 代码：`apps/server/src/room-auth.ts`（鉴权/媒体映射）、`apps/server/src/index.ts`（REST + WS 鉴权门）、
> `apps/web/lobby.html` + `src/lobby-main.ts` + `src/session.ts`（大厅/会话）、
> `apps/web/src/browse.ts`（选片面板）、`apps/web/room.html` + `src/room-main.ts`（房间页）

---

## 1. 用户操作流程

1. 房主打开 `lobby.html` → 输入昵称 → 「创建房间」→ 直接进房。
2. 房主复制**邀请链接**（内嵌房间号 + 邀请码，`lobby.html?room=<id>&key=<code>`）发给观众；
   观众点开链接即自动进房，无需手动输入邀请码（**无需 OpenList 账号**）。邀请码仍作为 join 接口凭据，
   安全模型不变，只是由链接携带；大厅保留房间号 + 邀请码的手动加入作为降级路径。
3. 房主在房间页用「OpenList 选片」面板浏览目录 / 搜索 / 翻页，点「选片」→ 服务端把文件路径注册为
   不透明 `mediaId`（同目录外挂字幕 .srt/.ass/.ssa/.vtt 自动一并注册）→ 全房间广播 load。
4. 各端（房主 + 观众）用**自己的成员令牌**向 grant 接口换短期媒体地址（10 分钟提示期，服务端缓存 60s），
   Movi Player 独立拉流；房主控制播放/暂停/seek/倍速/换片，观众自动跟随（P2 协议）。
5. 音轨/字幕选择是观众本地行为，不进房间状态（S11）。

## 2. 鉴权与凭证模型

| 凭证 | 签发 | 持有者 | 有效期 | 能做什么 |
| --- | --- | --- | --- | --- |
| `inviteCode` | 创建房间时 | 房主（传播给观众） | 房间生命周期 | 换取观众成员令牌 |
| `hostSecret` | 创建房间时（仅创建响应出现一次） | 房主浏览器 sessionStorage | 房间生命周期 | 重建房主会话（重连/换浏览器） |
| `memberToken` | `/api/rooms` 或 `/join` | 每个成员 | 12h | WS 入场 + 媒体清单 + grant（观众只能 grant 已注册媒体） |
| `media grant` | `GET .../media/:mediaId/grant` | 房间内任意成员 | 提示 10min / 服务端缓存 60s | 拿到最终媒体地址（换签名/续期入口） |

关键边界：

- WebSocket 入场必须携带有效 `memberToken`（401 直接拒升级）；
- **浏览/搜索仅房主**（观众 403）——观众不能浏览未授权目录；
- **注册媒体仅房主**（服务端校验 host 身份，WS 层的 S13 权限门之外再加一层）；
- grant 校验 `mediaId` 属于**本房间**注册表，跨房间一律 404（不暴露存在性）；
- 路径穿越（`..`）在服务端入口直接 400；
- 同一成员重复加入会作废旧令牌（防双身份）；房主重连用 `hostSecret` 恢复同一 `clientId`。

## 3. 数据流（媒体字节不经过房间服务）

```
浏览器A(房主)                服务端                     OpenList
   │  POST /rooms/:id/media ──→ 注册 mediaId→path ──→ fs/get 校验/元信息
   │  WS cmd load(mediaId) ────→ 定序广播 mediaId ──→│        │
   │                            (不含URL/路径)        │        │
浏览器B(观众)                                          │        │
   │  WS state(mediaId) ──────→│                      │        │
   │  GET .../grant ──────────→ 查注册表→path ───────→ fs/get → raw_url
   │  ← {url(短期), expiresInSec} │                   (跟随重定向链)
   │  fetch(url, Range) ───────────────────────────────────────→ 直接拉字节
```

OpenList 管理令牌只存在于服务端内存；签名 URL 只出现在 grant 响应中，不写入日志、不进 WS。

## 4. 安全测试记录

`tests/p3/security.test.ts`（OpenList 桩见 `tests/p3/openlist-stub.ts`），13 项全部通过：

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | 创建房间：房间号/邀请码/hostSecret/成员令牌形态 | ✅ |
| 2 | 错误邀请码 401；不存在房间 401（不暴露存在性） | ✅ |
| 3 | 正确邀请码 → 观众令牌；重复加入各自独立 | ✅ |
| 4 | 房主凭 hostSecret 重建会话（恢复同一 clientId） | ✅ |
| 5 | WS 无令牌/伪造令牌/不存在房间 → 拒绝；有效令牌 → welcome | ✅ |
| 6 | 浏览/搜索：观众 403、匿名 401、房主 200 | ✅ |
| 7 | 注册媒体：观众 403；房主返回不透明 mediaId + 自动注册外挂字幕；路径穿越 400；幂等 | ✅ |
| 8 | grant：匿名 401、未注册 404、跨房间 404、观众可取 206 字节 | ✅ |
| 9 | grant 60s 缓存（第二次 cached=true） | ✅ |
| 10 | 外挂字幕与视频同授权路径、同存储前缀 | ✅ |
| 11 | WS 广播不含 URL/签名/路径（抓包断言） | ✅ |
| 12 | WS 权限门：观众命令被服务端 rejected | ✅ |
| 13 | 审计日志不含成员令牌/签名 URL/文件路径/OpenList 令牌 | ✅ |

运行方式：`npm run p3:security`。

## 5. 端到端冒烟

`tests/p3/e2e-smoke.ts`：创建房间 → 邀请码加入 → 浏览/搜索 → 注册 → WS load/play/seek/pause →
观众 grant 拉字节 → 字幕 grant → 换片 mediaRevision 递增。**全部通过**（`npm run p3:e2e`）。

P2 回归（均改造为走 P3 鉴权流程后重跑通过）：

- `tests/sync/sync-sim-test.ts`：S01–S07/S13/S14 + 20s 稳态采样，P95=253ms（LAN）；
- `tests/sync/sync-browser-test.ts`：3 个独立 Chrome 上下文，P95=1ms；
- `tests/sync/demo-e2e-smoke.ts`：1 房主 + 2 观众 Vite 全链路冒烟。

## 6. 通过门槛对照（计划 §P3）

| 门槛 | 结果 |
| --- | --- |
| 非 OpenList 登录用户可在授权房间观看指定视频，但不能浏览未授权目录 | ✅ 安全用例 6/8（桩模拟观众无 OpenList 凭证） |
| 完整流程可重复：选房 → 建房 → 分享链接 → 两人加入 → 播放/暂停/seek → 换片 | ✅ e2e 冒烟 + 真实 OpenList 实例多浏览器人工验收（2026-10-27） |
| 刷新页面和短期断网后可恢复 | ✅ 成员令牌 12h + sessionStorage；注册表房间保留 30min；S06/S07 重连回归通过 |
| 房间码或媒体链接不能越权访问其他媒体 | ✅ 用例 2/5/8（跨房间 mediaId 404、无令牌 401） |
| 日志不泄露 OpenList 令牌、完整签名 URL 或敏感路径 | ✅ 用例 13；审计只含 roomId/mediaId/clientId/动作 |

## 7. 已知限制（PoC 范围，非目标）

- 单进程内存态：房间/令牌/媒体映射不持久化，重启即失效（P4 再评估）。
- 成员令牌 12h 固定有效期，无滑动续期；grant 过期由客户端自动续签兜底（凭证剩余 <2 分钟时静默换新 URL；
  播放中签名失效触发错误恢复：重新授权、重建源、跳回中断位置，S12）。
- 房间页 UI 已重构为深色三栏布局（顶栏徽标/成员 + 16:9 播放器与房主控制条 + 同页选片面板与右侧片源清单），
  调试信息（HUD/采样/clock 手动脉冲）收纳进默认折叠的诊断面板；错误自动恢复仅在实际开始播放后触发，
  初始载入阶段的解码错误只提示不重建（避免桩/坏文件误触发换凭证）。截图：`reports/ui-host-playing.png` 等。
- 浏览/搜索无目录白名单：房主可见 OpenList 全部挂载（符合 MVP 信任模型，P4 可加根目录限制）。
- `/api/resolve` 为 P1 遗留的无房间授权接口，仅供播放能力验证，MVP 观影走 grant 链路。
- 观众端外挂字幕由播放器内嵌轨/外挂加载覆盖；注册表中的字幕条目提供「验证授权」按钮做可达性确认（movi-player 自动加载同目录字幕行为依赖 P1 播放器配置）。
- Web UI 无品牌化/响应式精修；12 人上限与 P2 一致。
- 邀请链接可重置（旧链接/旧码立即失效），但无「踢出成员」能力；限流为单进程内存窗口（join 20/min、grant 60/min、WS 拒绝 30/min，按 IP）。
  注意：key 在 URL query 中，会留在浏览器历史里——分享前如需保密请改用口头告知，PoC 不另做一次性链接。

## 8. 一键测试环境

仓库根目录 `docker compose up --build` 后访问 `http://localhost:7300/lobby.html`
（`deploy/server.Dockerfile`、`deploy/web.Dockerfile`、`deploy/nginx.conf`；OpenList 凭据经环境变量注入）。
本地开发：`npm run p1:server` + `npm run p1:web`（Vite 代理 /api 与 /ws）。
