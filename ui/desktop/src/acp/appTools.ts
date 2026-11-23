import type {
  AppToolCallResponse_unstable,
  AppToolDescriptor,
  CancelAppToolCallNotification_unstable,
  RequestAppToolCall_unstable,
} from '@aaif/goose-acp-client';
import { getAcpClient, subscribeToAcpRecovery } from './acpConnection';

export interface AppToolHandler {
  call: (
    name: string,
    args: Record<string, unknown>,
    callId: string
  ) => Promise<AppToolCallResponse_unstable>;
  cancel: (callId: string) => void;
}

interface AppToolSync {
  sessionId: string;
  extensionName: string;
  tools: AppToolDescriptor[];
}

const handlersByInstance = new Map<string, AppToolHandler>();
const syncsByInstance = new Map<string, AppToolSync>();
let unsubscribeRecovery: (() => void) | null = null;

export function registerAppToolHandler(appInstanceId: string, handler: AppToolHandler): () => void {
  handlersByInstance.set(appInstanceId, handler);
  return () => {
    if (handlersByInstance.get(appInstanceId) === handler) {
      handlersByInstance.delete(appInstanceId);
    }
  };
}

async function sendSync(appInstanceId: string, sync: AppToolSync): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionAppToolsSync_unstable({ appInstanceId, ...sync });
}

// The backend drops a connection's app tools when it closes, so after the ACP
// connection is re-established every fragment still open re-registers.
function resyncAfterRecovery(recovering: boolean): void {
  if (recovering) return;
  for (const [appInstanceId, sync] of syncsByInstance) {
    sendSync(appInstanceId, sync).catch((error: unknown) => {
      console.error('[appTools] Failed to re-sync app tools after reconnect:', error);
    });
  }
}

export async function syncAppTools(
  sessionId: string,
  appInstanceId: string,
  extensionName: string,
  tools: AppToolDescriptor[]
): Promise<void> {
  const sync = { sessionId, extensionName, tools };
  if (tools.length > 0) {
    syncsByInstance.set(appInstanceId, sync);
    unsubscribeRecovery ??= subscribeToAcpRecovery(resyncAfterRecovery);
  } else {
    syncsByInstance.delete(appInstanceId);
  }
  await sendSync(appInstanceId, sync);
}

export async function callAppTool(
  request: RequestAppToolCall_unstable
): Promise<AppToolCallResponse_unstable> {
  const handler = handlersByInstance.get(request.appInstanceId);
  if (!handler) {
    return { text: 'The app that registered this tool is no longer open.', isError: true };
  }
  return handler.call(request.name, request.arguments ?? {}, request.callId);
}

export async function cancelAppToolCall(
  notification: CancelAppToolCallNotification_unstable
): Promise<void> {
  handlersByInstance.get(notification.appInstanceId)?.cancel(notification.callId);
}

export function resetAppToolHandlersForTests(): void {
  handlersByInstance.clear();
  syncsByInstance.clear();
  unsubscribeRecovery?.();
  unsubscribeRecovery = null;
}
