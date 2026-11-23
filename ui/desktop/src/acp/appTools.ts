import type {
  AppToolCallResponse_unstable,
  AppToolDescriptor,
  RequestAppToolCall_unstable,
} from '@aaif/goose-acp-client';
import { getAcpClient } from './acpConnection';

export type AppToolHandler = (
  name: string,
  args: Record<string, unknown>
) => Promise<AppToolCallResponse_unstable>;

const handlersByInstance = new Map<string, AppToolHandler>();

export function registerAppToolHandler(appInstanceId: string, handler: AppToolHandler): () => void {
  handlersByInstance.set(appInstanceId, handler);
  return () => {
    if (handlersByInstance.get(appInstanceId) === handler) {
      handlersByInstance.delete(appInstanceId);
    }
  };
}

export async function syncAppTools(
  sessionId: string,
  appInstanceId: string,
  extensionName: string,
  tools: AppToolDescriptor[]
): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionAppToolsSync_unstable({
    sessionId,
    appInstanceId,
    extensionName,
    tools,
  });
}

export async function callAppTool(
  request: RequestAppToolCall_unstable
): Promise<AppToolCallResponse_unstable> {
  const handler = handlersByInstance.get(request.appInstanceId);
  if (!handler) {
    return { text: 'The app that registered this tool is no longer open.', isError: true };
  }
  return handler(request.name, request.arguments ?? {});
}

export function resetAppToolHandlersForTests(): void {
  handlersByInstance.clear();
}
