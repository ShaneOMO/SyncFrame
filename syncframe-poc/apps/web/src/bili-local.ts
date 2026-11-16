export interface BiliVideoRef {
  bvid?: string;
  cid: number;
  aid?: number;
  epId?: number;
}

export interface LocalBiliStatus {
  available: boolean;
  authenticated: boolean;
  uname: string;
}

export interface LocalBiliPlay {
  url: string;
  audioUrl?: string;
  fallbackUrl: string;
  fallbackAudioUrl?: string;
  direct: boolean;
  quality: string;
  format: string;
  timelength: number;
}

export class BiliLocalError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = "",
  ) {
    super(message);
  }
}

function localBaseUrl(): string {
  const raw = import.meta.env.VITE_SYNCFRAME_LOCAL_URL ?? "http://127.0.0.1:8788";
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new BiliLocalError("本机助手地址只能使用 127.0.0.1 / localhost");
  }
  return url.origin;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${localBaseUrl()}${path}`, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    if (err instanceof BiliLocalError) throw err;
    throw new BiliLocalError("无法连接本机助手，请运行 npm run p1:local 后重试");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new BiliLocalError(body.error ?? `本机助手 HTTP ${res.status}`, res.status, body.code);
  return body as T;
}

export async function getLocalBiliStatus(): Promise<LocalBiliStatus> {
  const body = await request<{ ok: true; authenticated: boolean; uname?: string }>("/health");
  return { available: true, authenticated: body.authenticated, uname: body.uname ?? "" };
}

export async function validateLocalBiliSession(): Promise<LocalBiliStatus> {
  const body = await request<{ authenticated: true; uname?: string }>("/session/validate", { method: "POST" });
  return { available: true, authenticated: true, uname: body.uname ?? "" };
}

export async function startLocalBiliLogin(): Promise<{ url: string; qrcodeKey: string }> {
  return request("/login/qrcode", { method: "POST" });
}

export async function pollLocalBiliLogin(qrcodeKey: string): Promise<{ status: string; uname?: string }> {
  return request(`/login/poll?qrcodeKey=${encodeURIComponent(qrcodeKey)}`);
}

export async function clearLocalBiliSession(): Promise<void> {
  await request("/session", { method: "DELETE" });
}

export async function resolveLocalBiliVideo(url: string): Promise<{ name: string; bilibili: BiliVideoRef }> {
  return request("/resolve", { method: "POST", body: JSON.stringify({ url }) });
}

export async function playLocalBiliVideo(ref: BiliVideoRef): Promise<LocalBiliPlay> {
  const body = await request<Omit<LocalBiliPlay, "fallbackUrl" | "fallbackAudioUrl"> & {
    fallbackUrl: string;
    fallbackAudioUrl?: string;
  }>("/play", { method: "POST", body: JSON.stringify(ref) });
  return {
    ...body,
    fallbackUrl: new URL(body.fallbackUrl, localBaseUrl()).toString(),
    fallbackAudioUrl: body.fallbackAudioUrl ? new URL(body.fallbackAudioUrl, localBaseUrl()).toString() : undefined,
  };
}
