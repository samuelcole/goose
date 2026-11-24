import type {
  RequestWebPaneClose_unstable,
  RequestWebPaneOpen_unstable,
  WebPaneOpenResponse_unstable,
} from '@aaif/goose-acp-client';
import { z } from 'zod';
import type { WebPaneEvent } from '../webPaneMain';
import { getAcpClient, subscribeToAcpRecovery } from './acpConnection';
import { registerAppToolHandler, syncAppTools } from './appTools';

export interface WebPaneState {
  url: string;
  title: string;
  canGoBack: boolean;
}

export interface WebPaneOriginPrompt {
  sessionId: string;
  origin: string;
  answer: (allowed: boolean) => void;
}

const ALLOWED_ORIGINS_KEY = 'goose.webPane.allowedOrigins';

const panes = new Map<string, WebPaneState>();
const documents = new Map<
  string,
  { documentId: string; host: string; unregister?: () => void; toolsSynced?: Promise<void> }
>();
const registeredSessions = new Set<string>();
const siteServers = new Map<string, { origin: string; url: string; ready: Promise<void> }>();
const listeners = new Set<() => void>();
let originPrompt: WebPaneOriginPrompt | null = null;
let wired = false;

const pageToolsSchema = z
  .array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
    })
  )
  .catch([]);

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeToWebPanes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWebPane(sessionId: string): WebPaneState | undefined {
  return panes.get(sessionId);
}

export function getWebPaneOriginPrompt(): WebPaneOriginPrompt | null {
  return originPrompt;
}

function allowedOrigins(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(ALLOWED_ORIGINS_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((o) => typeof o === 'string') : []);
  } catch {
    return new Set();
  }
}

function rememberOrigin(origin: string): void {
  const origins = allowedOrigins();
  origins.add(origin);
  localStorage.setItem(ALLOWED_ORIGINS_KEY, JSON.stringify([...origins]));
}

// The first time the agent opens a site, the person decides; the answer is
// remembered for that origin.
function askToOpen(sessionId: string, origin: string): Promise<boolean> {
  if (allowedOrigins().has(origin)) return Promise.resolve(true);
  return new Promise((resolve) => {
    originPrompt?.answer(false);
    originPrompt = {
      sessionId,
      origin,
      answer: (allowed) => {
        if (originPrompt?.origin === origin) originPrompt = null;
        if (allowed) rememberOrigin(origin);
        notify();
        resolve(allowed);
      },
    };
    notify();
  });
}

function withdrawDocumentTools(sessionId: string): void {
  const current = documents.get(sessionId);
  if (!current) return;
  documents.delete(sessionId);
  current.unregister?.();
  syncAppTools(sessionId, current.documentId, `${current.host} page`, []).catch(
    (error: unknown) => {
      console.error('[webPane] Failed to withdraw page tools:', error);
    }
  );
}

function setSiteServer(sessionId: string, url?: string, title = ''): Promise<void> {
  return getAcpClient()
    .then((client) => client.goose.sessionWebPaneSiteServer_unstable({ sessionId, url, title }))
    .catch((error: unknown) => {
      console.error('[webPane] Failed to update the site MCP server:', error);
    });
}

function attachSiteServer(sessionId: string, url: string, title: string): void {
  if (siteServers.get(sessionId)?.url === url) return;
  const ready = setSiteServer(sessionId, url, title);
  siteServers.set(sessionId, { origin: new URL(url).origin, url, ready });
}

// The site's server goes once the pane leaves the site, so it can't outlive the
// person's view of that site.
function detachSiteServer(sessionId: string): void {
  if (!siteServers.delete(sessionId)) return;
  void setSiteServer(sessionId);
}

function handleEvent(event: WebPaneEvent): void {
  const { sessionId } = event;
  switch (event.type) {
    case 'navigated':
      if (panes.has(sessionId)) {
        panes.set(sessionId, { url: event.url, title: event.title, canGoBack: event.canGoBack });
        notify();
      }
      if (siteServers.get(sessionId)?.origin !== new URL(event.url).origin) {
        detachSiteServer(sessionId);
      }
      break;
    case 'document':
      withdrawDocumentTools(sessionId);
      documents.set(sessionId, { documentId: event.documentId, host: event.host });
      break;
    case 'tools': {
      const current = documents.get(sessionId);
      if (!current || current.documentId !== event.documentId) return;
      const tools = pageToolsSchema.parse(event.tools);
      current.unregister?.();
      current.unregister =
        tools.length > 0
          ? registerAppToolHandler(event.documentId, {
              call: (name, args, callId) =>
                window.electron.webPane.callTool(sessionId, event.documentId, callId, name, args),
              cancel: (callId) => {
                void window.electron.webPane.cancelTool(sessionId, callId);
              },
            })
          : undefined;
      current.toolsSynced = syncAppTools(
        sessionId,
        event.documentId,
        `${current.host} page`,
        tools
      ).catch((error: unknown) => {
        console.error('[webPane] Failed to sync page tools:', error);
      });
      break;
    }
    case 'mcpServer':
      if (documents.get(sessionId)?.documentId !== event.documentId) return;
      attachSiteServer(sessionId, event.url, event.title);
      break;
    case 'closed':
      withdrawDocumentTools(sessionId);
      detachSiteServer(sessionId);
      panes.delete(sessionId);
      notify();
      break;
  }
}

async function sendRegistration(sessionId: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionWebPaneRegister_unstable({ sessionId });
}

function wire(): void {
  if (wired) return;
  wired = true;
  window.electron.webPane.onEvent(handleEvent);
  subscribeToAcpRecovery((recovering) => {
    if (recovering) return;
    for (const sessionId of registeredSessions) {
      sendRegistration(sessionId).catch((error: unknown) => {
        console.error('[webPane] Failed to re-register web pane:', error);
      });
    }
  });
}

// Tells the agent this chat can show a web pane, which offers it the pane tools.
export async function registerWebPaneSession(sessionId: string): Promise<void> {
  wire();
  registeredSessions.add(sessionId);
  await sendRegistration(sessionId);
}

export async function openWebPane(
  request: RequestWebPaneOpen_unstable
): Promise<WebPaneOpenResponse_unstable> {
  wire();
  const { origin } = new URL(request.url);
  if (!(await askToOpen(request.sessionId, origin))) {
    throw new Error(`The user declined to open ${origin} in the web pane.`);
  }
  if (!panes.has(request.sessionId)) {
    panes.set(request.sessionId, { url: request.url, title: '', canGoBack: false });
    notify();
  }
  const page = await window.electron.webPane.open(request.sessionId, request.url);
  await pageSettled(request.sessionId);
  return page;
}

const PAGE_TOOLS_GRACE_MS = 1500;
const PAGE_SETTLE_LIMIT_MS = 5000;

// A loaded page registers its tools and names its site's server a moment later.
// Waiting for them lets the agent's next step see them.
async function pageSettled(sessionId: string): Promise<void> {
  const deadline = Date.now() + PAGE_SETTLE_LIMIT_MS;
  const graceEnd = Date.now() + PAGE_TOOLS_GRACE_MS;
  while (!documents.get(sessionId)?.toolsSynced && Date.now() < graceEnd) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const waits = [documents.get(sessionId)?.toolsSynced, siteServers.get(sessionId)?.ready];
  await Promise.race([
    Promise.all(waits),
    new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
  ]);
}

export async function closeWebPane(
  request: RequestWebPaneClose_unstable
): Promise<Record<string, never>> {
  await window.electron.webPane.close(request.sessionId);
  return {};
}
