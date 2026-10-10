import Redis from 'ioredis';

interface Entry {
  value: string;
  expiresAt?: number;
}

/**
 * An in-memory stand-in for the handful of Redis commands the unit specs rely on. Honours expiry
 * through `Date.now()`, so a spec can move time with jest fake timers.
 */
export class FakeRedis {
  private readonly strings = new Map<string, Entry>();
  private readonly sets = new Map<string, Set<string>>();

  get(key: string): Promise<string | null> {
    const entry = this.strings.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  mget(...keys: string[]): Promise<Array<string | null>> {
    return Promise.all(keys.map((key) => this.get(key)));
  }

  set(
    key: string,
    value: string,
    mode?: 'EX' | 'PX' | 'KEEPTTL',
    ttl?: number,
  ): Promise<'OK'> {
    if (mode === 'KEEPTTL') {
      const previous = this.strings.get(key);
      this.strings.set(key, { value, expiresAt: previous?.expiresAt });
      return Promise.resolve('OK');
    }
    const factor = mode === 'EX' ? 1000 : 1;
    this.strings.set(key, {
      value,
      expiresAt:
        mode !== undefined && ttl !== undefined
          ? Date.now() + ttl * factor
          : undefined,
    });
    return Promise.resolve('OK');
  }

  del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
    }
    return Promise.resolve(removed);
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const before = set.size;
    for (const member of members) set.add(member);
    this.sets.set(key, set);
    return Promise.resolve(set.size - before);
  }

  srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return Promise.resolve(0);
    let removed = 0;
    for (const member of members) if (set.delete(member)) removed += 1;
    return Promise.resolve(removed);
  }

  sismember(key: string, member: string): Promise<number> {
    return Promise.resolve(this.sets.get(key)?.has(member) ? 1 : 0);
  }

  smembers(key: string): Promise<string[]> {
    return Promise.resolve([...(this.sets.get(key) ?? [])]);
  }

  rename(source: string, destination: string): Promise<'OK'> {
    const set = this.sets.get(source);
    if (!set) return Promise.reject(new Error('ERR no such key'));
    this.sets.set(destination, set);
    this.sets.delete(source);
    return Promise.resolve('OK');
  }

  ping(): Promise<'PONG'> {
    return Promise.resolve('PONG');
  }

  /** Test-only peeks. */
  keys(): string[] {
    return [...this.strings.keys(), ...this.sets.keys()];
  }

  asRedis(): Redis {
    return this as unknown as Redis;
  }
}
