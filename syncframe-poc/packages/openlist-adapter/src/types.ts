/**
 * OpenList API 类型定义。
 * 契约对齐 SyncTV synctv-media-providers 的 alist provider（POST JSON body，
 * user_agent 参与 raw_url 生成），并做宽容反序列化（时间戳数字/字符串、null 数组）。
 */

export interface OpenListClientConfig {
  /** OpenList 实例根地址，例如 http://192.168.1.10:5244；不允许含用户info/查询串 */
  baseUrl: string;
  /** 请求超时（毫秒），默认 15000 */
  timeoutMs?: number;
  /** 已有令牌（跳过 login） */
  token?: string;
  /** 请求失败重试次数（网络错误/5xx/429），默认 2 */
  retries?: number;
}

/** OpenList 统一响应包裹 */
export interface OpenListEnvelope<T> {
  code: number;
  message: string;
  data?: T | null;
}

export interface LoginResult {
  token: string;
}

/** 时间戳可能是数字秒/毫秒或 RFC3339 字符串，统一转成毫秒时间戳 */
export type OpenListTime = number | string;

export interface FsGetResult {
  name: string;
  size: number;
  is_dir: boolean;
  modified?: OpenListTime;
  created?: OpenListTime;
  sign?: string;
  thumb?: string;
  type?: number;
  hashinfo?: string;
  /** 实际存储直链（可能带签名参数，部分存储与 user_agent 绑定） */
  raw_url?: string;
  readme?: string;
  provider?: string;
  /** 同目录相关文件（外挂字幕等）；服务端可能返回 null */
  related?: FsRelatedItem[] | null;
  [key: string]: unknown;
}

export interface FsRelatedItem {
  name: string;
  size: number;
  is_dir: boolean;
  modified?: OpenListTime;
  created?: OpenListTime;
  sign?: string;
  thumb?: string;
  type?: number;
  hashinfo?: string;
  /** 相关文件自身的直链（部分版本提供） */
  raw_url?: string;
  provider?: string;
  [key: string]: unknown;
}

export interface FsListItem {
  name: string;
  path?: string;
  size: number;
  is_dir: boolean;
  modified?: OpenListTime;
  sign?: string;
  thumb?: string;
  type?: number;
  [key: string]: unknown;
}

export interface FsListResult {
  /** 服务端可能返回 null */
  content?: FsListItem[] | null;
  total: number;
  readme?: string;
  header?: string;
  write?: boolean;
  provider?: string;
}

export interface FsSearchItem {
  parent: string;
  name: string;
  is_dir: boolean;
  size: number;
  type?: number;
}

export interface FsSearchResult {
  content?: FsSearchItem[] | null;
  total: number;
}

/** 登录态用户信息；role 可能是数字或数组（多角色取最大） */
export interface MeResult {
  id: number;
  username: string;
  base_path?: string;
  role?: number | number[];
  disabled?: boolean;
  permission?: number;
  otp?: boolean;
  [key: string]: unknown;
}
