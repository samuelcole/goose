import { AppBridge } from '@mcp-ui/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  callAppTool,
  cancelAppToolCall,
  registerAppToolHandler,
  resetAppToolHandlersForTests,
} from '../../../acp/appTools';
import { APP_TOOLS_CALL_METHOD, APP_TOOLS_SYNC_METHOD, injectAppToolsShim } from '../appToolsShim';

describe('injectAppToolsShim', () => {
  it('puts the shim at the start of <head>, after the doctype', () => {
    const html = injectAppToolsShim('<!doctype html><html><head><title>x</title></head></html>');
    expect(html.startsWith('<!doctype html><html><head><script>')).toBe(true);
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<title>'));
  });

  it('falls back to <html>, then the doctype, then the start', () => {
    expect(injectAppToolsShim('<html><body></body></html>')).toMatch(/^<html><script>/);
    expect(injectAppToolsShim('<!DOCTYPE html><p>hi</p>')).toMatch(/^<!DOCTYPE html><script>/);
    expect(injectAppToolsShim('<p>hi</p>')).toMatch(/^<script>/);
  });
});

describe('callAppTool', () => {
  beforeEach(() => resetAppToolHandlersForTests());

  it('routes to the fragment document that registered the tool', async () => {
    const cancelled: string[] = [];
    const unregister = registerAppToolHandler('doc-1', {
      call: async (name, args, callId) => ({
        text: `${name}:${JSON.stringify(args)}:${callId}`,
        isError: false,
      }),
      cancel: (callId) => cancelled.push(callId),
    });

    await expect(
      callAppTool({
        sessionId: 's',
        appInstanceId: 'doc-1',
        callId: 'c1',
        name: 'pos',
        arguments: { a: 1 },
      })
    ).resolves.toEqual({ text: 'pos:{"a":1}:c1', isError: false });

    await cancelAppToolCall({ sessionId: 's', appInstanceId: 'doc-1', callId: 'c2' });
    expect(cancelled).toEqual(['c2']);

    unregister();
    await expect(
      callAppTool({ sessionId: 's', appInstanceId: 'doc-1', callId: 'c3', name: 'pos' })
    ).resolves.toMatchObject({ isError: true });
  });
});

// Guards the bundled AppBridge: goose relies on it passing through a custom
// host-to-app request and an unknown app-to-host notification.
describe('AppBridge app tools round trip', () => {
  it('delivers sync notifications and resolves custom call requests', async () => {
    const bridge = new AppBridge(null, { name: 'h', version: '1' }, {}, { hostContext: {} });
    const synced: unknown[] = [];
    (
      bridge as unknown as {
        fallbackNotificationHandler: (n: { method: string; params?: unknown }) => Promise<void>;
      }
    ).fallbackNotificationHandler = async (notification) => {
      synced.push(notification);
    };
    const [hostSide, appSide] = InMemoryTransport.createLinkedPair();
    await bridge.connect(hostSide as never);
    appSide.onmessage = (message: JSONRPCMessage) => {
      if ('id' in message && 'method' in message && message.method === APP_TOOLS_CALL_METHOD) {
        void appSide.send({ jsonrpc: '2.0', id: message.id, result: { text: 'chapter 7' } });
      }
    };
    await appSide.start();

    await appSide.send({
      jsonrpc: '2.0',
      method: APP_TOOLS_SYNC_METHOD,
      params: { tools: [{ name: 'pos', description: 'd' }] },
    });
    const result = await (
      bridge as unknown as {
        request: (r: object, s: z.ZodType) => Promise<unknown>;
      }
    ).request(
      { method: APP_TOOLS_CALL_METHOD, params: { name: 'pos', arguments: {} } },
      z.object({ text: z.string(), isError: z.boolean().default(false) })
    );

    expect(synced).toEqual([
      expect.objectContaining({
        method: APP_TOOLS_SYNC_METHOD,
        params: { tools: [{ name: 'pos', description: 'd' }] },
      }),
    ]);
    expect(result).toEqual({ text: 'chapter 7', isError: false });
  });

  it('sends notifications/cancelled to the app when a call is aborted', async () => {
    const bridge = new AppBridge(null, { name: 'h', version: '1' }, {}, { hostContext: {} });
    const [hostSide, appSide] = InMemoryTransport.createLinkedPair();
    await bridge.connect(hostSide as never);
    const received: JSONRPCMessage[] = [];
    appSide.onmessage = (message: JSONRPCMessage) => received.push(message);
    await appSide.start();

    const controller = new AbortController();
    const pending = (
      bridge as unknown as {
        request: (r: object, s: z.ZodType, o: { signal: AbortSignal }) => Promise<unknown>;
      }
    ).request(
      { method: APP_TOOLS_CALL_METHOD, params: { name: 'slow', arguments: {} } },
      z.object({}),
      { signal: controller.signal }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort('agent cancelled');

    await expect(pending).rejects.toBeDefined();
    const call = received.find((m) => 'method' in m && m.method === APP_TOOLS_CALL_METHOD);
    expect(call && 'id' in call).toBe(true);
    expect(received).toContainEqual(
      expect.objectContaining({
        method: 'notifications/cancelled',
        params: expect.objectContaining({ requestId: (call as { id: number }).id }),
      })
    );
  });
});
