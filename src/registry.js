/**
 * REGISTRY - `(slot, name) -> factory`, the same idea as `@qu/bootstrap`'s
 * `AdapterRegistry` (packages/bootstrap/src/adapter-registry.js), kept
 * dependency-free here so `@qu/lite` never pulls in the Yjs-based packages.
 * Empty by default: nothing is imported unless a caller registers it.
 */
export class Registry {
  #factories = new Map();

  /** @param {string} slot @param {string} name @param {(options: object) => *} factory @returns {this} */
  register(slot, name, factory) {
    const key = `${slot}:${name}`;
    if (this.#factories.has(key)) throw new Error(`Registry: "${name}" is already registered for slot "${slot}"`);
    this.#factories.set(key, factory);
    return this;
  }

  /** @param {string} slot @param {string} name */
  has(slot, name) {
    return this.#factories.has(`${slot}:${name}`);
  }

  /** @param {string} slot @returns {string[]} */
  names(slot) {
    const prefix = `${slot}:`;
    return [...this.#factories.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  /** @param {string} slot @param {string} name @param {object} [options] @returns {Promise<*>} */
  async create(slot, name, options = {}) {
    const factory = this.#factories.get(`${slot}:${name}`);
    if (!factory) {
      const known = this.names(slot);
      throw new Error(`Registry: no "${name}" registered for slot "${slot}" (known: ${known.join(', ') || 'none'})`);
    }
    return await factory(options);
  }
}
