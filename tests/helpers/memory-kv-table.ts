import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

export class FakeTable<K extends string, V> implements KvTable<K, V> {
  readonly map = new Map<K, V>()

  get(key: K): V | undefined {
    return this.map.get(key)
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries()
  }

  keys(): IterableIterator<K> {
    return this.map.keys()
  }

  get size(): number {
    return this.map.size
  }

  async put(key: K, value: V): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: K): Promise<boolean> {
    return this.map.delete(key)
  }

  async deleteMany(keys: readonly K[]): Promise<number> {
    let deleted = 0
    for (const key of keys) {
      if (this.map.delete(key)) deleted++
    }
    return deleted
  }

  async update(key: K, fn: (current: V) => V): Promise<V> {
    const current = this.map.get(key)
    if (current === undefined) throw new Error(`missing key ${key}`)
    const next = fn(current)
    this.map.set(key, next)
    return next
  }
}
