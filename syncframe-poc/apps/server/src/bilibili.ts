/**
 * Bilibili 视频 provider（设计参考 SyncTV 的 bilibili provider）。
 *
 * 职责：
 * - 从用户输入解析 BV 号 / av 号 / 番剧 ep/ss / bilibili 链接；
 * - 经服务端代理解析：view（取标题/cid）→ playurl（取可播放流地址）；
 *   所有请求带桌面 UA + Referer（bilibili 对流地址校验 Referer）；
 *   SESSDATA 由调用方按请求提供（前端 localStorage 持有，服务端不落盘），匿名也可播放。
 * - 播放地址分两条路：
 *   * 直连：mcdn 边缘节点不校验 Referer 且带 ACAO:*，浏览器可直接拉流（服务器 0 带宽）；
 *   * 反代：其余主机（如 *.bilivideo.com）强制校验 Referer，只能走服务端 /stream（见 index.ts）。
 */

import { createHash, randomUUID } from "node:crypto";

const API_BASE = "https://api.bilibili.com";
const WEB_ORIGIN = "https://www.bilibili.com";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 播放地址缓存有效期（bilibili 流地址约 2h 过期，保守取 15 分钟）。 */
const PLAYURL_CACHE_MS = 15 * 60 * 1000;

export interface BilibiliVideoRef {
  aid?: number;
  bvid?: string;
  cid: number;
  title: string;
  /** 封面（仅注册时回显用）。 */
  pic?: string;
  /** 番剧条目：ep 号（pgc playurl 需要 ep_id）。 */
  epId?: number;
}

/** 番剧（pgc）单集信息。 */
export interface BangumiEpisodeRef {
  epId: number;
  cid: number;
  bvid?: string;
  aid?: number;
  /** 展示标题：季标题 + 单集标题。 */
  title: string;
}

export interface BilibiliPlayUrl {
  /** 视频流地址（dash 最高画质 / durl 首段）。 */
  url: string;
  /** 独立音轨地址（dash.audio 最高码率）。durl 音画合一时为空。 */
  audioUrl?: string;
  /** 备用地址（dash 无；durl 多段时取首段备用）。 */
  backupUrl?: string;
  /** 流总时长（秒），用于无法取 size 时的提示。 */
  timelength: number;
  /** 流容器类型：mp4 / flv（浏览器仅保证 mp4 可播）。 */
  format: string;
  /** 质量描述，如 "1080P 高清"。 */
  quality: string;
  /**
   * 浏览器可否直连该地址（不校验 Referer 且允许跨域）。
   * true 时由浏览器直接拉流（服务器不耗带宽）；false 时必须走 /stream 反代。
   */
  directOk: boolean;
}

/** 实测：mcdn 边缘节点不校验 Referer，且返回 Access-Control-Allow-Origin: *。 */
const DIRECT_PLAYABLE_HOSTS = ["mcdn.bilivideo.cn"];

/** 该地址是否可由浏览器直连（用于决定走直连还是 /stream 反代）。 */
export function isDirectPlayableHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return DIRECT_PLAYABLE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** 凭证指纹：仅用于内存缓存分组，不保存明文。无凭证时为 "anon"。 */
export function credentialFingerprint(cookie?: string | null): string {
  if (!cookie) return "anon";
  return createHash("sha256").update(cookie).digest("hex").slice(0, 16);
}

/**
 * 校验并规整 SESSDATA 头：只接受单个 `SESSDATA=<value>`。
 *
 * 注意 B 站 SESSDATA 是 URL 编码的（含 `%2C` 等），因此取值字符集必须允许 `%`；
 * 只要排除分号与空白即可（避免把多个 cookie 拼进来）。真实值约 60-120 字符。
 */
export function parseSessdata(raw: string | null | undefined, maxLen = 512): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > maxLen) return null;
  return /^SESSDATA=[^;\s]{4,256}$/.test(value) ? value : null;
}

export class BilibiliError extends Error {}

/**
 * 从任意用户输入解析出 bvid / aid / 番剧 ep / 季 ss：
 * 支持 "BV1xx411c7mD"、"av170001"、bilibili 视频/番剧链接、纯 ep12345 / ss12345。
 * 解析不到返回 null。
 */
export function parseVideoId(input: string): { bvid?: string; aid?: number; epId?: number; seasonId?: number } | null {
  const s = input.trim();
  if (!s) return null;
  const bv = /BV1[a-zA-Z0-9]{9}/.exec(s);
  if (bv) return { bvid: bv[0] };
  const av = /(?:av|aid=)(\d{2,})/i.exec(s);
  if (av) return { aid: Number(av[1]) };
  const bvidParam = /[?&]bvid=(BV1[a-zA-Z0-9]{9})/.exec(s);
  if (bvidParam) return { bvid: bvidParam[1] };
  // 番剧：/bangumi/play/ep12345、/bangumi/media/ss12345、?ep_id=、纯 ep/ss 号。
  const ep = /(?:\/bangumi\/play\/ep|ep_id=|^\s*ep)(\d{2,})/i.exec(s);
  if (ep) return { epId: Number(ep[1]) };
  const ss = /(?:\/bangumi\/media\/ss|season_id=|^\s*ss)(\d{2,})/i.exec(s);
  if (ss) return { seasonId: Number(ss[1]) };
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

  constructor(opts: { cookie?: string; timeoutMs?: number; buvidSeed?: string } = {}) {
    this.cookie = opts.cookie?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    // 按凭证派生的稳定 buvid3：避免每个请求换设备指纹触发风控，同时不落任何持久化状态。
    const seed = (opts.buvidSeed ?? randomUUID()).replace(/[^a-z0-9]/gi, "");
    this.anonCookie = `buvid3=${seed.slice(0, 32)}infoc; b_nut=${Math.floor(Date.now() / 1000)}`;
  }

  private async apiGet<T>(path: string, payloadKey: "data" | "result" = "data"): Promise<T> {
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
    const body = (await res.json()) as BilibiliApiResp<T> & { result?: T | null };
    if (body.code !== 0) {
      // -404 投稿不存在； -403 风控/需要登录。
      throw new BilibiliError(`bilibili 错误 ${body.code}: ${body.message || "未知错误"}`);
    }
    const payload = payloadKey === "result" ? body.result : body.data;
    if (payload === null || payload === undefined) throw new BilibiliError("bilibili 返回空数据");
    return payload;
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
   * 番剧（pgc）信息：按 ep 号或季 ss 号解析出单集的 cid/epId/标题。
   * 未登录/无权限的会员番剧会在此报 -403（游客看不了，需房主先扫码登录）。
   */
  async getBangumiInfo(ref: { epId?: number; seasonId?: number }): Promise<BangumiEpisodeRef> {
    const query = ref.epId ? `ep_id=${ref.epId}` : `season_id=${ref.seasonId!}`;
    const data = await this.apiGet<{
      title?: string;
      season_title?: string;
      episodes?: {
        id: number;
        cid: number;
        aid?: number;
        bvid?: string;
        title?: string;
        long_title?: string;
      }[];
    }>(`/pgc/view/web/season?${query}`, "result");
    const episodes = data.episodes ?? [];
    if (!episodes.length) throw new BilibiliError("无法获取番剧集信息（可能需要登录 cookie）");
    const ep = ref.epId ? episodes.find((e) => e.id === ref.epId) : episodes[0];
    if (!ep || !ep.cid) throw new BilibiliError(`番剧集不存在（ep=${ref.epId ?? "?"}）`);
    const season = data.season_title ?? data.title ?? "番剧";
    const epTitle = ep.long_title || ep.title || `第 ${ep.title ?? ep.id} 集`;
    return { epId: ep.id, cid: ep.cid, aid: ep.aid, bvid: ep.bvid, title: `${season} ${epTitle}`.trim() };
  }

  /**
   * 取可播放地址：优先 DASH（mp4 单文件流，带 cookie 时可到 1080P+/Dolby；
   * 未登录最多 1080P，番剧/会员内容可能直接 -403），失败回退 durl mp4 流。
   * ref 传 {bvid, cid}（普通视频）或 {epId, cid}（番剧，走 /pgc/player/web/playurl）。
   * URL 仅供服务端拉流（Referer 敏感）。
   */
  async getPlayUrl(ref: { bvid?: string; cid: number; epId?: number }): Promise<BilibiliPlayUrl> {
    const playUrlPath = ref.epId
      ? `/pgc/player/web/playurl?ep_id=${ref.epId}&cid=${ref.cid}&qn=127&fnval=4048&platform=pc`
      : `/x/player/playurl?bvid=${encodeURIComponent(ref.bvid!)}&cid=${ref.cid}&qn=127&fnval=4048&platform=pc`;
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
    }>(playUrlPath, ref.epId ? "result" : "data");
    const timelength = Math.round((dash.timelength ?? 0) / 1000);
    const qualityOf = (id: number): string =>
      dash.support_formats?.find((f) => f.quality === id)?.new_description ?? `qn=${id}`;
    // 1) DASH：取最高画质 video 流 + 独立音频流（B 站音视频分离，缺音轨会静音）。
    if (dash.dash?.video?.length) {
      const mp4Videos = dash.dash.video.filter((v) => v.codecid === 7 || !v.codecid);
      const pool = mp4Videos.length ? mp4Videos : dash.dash.video;
      const best = pool.reduce((a, b) => (b.id > a.id ? b : a));
      const url = best.baseUrl ?? best.base_url;
      if (url) {
        const bestAudio = dash.dash.audio?.length
          ? dash.dash.audio.reduce((a, b) => (b.id > a.id ? b : a))
          : undefined;
        const audioUrl = bestAudio ? (bestAudio.baseUrl ?? bestAudio.base_url) : undefined;
        return {
          url,
          audioUrl,
          timelength,
          format: "mp4",
          quality: qualityOf(best.id),
          directOk: isDirectPlayableHost(url) && (!audioUrl || isDirectPlayableHost(audioUrl)),
        };
      }
    }
    // 2) durl（flv/mp4 分段）：取首段。多段即音画合一但后续分片无法随机访问，保守走反代。
    if (dash.durl?.length) {
      const first = dash.durl[0];
      return {
        url: first.url,
        backupUrl: first.backup_url?.[0],
        timelength,
        format: dash.format?.toLowerCase().includes("mp4") ? "mp4" : "flv",
        quality: qualityOf(dash.quality ?? 0),
        directOk: false,
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

/** 带缓存的 playurl 解析；缓存 15 分钟。key 含凭证指纹，避免跨用户复用画质结果。 */
export function getPlayUrlCached(
  client: BilibiliClient,
  ref: { bvid?: string; cid: number; epId?: number },
  fingerprint = "anon",
): Promise<BilibiliPlayUrl> {
  const media = ref.epId ? `ep${ref.epId}:${ref.cid}` : `${ref.bvid}:${ref.cid}`;
  const key = `${fingerprint}:${media}`;
  const hit = playUrlCache.get(key);
  if (hit && hit.at > Date.now() - PLAYURL_CACHE_MS) return hit.promise;
  const promise = client.getPlayUrl(ref);
  playUrlCache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    // 失败不缓存：下次重试。
    if (playUrlCache.get(key)?.promise === promise) playUrlCache.delete(key);
  });
  return promise;
}
