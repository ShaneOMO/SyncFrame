/// <reference types="vite/client" />

/** 构建时注入的版本信息（见 src/build-info.ts 与 deploy/server.Dockerfile）。 */
interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_GIT_COMMIT?: string;
  readonly VITE_BUILD_TIME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.wasm?url" {
  const src: string;
  export default src;
}

declare module "qrcode" {
  export interface QRCodeToCanvasOptions {
    width?: number;
    margin?: number;
    color?: { dark?: string; light?: string };
  }
  /** 把文本渲染为二维码到 canvas（浏览器端重载）。 */
  export function toCanvas(canvas: HTMLCanvasElement, text: string, options?: QRCodeToCanvasOptions): Promise<void>;
  const QRCode: { toCanvas: typeof toCanvas };
  export default QRCode;
}
