/**
 * Chrome permission management. Request functions must be called directly from a
 * user gesture (click handler) – they deliberately perform no awaits before
 * chrome.permissions.request().
 */

export type PermissionName = 'storage' | 'activeTab' | 'sidePanel' | 'scripting' | 'contextMenus' | 'tabs';

export interface PermissionInfo {
  name: PermissionName | 'host';
  label: string;
  required: boolean;
  why: string;
  features: string;
  troubleshooting: string;
}

export const PERMISSION_INFO: PermissionInfo[] = [
  { name: 'storage', label: 'Storage', required: true, why: 'Saves extension settings and the pairing token on this device.', features: 'Settings, connection', troubleshooting: 'Granted at install. If missing, reload the extension from chrome://extensions.' },
  { name: 'activeTab', label: 'Active tab', required: true, why: 'Temporary access to the current tab after you click the toolbar icon, use a shortcut or the context menu.', features: 'Reading the current page without permanent site access', troubleshooting: 'Granted at install. Access is per-tab and ends when you navigate; use "Grant website access" for permanent per-site access.' },
  { name: 'sidePanel', label: 'Side panel', required: true, why: 'Shows the assistant in Chrome\'s side panel.', features: 'Main interface', troubleshooting: 'Requires Chrome 116+. Reload the extension if the panel does not open.' },
  { name: 'scripting', label: 'Scripting', required: true, why: 'Injects the page reader and the floating assistant into pages you allowed.', features: 'Page reading, form filling, browser actions, floating assistant', troubleshooting: 'Granted at install. Pages like chrome:// and the Web Store can never be scripted.' },
  { name: 'contextMenus', label: 'Context menu', required: true, why: 'Adds "Ask Local AI" to the right-click menu (also grants temporary page access).', features: 'Right-click actions', troubleshooting: 'Granted at install.' },
  { name: 'tabs', label: 'Tabs (optional)', required: false, why: 'Reads titles and URLs of other open tabs so you can choose which ones to include.', features: 'Multi-tab context', troubleshooting: 'Requested the first time you open the tab picker. You can revoke it here.' },
  { name: 'host', label: 'Website access (optional, per site)', required: false, why: 'Lets the assistant read pages and show the floating assistant on sites you choose.', features: 'Page reading, floating assistant, forms, browser actions', troubleshooting: 'Grant per site from the chat header or here. Revoke any site at any time.' },
];

const LOCAL_ORIGINS = ['http://127.0.0.1/*', 'http://localhost/*'];

export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export async function hasPermission(name: PermissionName): Promise<boolean> {
  return chrome.permissions.contains({ permissions: [name] });
}

export function requestPermission(name: PermissionName): Promise<boolean> {
  return chrome.permissions.request({ permissions: [name] });
}

export function removePermission(name: PermissionName): Promise<boolean> {
  return chrome.permissions.remove({ permissions: [name] });
}

export async function hasHostAccess(url: string): Promise<boolean> {
  const pattern = originPattern(url);
  if (!pattern) return false;
  return chrome.permissions.contains({ origins: [pattern] });
}

/** Must be invoked synchronously from a click handler. */
export function requestHostAccess(url: string): Promise<boolean> {
  const pattern = originPattern(url);
  if (!pattern) return Promise.resolve(false);
  return chrome.permissions.request({ origins: [pattern] });
}

export function removeHostAccess(pattern: string): Promise<boolean> {
  if (LOCAL_ORIGINS.includes(pattern)) return Promise.resolve(false);
  return chrome.permissions.remove({ origins: [pattern] });
}

export async function grantedSiteOrigins(): Promise<string[]> {
  const all = await chrome.permissions.getAll();
  return (all.origins ?? []).filter((o) => !LOCAL_ORIGINS.includes(o));
}

export async function permissionSnapshot(): Promise<Record<string, boolean>> {
  const all = await chrome.permissions.getAll();
  const perms = new Set(all.permissions ?? []);
  return {
    storage: perms.has('storage'),
    activeTab: perms.has('activeTab'),
    sidePanel: perms.has('sidePanel'),
    scripting: perms.has('scripting'),
    contextMenus: perms.has('contextMenus'),
    tabs: perms.has('tabs'),
  };
}
