'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire, Module } = require('node:module');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
function installedPolicy() {
  // Resolve the live dependency graph, never an arbitrary stale pnpm-store folder.
  let from = createRequire(path.join(root, 'apps/client/package.json'));
  let filename;
  for (const name of ['@tarojs/cli', 'latest-version', 'package-json', 'got', 'cacheable-request', 'http-cache-semantics']) {
    filename = from.resolve(name);
    from = createRequire(filename);
  }
  return filename;
}

// The gate sets this to each actual installed package directory it has hashed.
const filename = process.env.WUYAN_SECURITY_PATCH_PACKAGE_PATH
  ? path.join(path.resolve(process.env.WUYAN_SECURITY_PATCH_PACKAGE_PATH), 'index.js')
  : installedPolicy();
const CachePolicy = require(filename);
const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(filename), 'package.json'), 'utf8'));
// Reconstruct the official 4.3.0 source only for negative controls. Positive
// tests always load the installed byte-verified package above.
function pristinePolicy() {
  const input = fs.readFileSync(filename, 'utf8').split('\n');
  const patch = fs.readFileSync(path.join(root, 'patches/http-cache-semantics@4.3.0.patch'), 'utf8').split('\n');
  const output = [];
  let cursor = 0;
  for (let i = 0; i < patch.length; i++) {
    const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(patch[i]);
    if (!match) continue;
    const before = [], after = [];
    for (i++; i < patch.length && /^[ +\-]/.test(patch[i]); i++) {
      if (patch[i][0] !== '+') before.push(patch[i].slice(1));
      if (patch[i][0] !== '-') after.push(patch[i].slice(1));
    }
    i--;
    assert.equal(before.length, Number(match[2]));
    assert.equal(after.length, Number(match[4]));
    const start = Number(match[3]) - 1;
    assert(start >= cursor);
    assert.deepEqual(input.slice(start, start + after.length), after, 'installed source must match reviewed patch');
    output.push(...input.slice(cursor, start), ...before);
    cursor = start + after.length;
  }
  const source = [...output, ...input.slice(cursor)].join('\n');
  assert.equal(createHash('sha256').update(source).digest('hex'), 'ede1cc404a492fa348eb9d97a3007a0d72aa717bd22cd86a56bd0824c19729ca');
  const original = new Module(filename, module);
  original.filename = filename;
  original._compile(source, filename);
  return original.exports;
}
const OriginalCachePolicy = pristinePolicy();
const identity = { url: 'https://example.invalid/account', method: 'GET', headers: { host: 'example.invalid', 'accept-language': 'en' } };
const errors = [500, 502, 503, 504];

function request(headers = {}, changes = {}) {
  return { ...identity, ...changes, headers: { ...identity.headers, ...headers } };
}

function policy({ cc = 'max-age=1, stale-if-error=100, stale-while-revalidate=100', age = 10, headers = {}, req = request(), shared = true, ignoreCargoCult = false, Policy = CachePolicy } = {}, serialized = false) {
  const original = new Policy(req, { status: 200, headers: { age: String(age), 'cache-control': cc, etag: '"synthetic-v1"', ...headers } }, { shared, ignoreCargoCult });
  const value = serialized ? Policy.fromObject(JSON.parse(JSON.stringify(original.toObject()))) : original;
  value.now = () => value._responseTime;
  return value;
}

function hit(value, req = request()) {
  const result = value.evaluateRequest(req);
  assert.equal(result.response?.status, 200);
  assert.equal(result.revalidation, undefined);
  assert.equal(value.satisfiesWithoutRevalidation(req), true);
}

function miss(value, req = request()) {
  const result = value.evaluateRequest(req);
  assert.equal(result.response, undefined);
  assert.equal(result.revalidation?.synchronous, true);
  assert.equal(value.satisfiesWithoutRevalidation(req), false);
}

function errorFallback(value, req, allowed) {
  for (const status of errors) {
    const result = value.revalidatedPolicy(req, { status, headers: {} });
    assert.equal(result.policy === value, allowed, `error ${status}`);
    assert.equal(result.modified, !allowed, `error ${status}`);
    assert.equal(result.matches, allowed, `error ${status}`);
  }
  if (allowed) assert.equal(value.revalidatedPolicy(req, undefined).policy, value);
  else assert.throws(() => value.revalidatedPolicy(req, undefined), /Response headers missing/);
}

test('installed package keeps its upstream identity, version, license and public API', () => {
  assert.equal(metadata.name, 'http-cache-semantics');
  assert.equal(metadata.version, '4.3.0');
  assert.equal(metadata.license, 'BSD-2-Clause');
  const value = policy();
  for (const method of ['storable', 'maxAge', 'age', 'timeToLive', 'satisfiesWithoutRevalidation', 'evaluateRequest', 'responseHeaders', 'revalidationHeaders', 'revalidatedPolicy', 'toObject']) assert.equal(typeof value[method], 'function');
  assert.equal(value.status(), 200);
  assert.equal(value.toObject().v, 1);
});

const restricted = [
  { name: 'shared cookie without opt-in', headers: { 'set-cookie': 'synthetic-session=alice' } },
  { name: 'response no-cache', directive: 'no-cache' },
  { name: 'response must-revalidate', directive: 'must-revalidate' },
  { name: 'shared proxy-revalidate', directive: 'proxy-revalidate' },
  { name: 'shared s-maxage', directive: 's-maxage=1' },
  { name: 'response no-store', directive: 'no-store' },
  { name: 'shared private response', directive: 'private' },
  { name: 'request no-store', req: request({ 'cache-control': 'no-store' }) },
  { name: 'authorization without shared opt-in', req: request({ authorization: 'Bearer synthetic' }) },
];
for (const serialized of [false, true]) {
  for (const scenario of restricted) {
    test(`${scenario.name}: blocks max-stale, SWR and SIE; serialized=${serialized}`, () => {
      const value = policy({ ...scenario, cc: `max-age=1, stale-if-error=100, stale-while-revalidate=100${scenario.directive ? ', ' + scenario.directive : ''}` }, serialized);
      for (const maxStale of ['max-stale', 'max-stale=1000']) miss(value, request({ 'cache-control': maxStale }));
      miss(value);
      assert.equal(value.useStaleWhileRevalidate(), false);
      errorFallback(value, request(), false);
    });
  }

  const permitted = [
    { name: 'ordinary stale response' },
    { name: 'public cookie opt-in', directive: 'public', headers: { 'set-cookie': 'synthetic=public' } },
    { name: 'immutable cookie opt-in', directive: 'immutable', headers: { 'set-cookie': 'synthetic=immutable' } },
    { name: 'private cache cookie', shared: false, headers: { 'set-cookie': 'synthetic=one-user' } },
    { name: 'private cache private response', shared: false, directive: 'private' },
    { name: 'private cache ignores proxy-revalidate', shared: false, directive: 'proxy-revalidate' },
    { name: 'private cache ignores s-maxage', shared: false, directive: 's-maxage=0' },
  ];
  for (const scenario of permitted) {
    test(`${scenario.name}: preserves permitted reuse; serialized=${serialized}`, () => {
      const value = policy({ ...scenario, cc: `max-age=1, stale-if-error=100, stale-while-revalidate=100${scenario.directive ? ', ' + scenario.directive : ''}` }, serialized);
      hit(value, request({ 'cache-control': 'max-stale=1000' }));
      const result = value.evaluateRequest(request());
      assert.equal(result.response?.status, 200);
      assert.equal(result.revalidation?.synchronous, false);
      assert.equal(value.satisfiesWithoutRevalidation(request()), false);
      assert.equal(value.useStaleWhileRevalidate(), true);
      errorFallback(value, request(), true);
      const replacement = value.revalidatedPolicy(request(), { status: 200, headers: { 'cache-control': 'no-store' } });
      assert.notEqual(replacement.policy, value);
      assert.equal(replacement.modified, true);
      assert.equal(replacement.policy.storable(), false);
    });
  }

  for (const directive of ['must-revalidate', 'proxy-revalidate', 's-maxage=60', 'public']) {
    for (const shared of [false, true]) {
      for (const authorized of [false, true]) {
        test(`fresh ${directive}; shared=${shared}; authorization=${authorized}; serialized=${serialized}`, () => {
          const req = request(authorized ? { authorization: 'Bearer synthetic' } : {});
          const value = policy({ cc: `max-age=60, ${directive}`, age: 0, req, shared }, serialized);
          const allowed = !(shared && authorized && directive === 'proxy-revalidate');
          assert.equal(value.storable(), allowed);
          if (allowed) {
            assert.equal(value.maxAge(), 60);
            hit(value, req);
            // RFC shared-cache opt-ins do not imply per-user partitioning without Vary.
            hit(value, request());
          } else miss(value, req);
          miss(value, request({ 'cache-control': 'no-cache' }));
        });
      }
    }
  }

  for (const vary of ['*', ' * ', 'accept-language, *', '* , accept-language']) {
    test(`Vary wildcard ${JSON.stringify(vary)} blocks replay and error fallback; serialized=${serialized}`, () => {
      const value = policy({ headers: { vary } }, serialized);
      miss(value, request({ 'cache-control': 'max-stale=1000' }));
      errorFallback(value, request(), false);
    });
  }

  test(`Vary authorization preserves representation boundaries; serialized=${serialized}`, () => {
    for (const directive of ['must-revalidate', 's-maxage=60', 'public']) {
      const req = request({ authorization: 'Bearer synthetic-a' });
      const value = policy({ cc: `max-age=60, ${directive}, stale-if-error=100`, age: 0, req, headers: { vary: 'Authorization' } }, serialized);
      hit(value, req);
      for (const other of [request(), request({ authorization: 'Bearer synthetic-b' })]) {
        miss(value, other);
        errorFallback(value, other, false);
      }
    }
  });

  test(`SIE checks URL, method, Host and Vary; serialized=${serialized}`, () => {
    const value = policy({ headers: { vary: 'accept-language' } }, serialized);
    errorFallback(value, request(), true);
    errorFallback(value, request({}, { method: 'HEAD' }), true);
    for (const other of [
      request({}, { url: 'https://example.invalid/other' }),
      request({}, { url: undefined }),
      request({}, { method: 'POST' }),
      request({ host: 'other.invalid' }),
      request({ host: undefined }),
      request({ 'accept-language': 'fr' }),
    ]) errorFallback(value, other, false);
    const post = policy({ req: request({}, { method: 'POST' }) }, serialized);
    assert.equal(post.storable(), true);
    errorFallback(post, request({}, { method: 'HEAD' }), false);
    errorFallback(post, request({}, { method: 'POST' }), true);
  });

  for (const directive of ['no-cache', 'must-revalidate', 'proxy-revalidate', 's-maxage=1']) {
    test(`successful 304 validation remains possible for ${directive}; serialized=${serialized}`, () => {
      const value = policy({ cc: `max-age=1, ${directive}` }, serialized);
      miss(value, request({ 'cache-control': 'max-stale=1000' }));
      assert.equal(value.revalidationHeaders(request())['if-none-match'], '"synthetic-v1"');
      const result = value.revalidatedPolicy(request(), { status: 304, headers: { etag: '"synthetic-v1"', age: '0', 'cache-control': `max-age=60, ${directive}` } });
      assert.equal(result.modified, false);
      assert.equal(result.matches, true);
      assert.notEqual(result.policy, value);
      assert.equal(result.policy.status(), 200);
      assert.equal(result.policy.toObject().sh, true);
      result.policy.now = () => result.policy._responseTime;
      if (directive === 'no-cache') miss(result.policy);
      else hit(result.policy);
      const mismatch = value.revalidatedPolicy(request(), { status: 304, headers: { etag: '"different"' } });
      assert.equal(mismatch.matches, false);
      // The upstream mismatched-304 recovery API is unchanged; consumers must inspect matches.
    });
  }

  test(`request directives and delta boundaries; serialized=${serialized}`, () => {
    const value = policy({ cc: 'max-age=1' }, serialized);
    hit(value, request({ 'cache-control': 'Max-Stale=9' }));
    miss(value, request({ 'cache-control': 'max-stale=8' }));
    miss(value, request({ 'cache-control': 'max-stale=1000, no-cache' }));
    miss(value, request({ 'cache-control': 'max-stale=1000, max-age=5' }));
    miss(value, request({ 'cache-control': 'max-stale=1000, min-fresh=1' }));
    miss(value, request({ 'cache-control': 'max-stale=1000', pragma: 'no-cache' }));
    errorFallback(policy({ cc: 'max-age=1, stale-if-error=100', age: 101 }, serialized), request(), true);
    errorFallback(policy({ cc: 'max-age=1, stale-if-error=100', age: 102 }, serialized), request(), false);
    assert.equal(policy({ age: 102 }, serialized).useStaleWhileRevalidate(), false);
  });

  test(`SIE requires an explicit positive window even while fresh; serialized=${serialized}`, () => {
    for (const age of [0, 70]) {
      for (const suffix of ['', ', stale-if-error=0', ', stale-if-error=invalid', ', stale-if-error=-1']) {
        errorFallback(policy({ cc: `max-age=60${suffix}`, age }, serialized), request(), false);
      }
    }
  });
}

test('4.3.0 Vary own-property protection remains intact', () => {
  for (const field of ['constructor', '__proto__']) {
    const inherited = Object.assign(Object.create({ [field]: 'synthetic-inherited' }), identity.headers);
    const value = policy({ cc: 'max-age=60', age: 0, req: { ...identity, headers: inherited }, headers: { vary: field } });
    hit(value, request());
    const owned = Object.assign(Object.create(null), identity.headers, { [field]: 'synthetic-inherited' });
    miss(value, { ...identity, headers: owned });
    errorFallback(value, { ...identity, headers: owned }, false);
  }
});

test('mixed-case response restrictions are enforced before and after serialization', () => {
  for (const directive of ['No-Cache', 'MuSt-ReVaLiDaTe', 'Proxy-Revalidate', 'S-MaxAge=1']) {
    for (const serialized of [false, true]) {
      const value = policy({ cc: `Max-Age=1, ${directive}, Stale-If-Error=100, Stale-While-Revalidate=100` }, serialized);
      miss(value, request({ 'cache-control': 'Max-Stale=1000' }));
      assert.equal(value.useStaleWhileRevalidate(), false);
      errorFallback(value, request(), false);
    }
  }
});

test('legacy v1 serialization normalizes both stored response and request directives', () => {
  const oldResponse = policy().toObject();
  oldResponse.resh['cache-control'] = 'Max-Age=1, No-Cache, Stale-If-Error=100, Stale-While-Revalidate=100';
  oldResponse.rescc = { 'Max-Age': '1', 'No-Cache': true, 'Stale-If-Error': '100', 'Stale-While-Revalidate': '100' };
  const oldRequest = policy().toObject();
  oldRequest.reqcc = { 'No-Store': true };
  for (const old of [oldResponse, oldRequest]) {
    const value = CachePolicy.fromObject(JSON.parse(JSON.stringify(old)));
    value.now = () => value._responseTime;
    miss(value, request({ 'cache-control': 'max-stale=1000' }));
    assert.equal(value.useStaleWhileRevalidate(), false);
    errorFallback(value, request(), false);
    assert.equal(value.toObject().v, 1);
  }
});

const staleBase = 'max-age=1, stale-if-error=100, stale-while-revalidate=100';
function allStalePathsBlocked(value) {
  miss(value, request({ 'cache-control': 'max-stale=1000' }));
  assert.equal(value.useStaleWhileRevalidate(), false);
  errorFallback(value, request(), false);
}
const restrictionNames = ['no-cache', 'no-store', 'private', 'must-revalidate', 'proxy-revalidate', 's-maxage'];
for (const serialized of [false, true]) {
  for (const name of restrictionNames) {
    const directive = name === 's-maxage' ? 's-maxage=1' : name;
    const extensions = [
      `ext=${JSON.stringify(`x,${name}=`)}`,
      `ext=${JSON.stringify(`x",${name}=`)}`,
      `ext=${JSON.stringify(`x\\,${name}=`)}`,
      `ext=${JSON.stringify('x\\')}, ${directive}`,
    ];
    for (const [index, extension] of extensions.entries()) {
      test(`quoted extension cannot override ${name}, case=${index}, serialized=${serialized}`, () => {
        allStalePathsBlocked(policy({ cc: `${staleBase}, ${directive}, ${extension}` }, serialized));
      });
    }
    test(`empty or repeated mixed-case ${name} stays restrictive, serialized=${serialized}`, () => {
      for (const suffix of [`${name}=""`, `${directive}, ${name.toUpperCase()}=""`, `${name.toUpperCase()}="", ${directive}`]) {
        allStalePathsBlocked(policy({ cc: `${staleBase}, ${suffix}` }, serialized));
      }
    });
  }
  for (const optIn of ['public', 'immutable']) {
    test(`quoted ${optIn} cannot opt a shared cookie into reuse, serialized=${serialized}`, () => {
      allStalePathsBlocked(policy({ cc: `${staleBase}, ext=${JSON.stringify(`x,${optIn},y`)}`, headers: { 'set-cookie': 'synthetic=one-user' } }, serialized));
    });
  }
  test(`quoted public cannot opt Authorization into shared storage, serialized=${serialized}`, () => {
    const value = policy({ cc: `${staleBase}, ext="x,public,y"`, req: request({ authorization: 'Bearer synthetic' }) }, serialized);
    assert.equal(value.storable(), false);
    allStalePathsBlocked(value);
  });
  test(`malformed quoting and invalid or duplicate numeric directives fail closed, serialized=${serialized}`, () => {
    const cases = ['ext="unterminated', 'ext="x"junk', 'ext="x\\"', 'ext=a=b', 'max-age=2', 'MAX-AGE="1"', 's-maxage=1, S-MaxAge=2', 'stale-if-error=500', 'stale-while-revalidate=500', 'max-age=-1', 'max-age=1junk', 'public=""', 'immutable=""'];
    for (const suffix of cases) {
      const value = policy({ cc: `${staleBase}, ${suffix}` }, serialized);
      assert.equal(value.storable(), false, suffix);
      allStalePathsBlocked(value);
    }
  });
  test(`valid quoted extension data and quoted delta seconds preserve ordinary reuse, serialized=${serialized}`, () => {
    for (const extension of ['x,y=z', 'x"y\\z', '', 'set-cookie, authorization', '\tdata', '\u0080']) {
      const quoted = '"' + extension.replace(/[\\"]/g, '\\$&') + '"';
      const value = policy({ cc: `max-age="1", stale-if-error="100", stale-while-revalidate="100", ext=${quoted}` }, serialized);
      assert.equal(value.toObject().rescc.ext, extension);
      hit(value, request({ 'cache-control': 'max-stale="1000"' }));
      assert.equal(value.useStaleWhileRevalidate(), true);
      errorFallback(value, request(), true);
    }
  });
  test(`request quoted extensions do not clear no-cache or manufacture max-stale, serialized=${serialized}`, () => {
    const value = policy({ cc: 'max-age=1' }, serialized);
    for (const cc of ['max-stale=1000, no-cache, ext="x,no-cache="', 'ext="x,max-stale=1000,y"', 'max-stale=1000, Max-Stale=2000']) miss(value, request({ 'cache-control': cc }));
    const forbidden = policy({ req: request({ 'cache-control': 'no-store, ext="x,no-store="' }) }, serialized);
    assert.equal(forbidden.storable(), false);
  });
}

test('legacy poisoned objects are rebuilt from authentic raw response headers', () => {
  const scenarios = restrictionNames.map(name => ({ cc: `${staleBase}, ${name === 's-maxage' ? 's-maxage=1' : name}, ext=${JSON.stringify(`x,${name}=`)}` }));
  scenarios.push(
    { cc: `${staleBase}, ext="x,public,y"`, headers: { 'set-cookie': 'synthetic=user' } },
    { cc: `${staleBase}, ext="x,immutable,y"`, headers: { 'set-cookie': 'synthetic=user' } },
    { cc: `${staleBase}, ext="x,public,y"`, req: request({ authorization: 'Bearer synthetic' }) },
  );
  for (const scenario of scenarios) {
    const original = policy({ ...scenario, Policy: OriginalCachePolicy });
    // Official 4.3.0 negative controls demonstrate the exact serialized poison.
    hit(original, request({ 'cache-control': 'max-stale=1000' }));
    assert.equal(original.useStaleWhileRevalidate(), true);
    errorFallback(original, request(), true);
    const restored = CachePolicy.fromObject(JSON.parse(JSON.stringify(original.toObject())));
    restored.now = () => restored._responseTime;
    allStalePathsBlocked(restored);
    const twice = CachePolicy.fromObject(JSON.parse(JSON.stringify(restored.toObject())));
    twice.now = () => twice._responseTime;
    allStalePathsBlocked(twice);
  }
});

test('request v1 normalization never interpolates decoded extension values', () => {
  const object = policy().toObject();
  object.reqcc = { 'No-Store': true, ext: 'x,no-store=', '__proto__': 'unused' };
  const value = CachePolicy.fromObject(JSON.parse(JSON.stringify(object)));
  value.now = () => value._responseTime;
  allStalePathsBlocked(value);
});

test('cache-control formatting preserves quoted values when explicit ignoreCargoCult rewrites headers', () => {
  for (const ext of ['x,no-cache=', 'x",no-store=', 'x\\,private=']) {
    const quoted = '"' + ext.replace(/[\\"]/g, '\\$&') + '"';
    for (const serialized of [false, true]) {
      const value = policy({ cc: `${staleBase}, pre-check=0, post-check=0, no-cache, ext=${quoted}`, ignoreCargoCult: true }, serialized);
      assert.equal(value.toObject().rescc.ext, ext);
      hit(value, request({ 'cache-control': 'max-stale=1000' }));
    }
  }
});

test('legacy response Pragma no-cache survives reconstruction without Cache-Control', () => {
  const value = policy({ headers: { 'cache-control': undefined, pragma: 'no-cache' } }, true);
  allStalePathsBlocked(value);
});

for (const serialized of [false, true]) {
  test(`Pragma no-cache case-insensitive full directive restricts request and legacy response, serialized=${serialized}`, () => {
    for (const pragma of ['no-cache', 'No-Cache', 'NO-CACHE', 'other, nO-cAcHe', 'ext="x,no-cache", No-Cache']) {
      const value = policy({ cc: 'max-age=60', age: 0 }, serialized);
      miss(value, request({ pragma }));
      const response = policy({ headers: { 'cache-control': undefined, pragma } }, serialized);
      allStalePathsBlocked(response);
      const legacy = policy({ Policy: OriginalCachePolicy, headers: { 'cache-control': undefined, pragma } });
      const restored = CachePolicy.fromObject(JSON.parse(JSON.stringify(legacy.toObject())));
      restored.now = () => restored._responseTime;
      allStalePathsBlocked(restored);
    }
  });
  test(`Pragma extension names and quoted content are not no-cache directives, serialized=${serialized}`, () => {
    for (const pragma of ['x-no-cache', 'no-cache-extra', 'ext="no-cache"', 'ext="x,no-cache,y"', 'max-age=extension', 'ext="x\\\",no-cache,y"']) {
      hit(policy({ cc: 'max-age=60', age: 0 }, serialized), request({ pragma }));
      const response = policy({ headers: { 'cache-control': undefined, pragma } }, serialized);
      hit(response, request({ 'cache-control': 'max-stale=1000' }));
    }
  });
}
