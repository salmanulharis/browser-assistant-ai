/**
 * Detects chat messages that ask the assistant to CHANGE the current page (fill, type,
 * select, click, edit) rather than to answer a question. Such messages are routed to the
 * approval-based action planner instead of plain chat.
 */

const ACTION_VERB =
  '(?:fill(?:\\s+(?:in|out|up))?|complete|enter|type|put|insert|write|paste|add|set|change|update|edit|modify|replace|correct|fix|rename|select|choose|pick|tick|untick|check|uncheck|click|press|clear|empty)';

// Verbs that also mean "compose text" (write, add) only count when aimed at a field (TARGETED).
const LEAD_VERB = ACTION_VERB.replace('write|', '').replace('add|', '');

// "fill this form…", "please change the title to…", "can you put my email in…"
const LEADING = new RegExp(`^\\s*(?:(?:please|pls|kindly|now|ok(?:ay)?|then|and|go ahead and)[\\s,]+)*(?:(?:can|could|would|will) you\\s+(?:please\\s+)?)?${LEAD_VERB}\\b`, 'i');

// "…in/into/on the <field|form|box…>" anywhere in the sentence
const TARGETED = new RegExp(`\\b${ACTION_VERB}\\b[^.?!\\n]{0,80}\\b(?:in|into|on|to)\\b[^.?!\\n]{0,40}\\b(?:field|fields|form|box|input|textbox|text area|textarea|dropdown|select|page|editor|title|description|section)\\b`, 'i');

// Short follow-ups after an answer: "fill them", "do it", "apply that", "use these"
const FOLLOW_UP = /^\s*(?:(?:please|now|ok(?:ay)?|yes)[\s,]+)*(?:fill|apply|use|insert|put|enter|do)\s+(?:it|them|this|that|these|those)(?:\s+(?:in|on|into)(?:\s+the\s+(?:page|form|fields?))?)?(?:\s+(?:for me|please))?[\s.!]*$/i;

// Questions about forms ("what does this field mean?", "how do I fill this?") are answered, not executed.
const QUESTION = /^\s*(?:what|why|how|which|who|when|where|is|are|does|do|should|explain|tell me)\b/i;

export function isPageActionRequest(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 2000) return false;
  if (FOLLOW_UP.test(t)) return true;
  if (QUESTION.test(t) && !LEADING.test(t)) return false;
  return LEADING.test(t) || TARGETED.test(t);
}

/** Builds the planner task: the user's request plus the previous answer as reference data. */
export function buildActionTask(request: string, previousAnswer?: string, max = 3900): string {
  const req = request.trim();
  if (!previousAnswer?.trim()) return req.slice(0, max);
  const head = `${req}\n\nReference details from the assistant's previous reply (use them for the field values where they match):\n`;
  return head + previousAnswer.trim().slice(0, Math.max(0, max - head.length));
}
