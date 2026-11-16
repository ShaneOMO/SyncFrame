import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { extractSessdata } from "./bilibili-login.ts";

export interface BiliSession {
  cookie: string;
  uname: string;
  buvidSeed: string;
  validatedAt: number;
}

interface StoredSession extends BiliSession {
  version: 1;
}

const VALIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class BiliSessionStore {
  private readonly file: string;
  private session: BiliSession | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "bilibili-session.json");
    this.session = this.read();
  }

  get(): BiliSession | null {
    return this.session ? { ...this.session } : null;
  }

  save(cookie: string, uname: string): BiliSession {
    if (!extractSessdata(cookie)) throw new Error("登录结果中没有 SESSDATA");
    const previous = this.session;
    const next: BiliSession = {
      cookie,
      uname,
      buvidSeed: previous?.buvidSeed ?? randomUUID(),
      validatedAt: Date.now(),
    };
    this.persist(next);
    this.session = next;
    return { ...next };
  }

  markValid(uname: string): BiliSession {
    if (!this.session) throw new Error("没有可校验的 B 站会话");
    const next = { ...this.session, uname: uname || this.session.uname, validatedAt: Date.now() };
    this.persist(next);
    this.session = next;
    return { ...next };
  }

  needsValidation(): boolean {
    return !this.session || Date.now() - this.session.validatedAt > VALIDATION_INTERVAL_MS;
  }

  clear(): void {
    this.session = null;
    rmSync(this.file, { force: true });
  }

  private read(): BiliSession | null {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoredSession>;
      if (
        raw.version !== 1
        || typeof raw.cookie !== "string"
        || !extractSessdata(raw.cookie)
        || typeof raw.buvidSeed !== "string"
        || typeof raw.validatedAt !== "number"
      ) return null;
      return {
        cookie: raw.cookie,
        uname: typeof raw.uname === "string" ? raw.uname : "",
        buvidSeed: raw.buvidSeed,
        validatedAt: raw.validatedAt,
      };
    } catch {
      return null;
    }
  }

  private persist(session: BiliSession): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const stored: StoredSession = { version: 1, ...session };
    writeFileSync(temp, JSON.stringify(stored), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
