import { fragmentShimSource } from '../../modelContextShim';

export const APP_TOOLS_SYNC_METHOD = 'goose/app-tools/sync';
export const APP_TOOLS_CALL_METHOD = 'goose/app-tools/call';

const SHIM_SCRIPT = `<script>${fragmentShimSource(APP_TOOLS_SYNC_METHOD, APP_TOOLS_CALL_METHOD)}</script>`;

// The shim must run before the app's scripts, but must not precede the doctype,
// which would put the document in quirks mode.
export function injectAppToolsShim(html: string): string {
  for (const pattern of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(html);
    if (match) {
      const end = match.index + match[0].length;
      return html.slice(0, end) + SHIM_SCRIPT + html.slice(end);
    }
  }
  return SHIM_SCRIPT + html;
}
