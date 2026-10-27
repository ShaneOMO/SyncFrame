/** 统一图标（lucide 风格描边 SVG）。
 *  TS 侧注入用 icon()；room.html 的静态图标用页面内 sprite，路径与此处保持一致。
 *  禁止 emoji 作为图标。 */

const PATHS: Record<string, { body: string; fill?: boolean }> = {
  play: { body: '<path d="M8 5.5v13l11-6.5z"/>', fill: true },
  pause: { body: '<path d="M7 5h3.5v14H7z"/><path d="M13.5 5H17v14h-3.5z"/>', fill: true },
  folder: { body: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' },
  file: { body: '<path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>' },
  users: {
    body: '<circle cx="9" cy="7" r="4"/><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  },
  wrench: { body: '<path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3z"/>' },
  crown: { body: '<path d="m2 4 3 3 5-5 5 5 3-3v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>' },
  alert: {
    body: '<path d="M12 3 2 20h20z"/><path d="M12 9.5V14"/><path d="M12 17.2h.01"/>',
  },
  "arrow-up": { body: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>' },
};

export function icon(name: keyof typeof PATHS, cls = "ic"): string {
  const p = PATHS[name];
  const fillCls = p.fill ? " ic-fill" : "";
  return `<svg class="${cls}${fillCls}" viewBox="0 0 24 24" aria-hidden="true">${p.body}</svg>`;
}
