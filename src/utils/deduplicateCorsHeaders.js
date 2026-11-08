'use strict';

const trimOws = value => value.replace(/^[\x20\t]+|[\x20\t]+$/g, '');

const normalizeCorsHeaders = headers => {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;

  const keys = Object.keys(headers).filter(key => key.toLowerCase() === 'access-control-allow-origin');
  if (keys.length === 0) return null;

  const values = [];
  for (const key of keys) {
    const raw = headers[key];
    const value = Array.isArray(raw) ? raw : [ raw ];
    if (value.length === 0) return null;
    for (const item of value) {
      if (typeof item !== 'string' || trimOws(item) === '') return null;
      const parts = item.split(',').map(trimOws);
      if (parts.some(part => part === '' || part === '*')) return null;
      values.push(...parts);
    }
  }

  if (values.length < 2 || values.some(value => value !== values[0])) return null;
  try {
    const parsed = new URL(values[0]);
    if (parsed.origin === 'null' || parsed.origin !== values[0]) return null;
  } catch {
    return null;
  }

  const copy = [];
  for (const [ key, value ] of Object.entries(headers)) {
    if (key.toLowerCase() === 'access-control-allow-origin') continue;
    copy.push([ key, Array.isArray(value) ? value.slice() : value ]);
  }
  copy.push([ keys[0], [ values[0] ] ]);
  return Object.fromEntries(copy);
};

const createListener = listener => function(...args) {
  const details = args[0];
  const callback = args[1];
  if (typeof callback !== 'function') return listener.apply(this, args);

  const originalHeaders = details && details.responseHeaders;
  const repairedOriginal = normalizeCorsHeaders(originalHeaders);
  const originalCallback = callback;

  const wrappedCallback = function(...callbackArgs) {
    const response = callbackArgs[0];
    if (!response || response.cancel || typeof response !== 'object') {
      return originalCallback.apply(this, callbackArgs);
    }

    const hasOverride = response.responseHeaders !== undefined;
    const overrideRepair = hasOverride && normalizeCorsHeaders(response.responseHeaders);
    if (overrideRepair) {
      const repairedResponse = { ...response, responseHeaders: overrideRepair };
      Object.setPrototypeOf(repairedResponse, Object.getPrototypeOf(response));
      return originalCallback.apply(this, [ repairedResponse, ...callbackArgs.slice(1) ]);
    }
    if (!hasOverride && repairedOriginal) {
      const { statusLine, ...rest } = response;
      return originalCallback.apply(this, [ { ...rest, responseHeaders: repairedOriginal }, ...callbackArgs.slice(1) ]);
    }
    return originalCallback.apply(this, callbackArgs);
  };

  return listener.apply(this, [ args[0], wrappedCallback, ...args.slice(2) ]);
};

module.exports = (app, electronSession, enabled) => {
  if (enabled !== true || !app || !electronSession) return;

  const decorated = new WeakSet();
  let defaultRegistrationObserved = false;
  const getDefaultSession = () => {
    if (!app.isReady()) return null;
    try {
      return electronSession.defaultSession;
    } catch {
      return null;
    }
  };
  const decorate = targetSession => {
    const webRequest = targetSession && targetSession.webRequest;
    if (!webRequest || decorated.has(webRequest) || typeof webRequest.onHeadersReceived !== 'function') return;

    const native = webRequest.onHeadersReceived;
    const wrapped = function() {
      const args = Array.from(arguments);
      const listenerIndex = typeof args[0] === 'function' || args[0] === null ? 0 : 1;
      const listener = args[listenerIndex];
      let defaultTarget = false;
      try {
        const defaultSession = getDefaultSession();
        defaultTarget = defaultSession !== null && this === defaultSession.webRequest;
      } catch {}

      if (!defaultTarget || (listener !== null && typeof listener !== 'function')) return native.apply(this, args);

      const result = native.apply(this, listener === null ? args : args.map((arg, index) => index === listenerIndex ? createListener(listener) : arg));
      defaultRegistrationObserved = true;
      return result;
    };

    Object.defineProperty(webRequest, 'onHeadersReceived', {
      configurable: true,
      enumerable: Object.prototype.propertyIsEnumerable.call(webRequest, 'onHeadersReceived'),
      writable: true,
      value: wrapped
    });
    decorated.add(webRequest);
  };

  app.on('session-created', decorate);
  const installDefaultFallback = () => {
    const defaultSession = getDefaultSession();
    if (!defaultSession) return;
    decorate(defaultSession);
    if (!defaultRegistrationObserved && defaultSession && defaultSession.webRequest) {
      defaultSession.webRequest.onHeadersReceived((details, callback) => callback({}));
    }
  };

  if (app.isReady()) installDefaultFallback();
  else app.once('ready', installDefaultFallback);
};

module.exports.normalizeCorsHeaders = normalizeCorsHeaders;
