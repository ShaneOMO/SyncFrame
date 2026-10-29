# SyncFrame 代码目录

多人同步观影室全部代码（npm workspaces：apps + packages + tests）。
运行、部署与环境变量说明见仓库根目录的 [README](../README.md)。

## 结构

```text
apps/web/                  # Vite 前端：大厅 lobby.html（入口）/ 房间 room.html（移动端自适应）
apps/server/               # Node 后端：REST 鉴权 + WebSocket 同步房间 + 媒体 provider 解析
packages/sync-protocol/    # 同步协议包（时钟偏移、跟随纠偏、消息校验、SyncClient）
packages/openlist-adapter/ # OpenList API 适配器
tests/                     # p2 协议仿真 / p3 安全 + UI 冒烟 / p4 provider 单测 + 移动端检查
```

媒体来源（provider）：房主本人账户的 OpenList（登录后在 provider 配置中保存凭据）、Bilibili（可选 SESSDATA）、内置直链与 B 站解析（免配置）。Bilibili 流由服务端反代（`/stream` 透传 Range）。注册已关闭：管理员由 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 环境变量初始化，负责创建全部账户。
