# SyncFrame PoC

基于 Movi Player + OpenList 的多人同步观影室可行性验证项目。验证计划见 `../docs/feasibility-validation-plan.md`。

## 目录结构

```text
syncframe-poc/
├── apps/
│   ├── web/                    # 播放测试页、P2 房间页（room.html）
│   └── server/                 # REST、WebSocket 房间（sync-rooms.ts）、媒体授权
├── packages/
│   ├── openlist-adapter/       # OpenList API 最小适配器（登录/列目录/文件详情/错误标准化）
│   └── sync-protocol/          # P2：状态类型、revision、时钟估算、跟随纠偏、SyncClient
├── tests/
│   ├── http/                   # P0：Range、CORS、重定向、过期签名
│   └── sync/                   # P2：协议单元、Node 仿真、Playwright 多浏览器同步
├── docs/
│   └── p2-sync-protocol.md     # P2 协议草案 + Movi Watch Party 审计
└── reports/
    ├── http-capability.md      # P0 报告
    ├── playback-matrix.md      # P1 报告
    ├── sync-spike.md           # P2 报告（门槛对照 + S01–S15 映射）
    ├── http-raw/               # P0 原始记录（JSON，自动生成）
    ├── playback-raw/           # P1 原始记录（JSON，自动生成）
    └── sync-raw/               # P2 漂移原始记录（JSON，自动生成）
```

## P0：OpenList 文件访问与 HTTP 能力验证

### 0. 自验证（无需 OpenList 环境）

```bash
npm install
npx tsx tests/http/smoke-test.ts
```

全部断言通过说明检查脚本本身工作正常。

### 1. 配置

```bash
cp .env.example .env   # Windows: copy .env.example .env
```

填写 `.env`：

| 变量 | 说明 |
| --- | --- |
| `OPENLIST_BASE_URL` | OpenList 实例地址，如 `http://192.168.1.10:5244` |
| `OPENLIST_USERNAME` / `OPENLIST_PASSWORD` | 测试账号（**最小只读权限**，勿用管理员） |
| `OPENLIST_TEST_DIR` | 要检查的目录，默认 `/` |
| `OPENLIST_TEST_FILE` | 可选，指定单个文件；留空自动选目录里中等大小的视频文件 |
| `CHECK_CONCURRENCY` | 并发读取会话数，默认 5 |

### 2. 运行完整探测

```bash
npm run p0:probe
```

流程：登录 → 验证令牌 → 列目录 → 取文件详情（raw_url / related / 签名）→ 分别检查「OpenList 代理地址」和「raw_url 存储直链」的 HEAD/GET、头/中/尾 Range、重定向后 Range、CORS 预检、并发稳定性。

### 3. 只检查指定 URL（手工场景）

```bash
npm run p0:check -- "http://192.168.1.10:5244/d/movies/a.mkv" --concurrency=5
```

### 4. 产出

- 控制台逐项结果 + 路线判断提示
- 原始 JSON 记录：`reports/http-raw/*.json`（URL 查询串已脱敏，签名不落盘）
- 请把结果填入 `reports/http-capability.md` 模板

### 5. P0 通过门槛（来自验证计划）

1. 能稳定列出目录并解析目标文件；
2. 核心样本所在存储支持正确的随机 Range（不支持则同源代理兜底已验证）；
3. 浏览器能跨域读取，或同源代理能完整保留 Range 语义；
4. 连续读取和中途 seek 不导致整文件重新下载；
5. 明确签名有效期和续期方式。

**P0 未通过则不进入 P1 播放器验证。**

## P1：Movi Player 原始文件播放验证

### 架构

```text
浏览器 (apps/web, Vite :5173)
  └─ <movi-player> (movi-player@0.4.1 slim, WASM 自托管)
       └─ CountingHttpSource (统计 Range 请求数/字节量)
            └─ /api/resolve → apps/server (:8787) → OpenList fs/get → raw_url 或 /d 代理
```

OpenList 账号凭证只存在于 `apps/server`（读 `.env`），浏览器端只看到短期媒体地址。

### 启动（两个终端）

```bash
# 终端 1：后端（媒体地址解析 + 报告接收）
npm run p1:server

# 终端 2：播放器验证页
npm run p1:web
```

打开 http://localhost:5173 （预置了 MKV 双音轨测试文件路径）。

### 验证操作清单（对应计划 §5.3 / V01–V09 样本）

1. **冷启动**：点「载入」或「冷启动重载」→ 记录首帧时间、元数据时间
2. **连续播放**：至少 15 分钟（长片 30 分钟），观察重新缓冲次数与 JS Heap 增长
3. **Seek**：10% / 50% / 90% 各点 5 次，记录每次延迟
4. **倍速**：切换 0.5×–2× 各档观察
5. **音轨/字幕**：播放器齿轮菜单切换（边缘行者 MKV 含双音轨）；字幕偏移用 `Z`/`X`
6. **解码引擎**：播放中按 `I` 打开 Nerd Stats，确认硬解/软解后在页面下拉框选择
7. **两条链路对比**：切换「直链 / OpenList 代理」下拉分别载入对比
8. **本地对照**：文件选择失败归因时，用 Nerd Stats + Network 面板辅助判断

### 指标导出

- 页面「导出指标 JSON」下载报告；「上传报告到服务端」保存到 `reports/playback-raw/`
- 采集字段对应计划 §7.1（testId/首帧/seek 延迟/重缓冲/掉帧/Range 请求数/字节量/JS Heap 等）
- 多次测试后用这些 JSON 汇总 `reports/playback-matrix.md`

## P2：多人同步协议 Spike（已通过）

### 交付物

- 协议草案 + 原型审计：`docs/p2-sync-protocol.md`
- 结果报告（门槛对照 + S01–S15 映射）：`reports/sync-spike.md`
- 共享协议包：`packages/sync-protocol/`（时钟偏移、跟随纠偏、消息校验、SyncClient）
- 房间服务端：`apps/server` 增加 `WS /ws?room=<id>&role=host|viewer` + `POST /api/sync-report`
- 房间页：`apps/web/room.html`（clock 演示模式 / player 真实播放器模式）
- 自动化：`tests/sync/`（单元 13 项、Node 仿真、Playwright 三浏览器上下文）
- 漂移原始记录：`reports/sync-raw/`

### 快速开始

```bash
# 终端 1：后端（媒体解析 + 同步房间）
npm run p2:demo

# 终端 2：前端（room.html 已含 /ws 代理）
npm run p1:web
```

- 房主窗口：http://localhost:5173/room.html?room=demo&role=host&mode=clock
- 观众窗口（可开多个）：http://localhost:5173/room.html?room=demo&role=viewer&mode=clock
- 房主点「载入并广播 → 播放」，观众自动跟随；右侧面板实时显示漂移/RTT/纠偏计数
- player 模式（真实 OpenList 视频）把 `mode=clock` 换成 `mode=player` 并填文件路径

### 自动化测试

```bash
npm run p2:unit                  # 协议单元测试
npm run p2:sim                   # S01–S07/S13/S14 + 20s 稳态漂移采样
SYNC_SIM_RTT=100 npm run p2:sim  # 注入 100ms RTT + 30ms 抖动（WAN 场景）
npm run p2:browser               # Playwright 3 个独立浏览器上下文
```

延迟注入环境变量（仿真 WAN）：`SYNC_INJECT_LATENCY_MS`（单向）/ `SYNC_INJECT_JITTER_MS`。
