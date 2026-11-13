/** 亮暗主题：默认深色（与原设计一致），切换写入 localStorage 并在 <html> 上切 class。 */

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

const THEME_KEY = "syncframe-theme";

function initialDark(): boolean {
  return localStorage.getItem(THEME_KEY) !== "light";
}

export function ThemeToggle() {
  const [dark, setDark] = useState(initialDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  }, [dark]);

  return (
    <Button variant="ghost" size="icon" aria-label="切换亮暗主题" onClick={() => setDark((d) => !d)}>
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
