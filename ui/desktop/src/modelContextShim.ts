// Gives a page WebMCP's document.modelContext.registerTool (plus the older
// navigator.modelContext addTool/removeTool) and runs the calls a host relays.
// Handlers never leave the page. Shared by MCP App fragments (postMessage to the
// host) and the web pane (an IPC bridge from its preload). Kept as plain
// JavaScript source so no bundler helper can leak into the page.

export const MAX_RESULT_TEXT_CHARS = 1_000_000;

// (sendSync, maxResultChars) -> { call(id, name, args) -> Promise<result>, cancel(id, reason) }
const CORE_SOURCE = `(function (sendSync, maxResultChars) {
  var namePattern = /^[A-Za-z0-9_.-]{1,128}$/;
  var tools = new Map();
  var inFlight = new Map();
  var syncScheduled = false;

  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    queueMicrotask(function () {
      syncScheduled = false;
      sendSync(Array.from(tools.values(), function (t) {
        var d = { name: t.name, description: t.description };
        if (t.inputSchema) d.inputSchema = t.inputSchema;
        return d;
      }));
    });
  }

  function registerTool(tool, options) {
    options = options || {};
    var execute = tool && (tool.execute || tool.handler);
    if (!tool || typeof execute !== 'function') {
      return Promise.reject(new TypeError('registerTool requires { name, description, execute }'));
    }
    if (typeof tool.name !== 'string' || !namePattern.test(tool.name)) {
      return Promise.reject(new DOMException(
        'registerTool: name must be 1-128 ASCII letters, digits, "_", "-" or "."', 'InvalidStateError'));
    }
    if (typeof tool.description !== 'string' || !tool.description.trim()) {
      return Promise.reject(new DOMException('registerTool: description must not be empty', 'InvalidStateError'));
    }
    if (tools.has(tool.name)) {
      return Promise.reject(new DOMException(
        'registerTool: a tool named "' + tool.name + '" is already registered', 'InvalidStateError'));
    }
    if (options.signal && options.signal.aborted) {
      return Promise.reject(options.signal.reason);
    }
    var entry = {
      name: tool.name,
      description: tool.description,
      inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : undefined,
      execute: function (input, callOptions) { return execute.call(tool, input, callOptions); }
    };
    tools.set(entry.name, entry);
    if (options.signal) {
      options.signal.addEventListener('abort', function () {
        if (tools.get(entry.name) === entry) {
          tools.delete(entry.name);
          scheduleSync();
        }
      });
    }
    scheduleSync();
    return Promise.resolve(undefined);
  }
  function unregisterTool(name) {
    if (tools.delete(name)) scheduleSync();
  }

  var modelContext = {
    registerTool: registerTool,
    unregisterTool: unregisterTool,
    addTool: function (descriptor) { registerTool(descriptor).catch(function (e) { console.error(e); }); },
    removeTool: unregisterTool
  };
  Object.defineProperty(document, 'modelContext', { value: modelContext, configurable: true });
  Object.defineProperty(navigator, 'modelContext', { value: modelContext, configurable: true });

  function toResult(value) {
    var text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
    if (text.length > maxResultChars) {
      return { text: 'Tool result exceeded the size limit.', isError: true };
    }
    return isPlainObject(value) ? { text: text, structuredContent: value } : { text: text };
  }

  function call(id, name, args) {
    var entry = tools.get(name);
    if (!entry) {
      return Promise.resolve({ text: 'Unknown app tool: ' + String(name), isError: true });
    }
    var controller = new AbortController();
    inFlight.set(id, controller);
    return Promise.resolve()
      .then(function () { return entry.execute(args || {}, { signal: controller.signal }); })
      .then(toResult, function (error) {
        return { text: String(error && error.message ? error.message : error).slice(0, 1024), isError: true };
      })
      .finally(function () { inFlight.delete(id); });
  }
  function cancel(id, reason) {
    var pending = inFlight.get(id);
    if (pending) pending.abort(reason);
  }
  return { call: call, cancel: cancel };
})`;

// The fragment talks JSON-RPC to the host frame. The listener runs in the capture
// phase, registered before the app's own MCP Apps client, so calls meant for the
// shim never reach the app as unknown requests.
export function fragmentShimSource(syncMethod: string, callMethod: string): string {
  return `(function (syncMethod, callMethod) {
  function post(message) {
    window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, message), '*');
  }
  var core = ${CORE_SOURCE}(function (tools) {
    post({ method: syncMethod, params: { tools: tools } });
  }, ${MAX_RESULT_TEXT_CHARS});
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (event.source !== window.parent || !message) return;
    if (message.method === 'notifications/cancelled') {
      if (message.params) core.cancel(message.params.requestId, message.params.reason);
      return;
    }
    if (message.method !== callMethod) return;
    event.stopImmediatePropagation();
    var params = message.params || {};
    core.call(message.id, params.name, params.arguments).then(function (result) {
      post({ id: message.id, result: result });
    });
  }, true);
})(${JSON.stringify(syncMethod)}, ${JSON.stringify(callMethod)});`;
}

export const WEB_PANE_BRIDGE_GLOBAL = '__gooseWebPane';

// The web pane's preload exposes a bridge on the page's window; this source runs
// in the page's main world and connects the core to it.
export function webPaneShimSource(): string {
  return `(function (bridge) {
  if (!bridge || document.modelContext) return;
  var core = ${CORE_SOURCE}(function (tools) { bridge.sync(tools); }, ${MAX_RESULT_TEXT_CHARS});
  bridge.onCall(function (id, name, args) { return core.call(id, name, args); });
  bridge.onCancel(function (id, reason) { core.cancel(id, reason); });
})(window.${WEB_PANE_BRIDGE_GLOBAL});`;
}
