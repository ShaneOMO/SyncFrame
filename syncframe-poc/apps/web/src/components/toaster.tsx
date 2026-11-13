/**
 * 极简全局 toast：零依赖，替代各页手写 msg 状态行。
 * 用法：const { toast } = useToast(); toast("已删除");
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ToastItem {
  id: number;
  text: string;
}

interface ToastContextValue {
  toast: (text: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((text: string) => {
    const id = nextId++;
    setItems((prev) => [...prev.slice(-3), { id, text }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto w-full rounded-lg border bg-popover px-4 py-2.5 text-sm text-popover-foreground shadow-lg",
              "animate-in fade-in slide-in-from-bottom-2",
            )}
            role="status"
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
