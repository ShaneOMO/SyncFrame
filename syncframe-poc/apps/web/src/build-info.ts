// 构建信息：由镜像构建时的 VITE_* 变量注入（见 deploy/server.Dockerfile）。
// 本地 `vite dev` / 本地 build 没有这些变量，统一回退为 dev，便于区分「线上版本」和「本地开发」。
// 用途：出问题时报一下控制台里的这行信息，就能确定页面是哪个 commit 构建的。

export interface BuildInfo {
  /** 应用版本（来自仓库根 package.json 的 version） */
  version: string;
  /** 构建时的 git commit（短 SHA） */
  commit: string;
  /** 构建时间（UTC ISO8601） */
  builtAt: string;
}

export const BUILD_INFO: BuildInfo = {
  version: import.meta.env.VITE_APP_VERSION || "dev",
  commit: import.meta.env.VITE_GIT_COMMIT || "dev",
  builtAt: import.meta.env.VITE_BUILD_TIME || "",
};

/** 单行摘要，便于展示或贴到 issue 里。 */
export function describeBuild(): string {
  return `${BUILD_INFO.version} @ ${BUILD_INFO.commit}${BUILD_INFO.builtAt ? ` (${BUILD_INFO.builtAt})` : ""}`;
}

declare global {
  interface Window {
    /** 控制台可直接输入 `__SYNCFRAME_BUILD__` 查询当前页面版本。 */
    __SYNCFRAME_BUILD__?: BuildInfo;
  }
}

/**
 * 把构建信息挂到 window 上，供需要时在控制台自行查询：
 *   __SYNCFRAME_BUILD__
 * 默认不打印日志，避免污染用户/排障时的控制台输出。
 */
export function exposeBuildInfo(): void {
  try {
    window.__SYNCFRAME_BUILD__ = BUILD_INFO;
  } catch {
    // 忽略：某些沙箱环境不允许写 window
  }
}

