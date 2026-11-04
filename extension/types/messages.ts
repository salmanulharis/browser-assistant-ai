import { z } from 'zod';

const Offset = z.object({ x: z.number().finite(), y: z.number().finite() });
const PageMeta = z.object({ url: z.string().max(2048), title: z.string().max(500) });

const FieldSchema = z.object({
  ref: z.string().max(40),
  tag: z.enum(['input', 'textarea', 'select', 'contenteditable']),
  type: z.string().max(40),
  name: z.string().max(200),
  label: z.string().max(500),
  placeholder: z.string().max(300),
  autocomplete: z.string().max(100),
  required: z.boolean(),
  max_length: z.number().nullable(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).max(1000),
  nearby_text: z.string().max(1000),
  has_value: z.boolean(),
  sensitive: z.string().nullable(),
});

/** Messages a content script may send to the background worker. Anything else is rejected. */
export const ContentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('floating:config') }),
  z.object({ type: z.literal('floating:savePosition'), offset: Offset }),
  z.object({ type: z.literal('floating:disableSite') }),
  z.object({ type: z.literal('floating:openPanel') }),
  z.object({ type: z.literal('floating:sendToPanel'), page: z.record(z.string(), z.unknown()) }),
  z.object({
    type: z.literal('floating:generateField'),
    field: FieldSchema,
    page: PageMeta,
    instructions: z.string().max(4000).default(''),
  }),
]);
export type ContentMessage = z.infer<typeof ContentMessageSchema>;

export const AssistStartSchema = z.object({
  type: z.literal('start'),
  action: z.enum(['explain', 'summarize', 'rewrite', 'grammar', 'translate', 'generate', 'ask', 'key_points']),
  text: z.string().max(50_000),
  instructions: z.string().max(4000).default(''),
  page: PageMeta.optional(),
});
export type AssistStart = z.infer<typeof AssistStartSchema>;

/** Pending hand-off from background/floating UI to the side panel (chrome.storage.session). */
export const PENDING_KEY = 'lba.pending';
export const PendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), tabId: z.number(), at: z.number() }),
  z.object({ kind: z.literal('selection'), text: z.string(), url: z.string(), title: z.string(), tabId: z.number().optional(), at: z.number() }),
  z.object({ kind: z.literal('page'), page: z.record(z.string(), z.unknown()), tabId: z.number().optional(), at: z.number() }),
]);
export type Pending = z.infer<typeof PendingSchema>;

export interface FloatingPublicConfig {
  enabled: boolean;
  reason?: string;
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  offset: { x: number; y: number } | null;
  connected: boolean;
}
