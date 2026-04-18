'use strict';

// Bounded FIFO buffer with drop-oldest semantics.
// Uses a ring in a fixed-size array to avoid unbounded array growth.
class BoundedBuffer {
  constructor(name, capacity) {
    this.name = name;
    this.capacity = Math.max(1, capacity | 0);
    this._buf = new Array(this.capacity);
    this._head = 0;
    this._tail = 0;
    this._size = 0;
    this._dropped = 0;
    this._enqueued = 0;
  }

  get size() {
    return this._size;
  }

  get dropped() {
    return this._dropped;
  }

  push(item) {
    this._enqueued++;
    if (this._size === this.capacity) {
      // Drop oldest: advance head.
      this._buf[this._head] = undefined;
      this._head = (this._head + 1) % this.capacity;
      this._size--;
      this._dropped++;
    }
    this._buf[this._tail] = item;
    this._tail = (this._tail + 1) % this.capacity;
    this._size++;
  }

  // Drain up to `max` items from the buffer, preserving insertion order.
  drain(max) {
    const take = Math.min(this._size, Math.max(0, max | 0) || this._size);
    const out = new Array(take);
    for (let i = 0; i < take; i++) {
      out[i] = this._buf[this._head];
      this._buf[this._head] = undefined;
      this._head = (this._head + 1) % this.capacity;
    }
    this._size -= take;
    return out;
  }

  // Peek at oldest `max` items without removing them.
  peek(max) {
    const take = Math.min(this._size, Math.max(0, max | 0) || this._size);
    const out = new Array(take);
    let idx = this._head;
    for (let i = 0; i < take; i++) {
      out[i] = this._buf[idx];
      idx = (idx + 1) % this.capacity;
    }
    return out;
  }

  // Put a batch back at the head (used after a failed flush to preserve order).
  // Drops oldest again if the returned batch + current queue exceeds capacity.
  requeueFront(items) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (this._size === this.capacity) {
        // Drop the tail (newest) to keep oldest data.
        this._tail = (this._tail - 1 + this.capacity) % this.capacity;
        this._buf[this._tail] = undefined;
        this._size--;
        this._dropped++;
      }
      this._head = (this._head - 1 + this.capacity) % this.capacity;
      this._buf[this._head] = items[i];
      this._size++;
    }
  }

  snapshot() {
    return {
      name: this.name,
      size: this._size,
      capacity: this.capacity,
      dropped: this._dropped,
      enqueued: this._enqueued,
    };
  }
}

// BufferRegistry groups per-channel buffers behind a single accessor.
class BufferRegistry {
  constructor(capacities) {
    this._channels = new Map();
    for (const [name, cap] of Object.entries(capacities)) {
      this._channels.set(name, new BoundedBuffer(name, cap));
    }
  }

  get(name) {
    const b = this._channels.get(name);
    if (!b) throw new Error('unknown channel: ' + name);
    return b;
  }

  snapshots() {
    const out = {};
    for (const [name, b] of this._channels) out[name] = b.snapshot();
    return out;
  }
}

module.exports = { BoundedBuffer, BufferRegistry };
