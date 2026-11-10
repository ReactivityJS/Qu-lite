/**
 * Types for the members plugins add to a peer at runtime - what
 * `createClient()` / `createPeer()` return. The kernel (`createQu`) is typed
 * from its JSDoc; plugin members are declared here by hand because plugins
 * attach them dynamically. Everything a plugin adds that is not listed here
 * stays reachable (index signature, `any`).
 */
import type { createQu } from './qu.js';
import type { Space } from './space.js';

type Kernel = Awaited<ReturnType<typeof createQu>>;

/** A record as `write`, `query` and `qu.record.<sid>` deliver it. */
export interface QuRecord<V = unknown> {
  id: string;
  path: string;
  /** null for log entries, the entry key for last-write-wins entries */
  key: string | null;
  value: V;
  /** hybrid logical clock, sortable string */
  hlc: string;
  /** author alias (hex) */
  author: string;
  /** coarse time (minute), ms */
  ts: number;
  epoch: number;
  visibility: 'private' | 'public';
  deleted?: boolean;
  type?: string;
  /** true for records written on this device */
  local?: boolean;
}

export interface QueryOptions {
  space: Space;
  path: string;
  /** inclusive, ms */
  from?: number;
  /** exclusive, ms */
  to?: number;
  limit?: number;
  reverse?: boolean;
  /** reconcile the window with connected peers first (needs sync) */
  ensure?: boolean;
}

export interface Member {
  alias: string;
  role: 'owner' | 'admin' | 'member' | 'removed' | string;
  xpub?: string;
  identity?: string;
  name?: string;
  verified?: boolean;
  me?: boolean;
}

export interface Invite {
  type: 'invite';
  [field: string]: unknown;
}

export interface MembersManager {
  /** own alias in this space (hex) */
  me: string;
  list(): Member[];
  role(alias?: string): Member['role'] | null;
  isAdmin(alias?: string): boolean;
  invite(identityPub?: string | null, options?: { role?: 'member' | 'admin'; expiresIn?: number | null }): Promise<Invite>;
  reveal(options?: { name?: string }): Promise<unknown>;
  promote(alias: string, role: 'member' | 'admin'): Promise<unknown>;
  remove(alias: string): Promise<number>;
  rotate(): Promise<number>;
  /** anyone with the link may write (`createGroup({ open: true })`) */
  readonly open: boolean;
  bans(): string[];
  /** an invite without token: write access in an open space, read-only otherwise */
  link(): Promise<Invite>;
  ban(alias: string): Promise<void>;
  unban(alias: string): Promise<void>;
  [method: string]: any;
}

export interface UserView {
  space: Space;
  id: string;
  get(field: string): Promise<unknown>;
  fields(): Promise<Record<string, unknown>>;
}
export interface OwnUserView extends UserView {
  set(field: string, value: unknown, options?: { visibility?: 'public' | 'private' }): Promise<QuRecord>;
  getPrivate(field: string): Promise<unknown>;
  privateFields(): Promise<Record<string, unknown>>;
}

export interface SyncSummary {
  peer: string;
  sid: string;
  shard: string | null;
  sent: number;
  received: number;
  missing: string[];
  error?: string;
}

export interface StatusTracker {
  space: Space;
  online(): Map<string, { lastSeen: number; state: string; online: boolean; every?: number }>;
  isOnline(alias: string): boolean;
  typing(path: string): string[];
  sendTyping(path: string): Promise<void>;
  markRead(path: string, hlc?: string): Promise<void>;
  of(record: QuRecord): Promise<{ sent: boolean; delivered: string[]; read: string[]; members: number }>;
  leave(): Promise<void>;
  [method: string]: any;
}

export interface DeviceStatus {
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
  backupAt: number | null;
  groups: number;
  locked: boolean;
}

export interface DeviceApi {
  exportBackup(passphrase: string): Promise<string>;
  downloadBackup(passphrase: string, filename?: string): Promise<string>;
  persist(): Promise<boolean | null>;
  status(): Promise<DeviceStatus>;
  lock(passphrase: string): Promise<void>;
  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void>;
  removeLock(passphrase: string): Promise<void>;
}

export interface TransportApi {
  connect(origins: string | string[]): void;
  disconnect(): void;
  status(): Array<{ url: string; connected: boolean; peer: string | null; via?: string; scope?: string[] }>;
  readonly urls?: string[];
  readonly via?: 'ws' | 'sse' | null;
  [member: string]: any;
}

export interface BackgroundApi {
  /** what the outbox still holds */
  progress(): Promise<{ records: number; bytes: number }>;
  /** resolves with `backgroundSync` once known */
  ready: Promise<boolean>;
  /** true: Background Sync delivers the outbox; false: wake lock fallback; null: not known yet */
  readonly backgroundSync: boolean | null;
  readonly awake: boolean;
}

export interface PushApi {
  /** set when the app was opened from a notification */
  readonly opened: { sid: string; kind: 'call' | 'message' } | null;
  supported(): boolean;
  enable(spaces: Space[], options?: { labels?: Record<string, string>; paths?: string[] | null }): Promise<string[]>;
  disable(spaces?: Space[]): Promise<void>;
  labels(map: Record<string, string>): Promise<void>;
  ring(space: Space, options?: { kind?: 'call' | 'message' }): Promise<number>;
}

export interface DevTools {
  help(): void;
  info(): { peerId: string; publicKey: string | null; plugins: string[]; mounts: string[]; links: number; uptime: number; closed: boolean };
  links(): object[];
  transports(): object[];
  trace(pattern?: string, options?: { persist?: boolean; filter?: (topic: string, payload: unknown) => boolean }): () => void;
  untrace(): void;
  spaces(): object[];
  pending(): Promise<{ outbox: number; pending: number } | string>;
  ls(prefix?: string, limit?: number): Promise<object[]>;
  get(key: string): Promise<unknown>;
  dump(prefix?: string, limit?: number): Promise<Record<string, unknown>>;
  stats(): Promise<unknown>;
  traffic(): { since: number; seconds: number; bytes: number; frames: number; wireEstimate: number; byType: Record<string, { framesIn: number; bytesIn: number; framesOut: number; bytesOut: number }> };
  watchTraffic(seconds?: number): () => void;
  resetTraffic(): void;
  listeners(topic: string): number;
  emit(topic: string, payload?: unknown): Promise<unknown>;
}

/** A peer as `createClient()` / `createPeer()` return it: the kernel plus what the installed plugins add. */
export interface Qu extends Kernel {
  // records
  join(space: Space, options?: { author?: unknown; mirror?: boolean }): Space;
  space(sid: string): Space | null;
  write<V = unknown>(space: Space, path: string, value: V, options?: { key?: string; visibility?: 'private' | 'public' }): Promise<QuRecord<V>>;
  get<V = unknown>(space: Space, path: string, key: string): Promise<V | null>;
  query<V = unknown>(options: QueryOptions): Promise<QuRecord<V>[]>;
  // members
  createGroup(options?: { open?: boolean; mirror?: boolean }): Promise<Space>;
  members(space: Space): Promise<MembersManager>;
  acceptInvite(invite: Invite): Promise<Space>;
  restoreGroups(): Promise<Space[]>;
  // user
  me(): Promise<OwnUserView>;
  user(publicKeyHex: string): Promise<UserView>;
  // sync
  watch(options: { space: Space; path?: string; from?: number; to?: number }): Promise<() => void>;
  resync(options?: { space?: Space; path?: string; from?: number; to?: number }): Promise<SyncSummary[]>;
  syncStatus(): Promise<{ outbox: number; pending: number }>;
  syncState(sid: string, id: string): Promise<'pending' | 'sent'>;
  lastSync(sid: string, shard?: string | null): Promise<number | null>;
  // status
  status: ((space: Space) => Promise<StatusTracker>) & { setHidden(hidden: boolean): void; isHidden(): boolean };
  // device, devtools, transports
  device: DeviceApi;
  /** plugin `background` */
  background: BackgroundApi;
  /** plugin `push` */
  push: PushApi;
  /** delete a record (or a keyed entry) - own ones, or anyone's as admin (plugin `compaction`) */
  del(space: Space, recordOrId: QuRecord | string): Promise<void>;
  del(space: Space, path: string, key: string): Promise<void>;
  dev: DevTools;
  transports: Record<string, TransportApi>;
  /** the root store driver */
  root: object;
  /** anything else a plugin added */
  [member: string]: any;
}
