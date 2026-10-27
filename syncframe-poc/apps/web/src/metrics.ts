/**
 * P1 播放指标采集（对应验证计划 §7.1 字段）。
 * 挂载到 <movi-player> 元素，监听标准媒体事件 + 自定义 SourceAdapter 网络计数。
 */

import type { CountingHttpSource } from "./counting-source.ts";

export interface SeekTestEntry {
  targetSec: number;
  latencyMs: number;
}

export interface PlaybackReport {
  // 标识
  testId: string;
  sampleId: string; // 文件名
  path: string; // OpenList 路径
  route: "raw" | "proxy";
  timestamp: string;
  // 环境
  userAgent: string;
  browser: string;
  os: string;
  device: string;
  // 媒体（播放器能取到的自动填，取不到的留空由人工补充）
  container: string;
  fileSize: number | null;
  durationSec: number | null;
  resolution: string;
  videoCodec: string;
  audioCodec: string;
  subtitleFormats: string;
  // 启动
  coldOrWarm: "cold" | "warm";
  metadataTimeMs: number | null;
  firstFrameTimeMs: number | null;
  // 解码（按 I 键观察 Nerd Stats 后人工确认）
  decoderEngine: string;
  hardwareOrSoftware: string;
  // 播放质量
  rebufferCount: number;
  rebufferDurationMs: number;
  seekTests: SeekTestEntry[];
  renderedFrames: number | null;
  droppedFrames: number | null;
  // 网络
  bytesRead: number;
  rangeRequestCount: number;
  requestFailures: number;
  averageThroughputMbps: number | null;
  // 资源
  jsHeapUsedMB: number | null;
  // 黑屏检测：播放 5 秒后采样画布中心区域平均亮度（0-255）
  blackScreenLuminance: number | null;
  // 环境能力与诊断日志
  envInfo: string;
  diagnostics: string[];
  // 其他
  errors: string[];
  notes: string;
}

interface MediaElementLike extends HTMLElement {
  currentTime: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  paused: boolean;
  playbackRate: number;
  getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number };
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

export class PlaybackMetrics {
  private el: MediaElementLike | null = null;
  private source: CountingHttpSource | null = null;

  private loadStartAt = 0;
  private rebufferStartAt = 0;
  private seekStartAt = 0;
  private playedMs = 0;
  private playStartAt = 0;

  report: PlaybackReport;

  constructor(init: { sampleId: string; path: string; route: "raw" | "proxy"; coldOrWarm: "cold" | "warm"; container: string }) {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    this.report = {
      testId: `p1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sampleId: init.sampleId,
      path: init.path,
      route: init.route,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      browser: detectBrowser(),
      os: detectOS(),
      device: navigator.hardwareConcurrency ? `逻辑CPU×${navigator.hardwareConcurrency}` : "未知",
      container: init.container,
      fileSize: null,
      durationSec: null,
      resolution: "",
      videoCodec: "",
      audioCodec: "",
      subtitleFormats: "",
      coldOrWarm: init.coldOrWarm,
      metadataTimeMs: null,
      firstFrameTimeMs: null,
      decoderEngine: "",
      hardwareOrSoftware: "",
      rebufferCount: 0,
      rebufferDurationMs: 0,
      seekTests: [],
      renderedFrames: null,
      droppedFrames: null,
      bytesRead: 0,
      rangeRequestCount: 0,
      requestFailures: 0,
      averageThroughputMbps: null,
      jsHeapUsedMB: mem ? Math.round((mem.usedJSHeapSize / 1024 / 1024) * 100) / 100 : null,
      blackScreenLuminance: null,
      envInfo: "",
      diagnostics: [],
      errors: [],
      notes: "",
    };
  }

  attach(el: MediaElementLike, source: CountingHttpSource): void {
    this.el = el;
    this.source = source;
    this.loadStartAt = performance.now();

    el.addEventListener("loadedmetadata", this.onLoadedMetadata);
    el.addEventListener("playing", this.onPlaying);
    el.addEventListener("waiting", this.onWaiting);
    el.addEventListener("seeking", this.onSeeking);
    el.addEventListener("seeked", this.onSeeked);
    el.addEventListener("error", this.onError);
    el.addEventListener("ratechange", () => this.note(`倍速切换为 ${el.playbackRate}×`));
  }

  detach(): void {
    if (!this.el) return;
    const el = this.el;
    el.removeEventListener("loadedmetadata", this.onLoadedMetadata);
    el.removeEventListener("playing", this.onPlaying);
    el.removeEventListener("waiting", this.onWaiting);
    el.removeEventListener("seeking", this.onSeeking);
    el.removeEventListener("seeked", this.onSeeked);
    el.removeEventListener("error", this.onError);
    this.el = null;
  }

  private onLoadedMetadata = (): void => {
    const el = this.el;
    if (!el) return;
    if (this.report.metadataTimeMs === null) {
      this.report.metadataTimeMs = Math.round(performance.now() - this.loadStartAt);
    }
    if (Number.isFinite(el.duration)) this.report.durationSec = Math.round(el.duration * 100) / 100;
    this.report.resolution = el.videoWidth > 0 ? `${el.videoWidth}×${el.videoHeight}` : "";
  };

  private onPlaying = (): void => {
    const el = this.el;
    if (!el) return;
    if (this.report.firstFrameTimeMs === null) {
      this.report.firstFrameTimeMs = Math.round(performance.now() - this.loadStartAt);
    }
    if (this.rebufferStartAt > 0) {
      this.report.rebufferDurationMs += Math.round(performance.now() - this.rebufferStartAt);
      this.rebufferStartAt = 0;
    }
    this.playStartAt = performance.now();
  };

  private onWaiting = (): void => {
    if (this.rebufferStartAt === 0) {
      this.rebufferStartAt = performance.now();
      this.report.rebufferCount++;
    }
  };

  private onSeeking = (): void => {
    this.seekStartAt = performance.now();
  };

  private onSeeked = (): void => {
    const el = this.el;
    if (!el || this.seekStartAt === 0) return;
    this.report.seekTests.push({
      targetSec: Math.round(el.currentTime * 10) / 10,
      latencyMs: Math.round(performance.now() - this.seekStartAt),
    });
    if (this.report.seekTests.length > 100) this.report.seekTests.shift();
    this.seekStartAt = 0;
  };

  private onError = (): void => {
    const el = this.el as MediaElementLike & { error?: { code?: number; message?: string } };
    const msg = el?.error ? `播放器错误 code=${el.error.code ?? "?"} ${el.error.message ?? ""}` : "播放器错误";
    this.report.errors.push(msg.trim());
  };

  note(text: string): void {
    this.report.notes = this.report.notes ? `${this.report.notes}\n${text}` : text;
  }

  /** 汇总当前指标（可随时调用） */
  snapshot(elapsedPlayMs: number): PlaybackReport {
    const r = this.report;
    if (this.source) {
      r.bytesRead = this.source.bytesRead;
      r.rangeRequestCount = this.source.requestCount;
      r.requestFailures = this.source.failures;
      if (elapsedPlayMs > 0) {
        r.averageThroughputMbps = Math.round(((this.source.bytesRead * 8) / (elapsedPlayMs / 1000) / 1e6) * 100) / 100;
      }
    }
    if (this.el?.getVideoPlaybackQuality) {
      try {
        const q = this.el.getVideoPlaybackQuality();
        r.renderedFrames = q.totalVideoFrames;
        r.droppedFrames = q.droppedVideoFrames;
      } catch {
        // 忽略
      }
    }
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) r.jsHeapUsedMB = Math.round((mem.usedJSHeapSize / 1024 / 1024) * 100) / 100;
    return r;
  }
}

function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Safari/")) return "Safari";
  return "Unknown";
}

function detectOS(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Windows NT 10")) return "Windows 10/11";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Mac OS X")) return "macOS";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("iPhone") || ua.includes("iPad")) return "iOS";
  if (ua.includes("Linux")) return "Linux";
  return "Unknown";
}
