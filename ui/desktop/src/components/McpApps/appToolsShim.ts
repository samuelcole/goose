export const APP_TOOLS_SYNC_METHOD = 'goose/app-tools/sync';
export const APP_TOOLS_CALL_METHOD = 'goose/app-tools/call';

const MAX_RESULT_TEXT_CHARS = 1_000_000;

// Runs inside the fragment before its own scripts. It gives the page WebMCP's
// document.modelContext.registerTool (plus the older navigator.modelContext
// addTool/removeTool), syncs the descriptors to the host and runs calls the host
// relays. Handlers never leave the page. Kept as plain JavaScript source so no
// bundler helper can leak into the fragment.
const SHIM_SOURCE = `(function (syncMethod, callMethod, maxResultChars) {
  var namePattern = /^[A-Za-z0-9_.-]{1,128}$/;
  var tools = new Map();
  var inFlight = new Map();
  var syncScheduled = false;

  function post(message) {
    window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, message), '*');
  }
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    queueMicrotask(function () {
      syncScheduled = false;
      post({
        method: syncMethod,
        params: {
          tools: Array.from(tools.values(), function (t) {
            var d = { name: t.name, description: t.description };
            if (t.inputSchema) d.inputSchema = t.inputSchema;
            return d;
          })
        }
      });
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

  // Capture phase, registered before the app's own MCP Apps client, so calls meant
  // for this shim never reach the app as unknown requests.
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (event.source !== window.parent || !message) return;
    if (message.method === 'notifications/cancelled') {
      var pending = message.params && inFlight.get(message.params.requestId);
      if (pending) pending.abort(message.params.reason);
      return;
    }
    if (message.method !== callMethod) return;
    event.stopImmediatePropagation();
    var params = message.params || {};
    function reply(result) { post({ id: message.id, result: result }); }
    var entry = tools.get(params.name);
    if (!entry) {
      reply({ text: 'Unknown app tool: ' + String(params.name), isError: true });
      return;
    }
    var controller = new AbortController();
    inFlight.set(message.id, controller);
    Promise.resolve()
      .then(function () { return entry.execute(params.arguments || {}, { signal: controller.signal }); })
      .then(
        function (value) { reply(toResult(value)); },
        function (error) {
          reply({ text: String(error && error.message ? error.message : error).slice(0, 1024), isError: true });
        }
      )
      .finally(function () { inFlight.delete(message.id); });
  }, true);
})`;

const SHIM_SCRIPT = `<script>${SHIM_SOURCE}(${JSON.stringify(APP_TOOLS_SYNC_METHOD)}, ${JSON.stringify(APP_TOOLS_CALL_METHOD)}, ${MAX_RESULT_TEXT_CHARS});</script>`;

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
