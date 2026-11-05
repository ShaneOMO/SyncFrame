/// <reference types="vite/client" />

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
