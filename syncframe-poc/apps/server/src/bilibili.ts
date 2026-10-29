/**
 * Bilibili 视频 provider（设计参考 SyncTV 的 bilibili provider）。
 *
 * 职责：
 * - 从用户输入解析 BV 号 / av 号 / bilibili 视频链接；
 * - 经服务端代理解析：view（取标题/cid）→ playurl（取可播放流地址）。
 *   所有请求带桌面 UA + Referer（bilibili 对流地址校验 Referer）；
 *   可选 SESSDATA cookie（登录用户 provider 配置），未登录也可匿名播放（≤1080P）。
 * - 流地址只在服务端使用：浏览器侧统一走 /stream 反代（见 index.ts），
 *   代发 Referer/UA 并透传 Range，解决跨域与防盗链。
 */

import { randomUUID } from "node:crypto";

const API_BASE = "https://api.bilibili.com";
const WEB_ORIGIN = "https://www.bilibili.com";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 播放地址缓存有效期（bilibili 流地址约 2h 过期，保守取 15 分钟）。 */
const PLAYURL_CACHE_MS = 15 * 60 * 1000;

export interface BilibiliVideoRef {
  aid: number;
  bvid: string;
  cid: number;
  title: string;
  /** 封面（仅注册时回显用）。 */
  pic?: string;
}

export interface BilibiliPlayUrl {
  /** 最终可拉流的 mp4 地址（dash 单流或 durl 首段）。 */
  url: string;
  /** 备用地址（dash 无；durl 多段时取首段备用）。 */
  backupUrl?: string;
  /** 流总时长（秒），用于无法取 size 时的提示。 */
  timelength: number;
  /** 流容器类型：mp4 / flv（浏览器仅保证 mp4 可播）。 */
  format: string;
  /** 质量描述，如 "1080P 高清"。 */
  quality: string;
}

export class BilibiliError extends Error {}

/**
 * 从任意用户输入解析出 bvid 或 aid：
 * 支持 "BV1xx411c7mD"、"av170001"、"https://www.bilibili.com/video/BV…"、
 * "bilibili.com/video/av…"、纯 query（bvid=…/aid=…）。解析不到返回 null。
 */
export function parseVideoId(input: string): { bvid?: string; aid?: number } | null {
  const s = input.trim();
  if (!s) return null;
  const bv = /BV1[a-zA-Z0-9]{9}/.exec(s);
  if (bv) return { bvid: bv[0] };
  const av = /(?:av|aid=)(\d{2,})/i.exec(s);
  if (av) return { aid: Number(av[1]) };
  const bvidParam = /[?&]bvid=(BV1[a-zA-Z0-9]{9})/.exec(s);
  if (bvidParam) return { bvid: bvidParam[1] };
  return null;
}

interface BilibiliApiResp<T> {
  code: number;
  message: string;
  data?: T | null;
}

export class BilibiliClient {
  private readonly cookie?: string;
  private readonly timeoutMs: number;
  /** 匿名访问也需要 buvid3/b_nut，否则 bilibili 风控直接 412。 */
  private readonly anonCookie: string;

  constructor(opts: { cookie?: string; timeoutMs?: number } = {}) {
    this.cookie = opts.cookie?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    const buvid3 = randomUUID().replace(/-/g, "") + "infoc";
    this.anonCookie = `buvid3=${buvid3}; b_nut=${Math.floor(Date.now() / 1000)}`;
  }

  private async apiGet<T>(path: string): Promise<T> {
    const url = `${API_BASE}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": DEFAULT_UA,
          Referer: WEB_ORIGIN,
          Cookie: this.cookie ? `${this.anonCookie}; ${this.cookie}` : this.anonCookie,
        },
      });
    } catch (err) {
      throw new BilibiliError(`bilibili 请求失败: ${err instanceof Error ? err.message : err}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new BilibiliError(`bilibili API HTTP ${res.status}`);
    const body = (await res.json()) as BilibiliApiResp<T>;
    if (body.code !== 0) {
      // -404 投稿不存在； -403 风控/需要登录。
      throw new BilibiliError(`bilibili 错误 ${body.code}: ${body.message || "未知错误"}`);
    }
    if (body.data === null || body.data === undefined) throw new BilibiliError("bilibili 返回空数据");
    return body.data;
  }

  /** 视频信息：标题 + 首个分 P 的 cid（PoC 只支持单 P，SynTV 的选 P 后续再加）。 */
  async getVideoInfo(ref: { bvid?: string; aid?: number }): Promise<BilibiliVideoRef> {
    const query = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${ref.aid!}`;
    const data = await this.apiGet<{
      aid: number;
      bvid: string;
      title: string;
      pic?: string;
      cid: number;
      videos?: number;
    }>(`/x/web-interface/view?${query}`);
    if (!data.cid) throw new BilibiliError("无法获取视频 cid（可能是互动视频/充电专属）");
    return { aid: data.aid, bvid: data.bvid, cid: data.cid, title: data.title, pic: data.pic };
  }

  /**
   * 取可播放地址：优先 DASH（mp4 单文件流，带 cookie 时可到 1080P+/Dolby），
   * 失败回退 fnval=1 的 durl mp4 流。URL 仅供服务端拉流（Referer 敏感）。
   */
  async getPlayUrl(bvid: string, cid: number): Promise<BilibiliPlayUrl> {
    const dash = await this.apiGet<{
      dash?: {
        video: { id: number; baseUrl: string; base_url?: string; codecid: number }[];
        audio?: { id: number; baseUrl: string; base_url?: string }[];
        duration: number;
      };
      durl?: { url: string; backup_url?: string[] }[];
      support_formats?: { quality: number; new_description?: string; format?: string }[];
      format?: string;
      quality?: number;
      timelength: number;
    }>(
      `/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=127&fnval=4048&platform=pc`,
    );
    const timelength = Math.round((dash.timelength ?? 0) / 1000);
    const qualityOf = (id: number): string =>
      dash.support_formats?.find((f) => f.quality === id)?.new_description ?? `qn=${id}`;
    // 1) DASH：取最高码率 video/mp4 流（浏览器端 mp4 流可直接播）。
    if (dash.dash?.video?.length) {
      const mp4Videos = dash.dash.video.filter((v) => v.codecid === 7 || !v.codecid);
      const pool = mp4Videos.length ? mp4Videos : dash.dash.video;
      const best = pool.reduce((a, b) => (b.id > a.id ? b : a));
      const url = best.baseUrl ?? best.base_url;
      if (url) {
        return { url, timelength, format: "mp4", quality: qualityOf(best.id) };
      }
    }
    // 2) durl（flv/mp4 分段）：取首段。
    if (dash.durl?.length) {
      const first = dash.durl[0];
      return {
        url: first.url,
        backupUrl: first.backup_url?.[0],
        timelength,
        format: dash.format?.toLowerCase().includes("mp4") ? "mp4" : "flv",
        quality: qualityOf(dash.quality ?? 0),
      };
    }
    throw new BilibiliError("bilibili 未返回可播放流地址（可能需要登录 cookie）");
  }
}

/** playurl 结果缓存（按 bvid:cid），避免每次 grant/stream 都请求 bilibili。 */
interface CacheEntry {
  at: number;
  promise: Promise<BilibiliPlayUrl>;
}
const playUrlCache = new Map<string, CacheEntry>();

/** 带缓存的 playurl 解析；缓存 15 分钟。bilibili 客户端由调用方按 cookie 提供。 */
export function getPlayUrlCached(client: BilibiliClient, bvid: string, cid: number): Promise<BilibiliPlayUrl> {
  const key = `${bvid}:${cid}`;
  const hit = playUrlCache.get(key);
  if (hit && hit.at > Date.now() - PLAYURL_CACHE_MS) return hit.promise;
  const promise = client.getPlayUrl(bvid, cid);
  playUrlCache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    // 失败不缓存：下次重试。
    if (playUrlCache.get(key)?.promise === promise) playUrlCache.delete(key);
  });
  return promise;
}
