import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
// @ts-expect-error – plain .mjs helper without type declarations
import { ensureExtensionKey } from './scripts/extension-key.mjs';

const { key } = ensureExtensionKey() as { key: string; id: string };

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  outDir: '.output',
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'Local Browser AI',
    description: 'A private AI browser assistant powered by your local Ollama server.',
    version: '1.0.0',
    key,
    minimum_chrome_version: '116',
    permissions: ['storage', 'activeTab', 'sidePanel', 'scripting', 'contextMenus'],
    // Requested at runtime only when the user opens the tab picker.
    optional_permissions: ['tabs'],
    // Only the local backend is a required host. Websites are optional and per-site.
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_title: 'Open Local Browser AI' },
    side_panel: { default_path: 'sidepanel.html' },
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+Shift+A' }, description: 'Open the side panel' },
      'toggle-floating': { suggested_key: { default: 'Alt+Shift+F' }, description: 'Toggle the floating assistant on this page' },
      'read-page': { suggested_key: { default: 'Alt+Shift+R' }, description: 'Send this page to the side panel' },
    },
    web_accessible_resources: [],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*",
    },
  },
});
