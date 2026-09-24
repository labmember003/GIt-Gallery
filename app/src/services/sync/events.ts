import { Listener } from './types';

type Callback = (...args: any[]) => void;

type Subscription = {
  callback: Callback;
  once: boolean;
};

export class EventEmitter<T extends Record<string, any>> {
  private listeners: Map<keyof T, Subscription[]> = new Map();

  on<K extends keyof T>(event: K, callback: (payload: T[K]) => void): () => void {
    const subs = this.listeners.get(event) ?? [];
    subs.push({ callback: callback as Callback, once: false });
    this.listeners.set(event, subs);
    return () => this.off(event, callback as Callback);
  }

  once<K extends keyof T>(event: K, callback: (payload: T[K]) => void): () => void {
    const subs = this.listeners.get(event) ?? [];
    subs.push({ callback: callback as Callback, once: true });
    this.listeners.set(event, subs);
    return () => this.off(event, callback as Callback);
  }

  off<K extends keyof T>(event: K, callback: Callback): void {
    const subs = this.listeners.get(event);
    if (!subs) return;
    const next = subs.filter((sub) => sub.callback !== callback);
    this.listeners.set(event, next);
  }

  emit<K extends keyof T>(event: K, payload: T[K]): void {
    const subs = this.listeners.get(event);
    if (!subs || subs.length === 0) return;

    const retained: Subscription[] = [];
    for (const sub of subs) {
      try {
        (sub.callback as (value: T[K]) => void)(payload);
      } catch (error) {
        console.warn(`Error in listener for ${String(event)}:`, error);
      }
      if (!sub.once) {
        retained.push(sub);
      }
    }
    this.listeners.set(event, retained);
  }

  clear(): void {
    this.listeners.clear();
  }
}

export type SimpleListener = Listener;

export class SimpleEmitter {
  private callbacks = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.callbacks.add(listener);
    return () => this.callbacks.delete(listener);
  }

  emit(): void {
    for (const callback of Array.from(this.callbacks)) {
      try {
        callback();
      } catch (error) {
        console.warn('Listener error', error);
      }
    }
  }

  clear(): void {
    this.callbacks.clear();
  }
}
