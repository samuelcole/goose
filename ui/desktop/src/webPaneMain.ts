import path from 'node:path';
import {
  BrowserWindow,
  ipcMain,
  session,
  WebContentsView,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Rectangle,
  type WebContents,
} from 'electron';

// A web pane is a real top-level page shown beside a chat: one per chat, per
// window. Pages get their own persistent profile, so a site keeps its storage,
// and nothing granted to goose's own UI applies to them.
const PARTITION = 'persist:goose-web';
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

export interface WebPaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WebPaneEvent =
  | { type: 'navigated'; sessionId: string; url: string; title: string; canGoBack: boolean }
  | { type: 'document'; sessionId: string; documentId: string; host: string }
  | { type: 'tools'; sessionId: string; documentId: string; tools: unknown }
  | { type: 'closed'; sessionId: string };

export interface WebPaneToolResult {
  text: string;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

interface Pane {
  view: WebContentsView;
  owner: WebContents;
  sessionId: string;
  documentId: string | null;
  pendingCalls: Map<string, (result: WebPaneToolResult) => void>;
}

const panes = new Map<string, Pane>();
const panesByPageId = new Map<number, Pane>();
let sessionConfigured = false;

const paneKey = (owner: WebContents, sessionId: string) => `${owner.id}:${sessionId}`;

export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function configureSession(): void {
  if (sessionConfigured) return;
  sessionConfigured = true;
  const webSession = session.fromPartition(PARTITION);
  webSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  webSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  );
}

function emit(pane: Pane, event: WebPaneEvent): void {
  if (!pane.owner.isDestroyed()) {
    pane.owner.send('web-pane:event', event);
  }
}

function emitNavigated(pane: Pane): void {
  const page = pane.view.webContents;
  emit(pane, {
    type: 'navigated',
    sessionId: pane.sessionId,
    url: page.getURL(),
    title: page.getTitle(),
    canGoBack: page.navigationHistory.canGoBack(),
  });
}

function failPendingCalls(pane: Pane, text: string): void {
  for (const resolve of pane.pendingCalls.values()) {
    resolve({ text, isError: true });
  }
  pane.pendingCalls.clear();
}

function destroyPane(pane: Pane): void {
  const key = paneKey(pane.owner, pane.sessionId);
  if (panes.get(key) !== pane) return;
  panes.delete(key);
  panesByPageId.delete(pane.view.webContents.id);
  failPendingCalls(pane, 'The web pane was closed.');
  if (!pane.owner.isDestroyed()) {
    BrowserWindow.fromWebContents(pane.owner)?.contentView.removeChildView(pane.view);
  }
  pane.view.webContents.close();
  emit(pane, { type: 'closed', sessionId: pane.sessionId });
}

function createPane(owner: WebContents, sessionId: string): Pane {
  configureSession();
  const window = BrowserWindow.fromWebContents(owner);
  if (!window) {
    throw new Error('No window for this chat');
  }
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'webPanePreload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  view.setVisible(false);
  window.contentView.addChildView(view);

  const pane: Pane = { view, owner, sessionId, documentId: null, pendingCalls: new Map() };
  const page = view.webContents;
  panes.set(paneKey(owner, sessionId), pane);
  panesByPageId.set(page.id, pane);

  // Popups and target=_blank links load in the pane itself.
  page.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) {
      void page.loadURL(url);
    }
    return { action: 'deny' };
  });
  page.on('will-navigate', (event, url) => {
    if (!isWebUrl(url)) event.preventDefault();
  });
  page.on('did-navigate', () => emitNavigated(pane));
  page.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) emitNavigated(pane);
  });
  page.on('page-title-updated', () => emitNavigated(pane));
  page.on('render-process-gone', () => failPendingCalls(pane, 'The page crashed.'));
  owner.once('destroyed', () => destroyPane(pane));
  return pane;
}

function paneFor(event: IpcMainEvent | IpcMainInvokeEvent, sessionId: string) {
  return panes.get(paneKey(event.sender, sessionId));
}

// Renderer bounds are CSS pixels; the view is positioned in window coordinates,
// which differ when goose's UI is zoomed.
function toWindowBounds(owner: WebContents, bounds: WebPaneBounds): Rectangle {
  const zoom = owner.getZoomFactor();
  return {
    x: Math.round(bounds.x * zoom),
    y: Math.round(bounds.y * zoom),
    width: Math.round(bounds.width * zoom),
    height: Math.round(bounds.height * zoom),
  };
}

export function registerWebPaneIpc(): void {
  ipcMain.handle('web-pane:open', async (event, sessionId: string, url: string) => {
    if (!isWebUrl(url)) {
      throw new Error('Only http and https URLs can be opened in the web pane');
    }
    const pane = paneFor(event, sessionId) ?? createPane(event.sender, sessionId);
    await pane.view.webContents.loadURL(url);
    return { url: pane.view.webContents.getURL(), title: pane.view.webContents.getTitle() };
  });

  ipcMain.handle('web-pane:close', (event, sessionId: string) => {
    const pane = paneFor(event, sessionId);
    if (pane) destroyPane(pane);
  });

  ipcMain.handle(
    'web-pane:set-bounds',
    (event, sessionId: string, bounds: WebPaneBounds | null) => {
      const pane = paneFor(event, sessionId);
      if (!pane) return;
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        pane.view.setVisible(false);
        return;
      }
      pane.view.setBounds(toWindowBounds(pane.owner, bounds));
      pane.view.setVisible(true);
    }
  );

  ipcMain.handle(
    'web-pane:navigate',
    (event, sessionId: string, action: 'back' | 'forward' | 'reload') => {
      const page = paneFor(event, sessionId)?.view.webContents;
      if (!page) return;
      if (action === 'back') page.navigationHistory.goBack();
      else if (action === 'forward') page.navigationHistory.goForward();
      else page.reload();
    }
  );

  ipcMain.handle(
    'web-pane:call-tool',
    (
      event,
      sessionId: string,
      documentId: string,
      callId: string,
      name: string,
      args: Record<string, unknown>
    ): Promise<WebPaneToolResult> => {
      const pane = paneFor(event, sessionId);
      if (!pane || pane.documentId !== documentId) {
        return Promise.resolve({
          text: 'The page that registered this tool is no longer open.',
          isError: true,
        });
      }
      return new Promise((resolve) => {
        pane.pendingCalls.set(callId, resolve);
        pane.view.webContents.send('web-pane-page:call', { callId, name, args });
      });
    }
  );

  ipcMain.handle('web-pane:cancel-tool', (event, sessionId: string, callId: string) => {
    paneFor(event, sessionId)?.view.webContents.send('web-pane-page:cancel', { callId });
  });

  // From the page's preload. A new document id means the previous document and
  // its tools are gone, so calls still waiting on it fail.
  ipcMain.on('web-pane-page:document', (event, documentId: string, host: string) => {
    const pane = panesByPageId.get(event.sender.id);
    if (!pane) return;
    failPendingCalls(pane, 'The page navigated away before answering.');
    pane.documentId = documentId;
    emit(pane, { type: 'document', sessionId: pane.sessionId, documentId, host });
  });

  ipcMain.on('web-pane-page:sync', (event, documentId: string, tools: unknown) => {
    const pane = panesByPageId.get(event.sender.id);
    if (!pane || pane.documentId !== documentId) return;
    emit(pane, { type: 'tools', sessionId: pane.sessionId, documentId, tools });
  });

  ipcMain.on('web-pane-page:call-result', (event, callId: string, result: WebPaneToolResult) => {
    const pane = panesByPageId.get(event.sender.id);
    const resolve = pane?.pendingCalls.get(callId);
    if (!pane || !resolve) return;
    pane.pendingCalls.delete(callId);
    resolve(result);
  });
}
