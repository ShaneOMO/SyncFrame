import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <path d="M10 8.2v7.6L16 12z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 顶栏：品牌 + 右侧行动区（主题切换由调用方决定是否展示）。 */
export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 border-b bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4">
        <a className="inline-flex items-center gap-2.5 font-semibold tracking-wide" href="/lobby.html" aria-label="SyncFrame 首页">
          <LogoMark className="text-primary" />
          SyncFrame
        </a>
        <nav className="ml-auto flex items-center gap-1">
          {children}
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
