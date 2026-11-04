import type { SseEvent } from '@/types/api';

/** Incremental Server-Sent-Events parser (handles events split across chunks). */
export class SseParser {
  private buffer = '';

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const events: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      const text = data.join('\n');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw string */
      }
      events.push({ event, data: parsed });
    }
    return events;
  }
}

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) yield ev;
    }
    for (const ev of parser.feed(decoder.decode() + '\n\n')) yield ev;
  } finally {
    reader.releaseLock();
  }
}
