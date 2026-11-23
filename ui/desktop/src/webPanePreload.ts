import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { WEB_PANE_BRIDGE_GLOBAL, webPaneShimSource } from './modelContextShim';

// Runs at the start of every document loaded in a web pane. Only top-level
// documents count: frames inside the page get no bridge.
type CallHandler = (id: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
type CancelHandler = (id: string, reason?: string) => void;

if (process.isMainFrame) {
  const documentId = window.crypto.randomUUID();
  let callHandler: CallHandler | null = null;
  let cancelHandler: CancelHandler | null = null;

  ipcRenderer.send('web-pane-page:document', documentId, window.location.host);

  ipcRenderer.on(
    'web-pane-page:call',
    async (
      _event,
      { callId, name, args }: { callId: string; name: string; args: Record<string, unknown> }
    ) => {
      const result = callHandler
        ? await callHandler(callId, name, args).catch((error: unknown) => ({
            text: String(error),
            isError: true,
          }))
        : { text: 'This page has no tools.', isError: true };
      ipcRenderer.send('web-pane-page:call-result', callId, result);
    }
  );
  ipcRenderer.on('web-pane-page:cancel', (_event, { callId }: { callId: string }) => {
    cancelHandler?.(callId, 'The agent cancelled the call.');
  });

  contextBridge.exposeInMainWorld(WEB_PANE_BRIDGE_GLOBAL, {
    sync: (tools: unknown) => ipcRenderer.send('web-pane-page:sync', documentId, tools),
    onCall: (handler: CallHandler) => {
      callHandler = handler;
    },
    onCancel: (handler: CancelHandler) => {
      cancelHandler = handler;
    },
  });

  // Page scripts haven't run yet, so registerTool exists before they look for it.
  void webFrame.executeJavaScript(webPaneShimSource());
}
