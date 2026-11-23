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
const documents = new Map<string, { documentId: string; host: string; unregister?: () => void }>();
const registeredSessions = new Set<string>();
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
  syncAppTools(sessionId, current.documentId, current.host, []).catch((error: unknown) => {
    console.error('[webPane] Failed to withdraw page tools:', error);
  });
}

function handleEvent(event: WebPaneEvent): void {
  const { sessionId } = event;
  switch (event.type) {
    case 'navigated':
      if (panes.has(sessionId)) {
        panes.set(sessionId, { url: event.url, title: event.title, canGoBack: event.canGoBack });
        notify();
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
      syncAppTools(sessionId, event.documentId, current.host, tools).catch((error: unknown) => {
        console.error('[webPane] Failed to sync page tools:', error);
      });
      break;
    }
    case 'closed':
      withdrawDocumentTools(sessionId);
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
  return window.electron.webPane.open(request.sessionId, request.url);
}

export async function closeWebPane(
  request: RequestWebPaneClose_unstable
): Promise<Record<string, never>> {
  await window.electron.webPane.close(request.sessionId);
  return {};
}
