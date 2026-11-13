/** movi-player 自定义元素（非 React 组件）的 JSX 类型声明。 */

import type { MoviElement } from "@/pages/room/engine.ts";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "movi-player": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        theme?: string;
        wasmurl?: string;
        controls?: string;
        ref?: (el: MoviElement | null) => void;
      };
    }
  }
}

export {};
