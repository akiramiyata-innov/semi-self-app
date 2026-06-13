const cache = new Map<string, string>();

export function getCached(text: string, from: string, to: string): string | undefined {
  return cache.get(`${from}|${to}|${text}`);
}

export function setCache(text: string, from: string, to: string, result: string): void {
  cache.set(`${from}|${to}|${text}`, result);
  if (cache.size > 500) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}
