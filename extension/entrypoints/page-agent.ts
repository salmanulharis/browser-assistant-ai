/**
 * Injected on demand (chrome.scripting.executeScript files) into the extension's
 * isolated world. Exposes the page agent for subsequent function calls.
 */
import { pageAgent } from '@/lib/page-agent-core';

export default defineUnlistedScript(() => {
  (globalThis as unknown as { __lbaAgent: typeof pageAgent }).__lbaAgent = pageAgent;
});
