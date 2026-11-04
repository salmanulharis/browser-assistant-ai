import { z } from 'zod';

export interface Heading { level: number; text: string }
export interface LinkInfo { text: string; href: string }
export interface TableInfo { caption: string; rows: string[][] }
export interface CodeBlock { language: string; code: string }
export interface FieldOption { value: string; label: string }

export interface FormField {
  ref: string;
  tag: 'input' | 'textarea' | 'select' | 'contenteditable';
  type: string;
  name: string;
  label: string;
  placeholder: string;
  autocomplete: string;
  required: boolean;
  max_length: number | null;
  options: FieldOption[];
  nearby_text: string;
  has_value: boolean;
  sensitive: string | null;
}

export interface FormInfo {
  ref: string;
  name: string;
  heading: string;
  instructions: string;
  fields: FormField[];
}

export interface PageContext {
  url: string;
  title: string;
  description: string;
  lang: string;
  site_name: string;
  headings: Heading[];
  main_text: string;
  paragraphs: string[];
  lists: string[][];
  tables: TableInfo[];
  code_blocks: CodeBlock[];
  links: LinkInfo[];
  selected_text: string;
  forms: FormInfo[];
  content_hash: string;
  truncated: boolean;
}

export interface ElementInfo {
  ref: string;
  tag: string;
  type: string;
  role: string;
  label: string;
  text: string;
  name: string;
  placeholder: string;
  autocomplete: string;
  href: string;
  options: FieldOption[];
  disabled: boolean;
  /** Current state for checkboxes/radios/switches; null for other elements. */
  checked?: boolean | null;
  sensitive: string | null;
  form_ref: string | null;
}

export interface Fingerprint { tag: string; type: string; name: string; label: string }

// ---------------------------------------------------------------- actions
export const ACTION_TYPES = ['click', 'type', 'fill', 'select', 'scroll', 'find', 'read', 'highlight', 'navigate'] as const;

export const ActionTargetSchema = z
  .object({ ref: z.string().max(40).optional(), label: z.string().max(500).optional() })
  .strict();

/** Strict schema every planned action must satisfy before it can be shown or executed. */
export const PlannedActionSchema = z
  .object({
    type: z.enum(ACTION_TYPES),
    target: ActionTargetSchema.optional().nullable(),
    value: z.string().max(10_000).optional().nullable(),
    url: z.string().max(2048).optional().nullable(),
    direction: z.enum(['up', 'down', 'top', 'bottom']).optional().nullable(),
    reason: z.string().max(500).default(''),
    requires_confirmation: z.boolean().default(false),
    warning: z.string().optional().nullable(),
  })
  .strict();

export type PlannedAction = z.infer<typeof PlannedActionSchema>;

export const ActionPlanSchema = z.object({ task: z.string().max(2000), actions: z.array(PlannedActionSchema).max(50) }).strict();
export type ActionPlan = z.infer<typeof ActionPlanSchema>;

export interface ExecutionResult {
  status: 'success' | 'failed' | 'skipped' | 'blocked' | 'cancelled' | 'target_changed';
  message: string;
  data?: string;
}
