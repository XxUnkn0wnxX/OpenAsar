const assert = require('node:assert/strict');
const { test } = require('node:test');
const install = require('../src/utils/deduplicateCorsHeaders');

const origin = 'https://discord.com';
const duplicated = () => ({
  'Access-Control-Allow-Origin': [ origin, origin ],
  'Set-Cookie': [ 'a=1', 'b=2' ],
  'X-Other': [ 'one', 'two' ]
});

const setup = () => {
  const appEvents = {};
  const attempts = [];
  let ready = false;
  const defaultSession = { webRequest: {
    onHeadersReceived(...args) {
      attempts.push({ receiver: this, args });
      return 'registered';
    }
  } };
  const app = {
    isReady: () => ready,
    on: (name, fn) => { appEvents[name] = fn; },
    once: (name, fn) => { appEvents[name] = fn; }
  };
  const electronSession = {};
  Object.defineProperty(electronSession, 'defaultSession', {
    get() {
      if (!ready) throw new Error('defaultSession accessed before app ready');
      return defaultSession;
    }
  });
  install(app, electronSession, true);

  return {
    appEvents,
    attempts,
    defaultSession,
    createSession() {
      const session = { webRequest: {
        onHeadersReceived(...args) {
          attempts.push({ receiver: this, args });
          return 'registered';
        }
      } };
      appEvents['session-created'](session);
      return session;
    },
    becomeReady() { ready = true; },
    emitReady() { appEvents.ready(); }
  };
};

test('repairs identical valid origins and preserves other headers and special keys', () => {
  assert.deepEqual(install.normalizeCorsHeaders(duplicated()), {
    'Set-Cookie': [ 'a=1', 'b=2' ],
    'X-Other': [ 'one', 'two' ],
    'Access-Control-Allow-Origin': [ origin ]
  });
  assert.deepEqual(install.normalizeCorsHeaders({ 'access-control-allow-origin': [ origin ], 'Access-Control-Allow-Origin': [ origin ] }), {
    'access-control-allow-origin': [ origin ]
  });
  assert.deepEqual(install.normalizeCorsHeaders({ 'Access-Control-Allow-Origin': `${origin},\x20${origin}` }), {
    'Access-Control-Allow-Origin': [ origin ]
  });

  const special = { 'Access-Control-Allow-Origin': [ origin, origin ] };
  Object.defineProperty(special, '__proto__', { value: [ 'kept' ], enumerable: true });
  const normalized = install.normalizeCorsHeaders(special);
  assert.deepEqual(Object.getOwnPropertyDescriptor(normalized, '__proto__').value, [ 'kept' ]);
  for (const headers of [
    { 'Access-Control-Allow-Origin': [ origin, 'https://other.test' ] },
    { 'Access-Control-Allow-Origin': [ '', '' ] },
    { 'Access-Control-Allow-Origin': [ '*', '*' ] },
    { 'Access-Control-Allow-Origin': [ 'garbage', 'garbage' ] },
    { 'Access-Control-Allow-Origin': [ `${origin}\r\n`, `${origin}\r\n` ] }
  ]) assert.equal(install.normalizeCorsHeaders(headers), null);
});

test('session-created decorates own methods while nondefault receiver calls pass through', () => {
  const state = setup();
  const session = state.createSession();
  const listener = () => {};

  session.webRequest.onHeadersReceived(listener);
  assert.equal(state.attempts.at(-1).args[0], listener);

  state.becomeReady();
  const borrowed = session.webRequest.onHeadersReceived;
  borrowed.call(state.defaultSession.webRequest, listener);
  assert.notEqual(state.attempts.at(-1).args[0], listener);
  assert.equal(state.attempts.at(-1).receiver, state.defaultSession.webRequest);
});

test('ready fallback respects registration-before-ready and ready-before-registration orderings', () => {
  const registrationFirst = setup();
  registrationFirst.becomeReady();
  const session = registrationFirst.createSession();
  session.webRequest.onHeadersReceived.call(registrationFirst.defaultSession.webRequest, () => {});
  registrationFirst.emitReady();
  assert.equal(registrationFirst.attempts.length, 1);

  const readyFirst = setup();
  readyFirst.becomeReady();
  readyFirst.emitReady();
  assert.equal(readyFirst.attempts.length, 1);
  const created = readyFirst.createSession();
  created.webRequest.onHeadersReceived.call(readyFirst.defaultSession.webRequest, () => {});
  assert.equal(readyFirst.attempts.length, 2);
});

test('native registration failure propagates and does not suppress the ready fallback', () => {
  const state = setup();
  state.becomeReady();
  state.defaultSession.webRequest.onHeadersReceived = function() {
    state.attempts.push({ args: Array.from(arguments) });
    if (state.attempts.length === 1) throw new Error('native registration failed');
  };
  state.appEvents['session-created'](state.defaultSession);
  assert.throws(() => state.defaultSession.webRequest.onHeadersReceived(() => {}), /native registration failed/);
  state.emitReady();
  assert.equal(state.attempts.length, 2);
});

test('filter, receiver, extra arguments, and successful null removal are preserved', () => {
  const state = setup();
  state.becomeReady();
  const session = state.createSession();
  const filter = { urls: [ 'https://discord.com/*' ] };
  const receiver = state.defaultSession.webRequest;
  const token = {};
  session.webRequest.onHeadersReceived.call(receiver, filter, () => {}, token);
  const registration = state.attempts[0];
  assert.equal(registration.receiver, receiver);
  assert.equal(registration.args[0], filter);
  assert.equal(registration.args[2], token);

  session.webRequest.onHeadersReceived.call(receiver, null);
  state.emitReady();
  assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[1].args[0], null);
});

test('OBD-style borrowed CSP listener coexists with normalization and returns its header edits', () => {
  const state = setup();
  state.becomeReady();
  const freshPartition = state.createSession();
  const filter = { urls: [ 'https://discord.com/*' ] };
  freshPartition.webRequest.onHeadersReceived.call(state.defaultSession.webRequest, filter, (details, callback) => {
    delete details.responseHeaders['Content-Security-Policy'];
    callback({ responseHeaders: details.responseHeaders });
  });
  const listener = state.attempts[0].args[1];
  const details = { responseHeaders: { ...duplicated(), 'Content-Security-Policy': [ 'default-src none' ] } };
  let result;
  listener(details, response => { result = response; });
  assert.equal(result.responseHeaders['Content-Security-Policy'], undefined);
  assert.deepEqual(result.responseHeaders['Access-Control-Allow-Origin'], [ origin ]);
  state.emitReady();
  assert.equal(state.attempts.length, 1);
});

test('consumer mutation cannot alter snapshotted headers or arrays; override, undefined, and cancellation are handled', () => {
  const state = setup();
  state.becomeReady();
  state.emitReady();
  const responses = [];
  const consumer = function(details, callback) {
    details.responseHeaders['Access-Control-Allow-Origin'][0] = 'https://changed.test';
    details.responseHeaders['Set-Cookie'].push('c=3');
    details.responseHeaders['X-Other'][0] = 'changed';
    callback({ statusLine: 'HTTP/1.1 200 OK' });
    callback({ responseHeaders: undefined });
    callback({ responseHeaders: duplicated(), statusLine: 'HTTP/1.1 201 Created', cancel: false });
    callback({ responseHeaders: {}, statusLine: 'HTTP/1.1 202 Empty' });
    callback({ cancel: true, statusLine: 'HTTP/1.1 403 Forbidden' });
  };
  state.defaultSession.webRequest.onHeadersReceived(consumer);
  const registered = state.attempts[1].args[0];
  registered({ responseHeaders: duplicated() }, response => responses.push(response));
  const snapshot = { 'Set-Cookie': [ 'a=1', 'b=2' ], 'X-Other': [ 'one', 'two' ], 'Access-Control-Allow-Origin': [ origin ] };
  assert.deepEqual(responses[0], { responseHeaders: snapshot });
  assert.deepEqual(responses[1], { responseHeaders: snapshot });
  assert.deepEqual(responses[2].responseHeaders['Access-Control-Allow-Origin'], [ origin ]);
  assert.equal(responses[2].statusLine, 'HTTP/1.1 201 Created');
  assert.deepEqual(responses[3], { responseHeaders: {}, statusLine: 'HTTP/1.1 202 Empty' });
  assert.deepEqual(responses[4], { cancel: true, statusLine: 'HTTP/1.1 403 Forbidden' });
});

test('unchanged callbacks keep identity, receiver, arguments, and listener return value', () => {
  const state = setup();
  state.becomeReady();
  state.emitReady();
  const marker = { responseHeaders: { 'X-Other': [ 'same' ] } };
  const callbackReceiver = {};
  const extra = {};
  let received;
  const callback = function(response, second) { received = { response, second, receiver: this }; return 'callback-result'; };
  const token = {};
  state.defaultSession.webRequest.onHeadersReceived(function(details, wrappedCallback, third) {
    assert.equal(details.marker, token);
    assert.equal(third, extra);
    return wrappedCallback.call(callbackReceiver, marker, extra);
  });
  const registered = state.attempts[1].args[0];
  assert.equal(registered({ marker: token }, callback, extra), 'callback-result');
  assert.equal(received.response, marker);
  assert.equal(received.second, extra);
  assert.equal(received.receiver, callbackReceiver);
});

test('inherited callback overrides remain explicit and retain their status line', () => {
  const state = setup();
  state.becomeReady();
  state.emitReady();
  const responses = [
    Object.create({ responseHeaders: { 'X-Only': [ 'declared' ] } }),
    Object.create({ responseHeaders: duplicated(), statusLine: 'HTTP/1.1 206 Partial Content' })
  ];
  for (const response of responses) {
    state.defaultSession.webRequest.onHeadersReceived((details, callback) => callback(response));
    const registered = state.attempts.at(-1).args[0];
    let delivered;
    registered({ responseHeaders: duplicated() }, value => { delivered = value; });
    if (response === responses[0]) assert.equal(delivered, response);
    else {
      assert.deepEqual(delivered.responseHeaders['Access-Control-Allow-Origin'], [ origin ]);
      assert.equal(delivered.statusLine, 'HTTP/1.1 206 Partial Content');
    }
  }
});

test('ready fallback normalizes duplicates when no default registration was observed', () => {
  const state = setup();
  state.becomeReady();
  state.emitReady();
  assert.equal(state.attempts.length, 1);
  const [ listener ] = state.attempts[0].args;
  let result;
  listener({ responseHeaders: duplicated() }, value => { result = value; });
  assert.deepEqual(result.responseHeaders['Access-Control-Allow-Origin'], [ origin ]);
});
