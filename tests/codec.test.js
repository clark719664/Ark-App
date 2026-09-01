/*
 * Codec & bundle-logic tests. Run with: node tests/codec.test.js (no deps).
 * The app is a single HTML file; these tests extract the pure-logic
 * <script id="ow-core"> block and run it under Node (22+, which has
 * btoa/atob, TextEncoder, Blob, Response and CompressionStream built in).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = /<script id="ow-core">([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.error('could not extract ow-core script from index.html'); process.exit(1); }
const modObj = { exports: {} };
new Function('module', m[1])(modObj);
const OW = modObj.exports;

let passed = 0;
const failures = [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function bundle(letters, extra) {
  return Object.assign({ v: 1, to: 'Ana', from: 'Sam', letters }, extra || {});
}
function letter(text, extra) {
  return Object.assign({ m: 'you can\'t sleep', e: '🌙', t: text, s: 'classic', c: 'rose', d: null }, extra || {});
}

// --- encode / decode round trips -------------------------------------------

test('round-trip preserves unicode, emoji and newlines', async () => {
  const text = 'Dear Ana,\n\nCafé ☕ — Zürich 🇨🇭 — 你好.\n\tIndented line.\nLove, Sam 💌';
  const payload = await OW.encodeBundle(bundle([letter(text)]));
  const out = await OW.decodeBundle(payload);
  assert.strictEqual(out.letters[0].t, text);
  assert.strictEqual(out.to, 'Ana');
  assert.strictEqual(out.from, 'Sam');
  assert.strictEqual(out.letters[0].e, '🌙');
});

test('long letters compress (payload marked 1c. and smaller than plain)', async () => {
  const long = 'I will always remember the summer we spent by the lake. '.repeat(60);
  const payload = await OW.encodeBundle(bundle([letter(long)]));
  assert.ok(payload.startsWith('1c.'), 'expected compressed payload, got ' + payload.slice(0, 4));
  const plainLen = new TextEncoder().encode(JSON.stringify(bundle([letter(long)]))).length * 4 / 3;
  assert.ok(payload.length < plainLen, 'compressed should beat base64 of plain');
});

test('plain fallback payloads decode', async () => {
  const b = OW.validateBundle(bundle([letter('short and sweet')]));
  const utf8 = new TextEncoder().encode(JSON.stringify(b));
  const payload = '1p.' + OW.bytesToB64u(utf8);
  const out = await OW.decodeBundle(payload);
  assert.strictEqual(out.letters[0].t, 'short and sweet');
});

test('payload characters are URL-fragment safe', async () => {
  const payload = await OW.encodeBundle(bundle([letter('any text at all ~!@#$%^&*()')]));
  assert.ok(/^1[cp]\.[A-Za-z0-9_-]+$/.test(payload), 'payload must be [A-Za-z0-9_.-] only');
});

// --- hostile / malformed input ---------------------------------------------

test('garbage payloads reject cleanly', async () => {
  for (const bad of ['', 'hello', '1x.abc', '2c.abc', '1c.!!!', '1p.', '1c.' + 'A'.repeat(10)]) {
    await assert.rejects(OW.decodeBundle(bad), undefined, 'should reject: ' + JSON.stringify(bad));
  }
});

test('oversize payloads reject before any decoding work', async () => {
  const huge = '1p.' + 'A'.repeat(OW.LIMITS.payloadChars + 10);
  await assert.rejects(OW.decodeBundle(huge), /large/);
});

test('valid base64 of non-JSON rejects', async () => {
  const payload = '1p.' + OW.bytesToB64u(new TextEncoder().encode('not json at all'));
  await assert.rejects(OW.decodeBundle(payload));
});

test('script tags survive as inert text (rendering is textContent-only)', async () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const payload = await OW.encodeBundle(bundle([letter(evil, { m: '<b>bold</b> moment' })]));
  const out = await OW.decodeBundle(payload);
  assert.strictEqual(out.letters[0].t, evil, 'text preserved verbatim as data');
  assert.strictEqual(out.letters[0].m, '<b>bold</b> moment');
});

test('control characters are stripped; newlines and tabs kept', () => {
  const input = 'a' + String.fromCharCode(0) + 'bc\nd\tef' + String.fromCharCode(7);
  const b = OW.validateBundle(bundle([letter(input)]));
  assert.strictEqual(b.letters[0].t, 'abc\nd\tef');
});

// --- validation rules -------------------------------------------------------

test('empty or missing letters throw', () => {
  assert.throws(() => OW.validateBundle(bundle([])));
  assert.throws(() => OW.validateBundle({ v: 1, to: '', from: '' }));
  assert.throws(() => OW.validateBundle(null));
  assert.throws(() => OW.validateBundle(bundle([letter('   ')])), /empty/);
});

test('unknown version throws', () => {
  assert.throws(() => OW.validateBundle(bundle([letter('hi')], { v: 99 })), /version/);
});

test('too many letters throw; exactly the limit is fine', () => {
  const max = Array.from({ length: OW.LIMITS.letters }, () => letter('hello'));
  assert.strictEqual(OW.validateBundle(bundle(max)).letters.length, OW.LIMITS.letters);
  assert.throws(() => OW.validateBundle(bundle(max.concat([letter('one more')]))), /many/);
});

test('over-long fields are clamped, not rejected', () => {
  const b = OW.validateBundle(bundle([letter('x'.repeat(OW.LIMITS.letterChars + 500), {
    m: 'y'.repeat(OW.LIMITS.momentChars + 50)
  })], { to: 'z'.repeat(200) }));
  assert.strictEqual(b.letters[0].t.length, OW.LIMITS.letterChars);
  assert.strictEqual(b.letters[0].m.length, OW.LIMITS.momentChars);
  assert.strictEqual(b.to.length, OW.LIMITS.nameChars);
});

test('unknown stationery and envelope fall back safely', () => {
  const b = OW.validateBundle(bundle([
    letter('a', { s: 'papyrus', c: 'neon' }),
    letter('b', { s: 'hand', c: 'sage' })
  ]));
  assert.strictEqual(b.letters[0].s, 'classic');
  assert.ok(OW.ENVELOPES.includes(b.letters[0].c));
  assert.strictEqual(b.letters[1].s, 'hand');
  assert.strictEqual(b.letters[1].c, 'sage');
});

test('malformed date locks are dropped', () => {
  const b = OW.validateBundle(bundle([
    letter('a', { d: 'not-a-date' }),
    letter('b', { d: '2026-12-25' }),
    letter('c', { d: 12345 })
  ]));
  assert.strictEqual(b.letters[0].d, null);
  assert.strictEqual(b.letters[1].d, '2026-12-25');
  assert.strictEqual(b.letters[2].d, null);
});

// --- date locks -------------------------------------------------------------

test('isLocked: locked strictly before local midnight of the date', () => {
  const L = { d: '2026-12-25' };
  assert.strictEqual(OW.isLocked(L, new Date(2026, 11, 24, 23, 59)), true);
  assert.strictEqual(OW.isLocked(L, new Date(2026, 11, 25, 0, 0)), false);
  assert.strictEqual(OW.isLocked(L, new Date(2027, 0, 1)), false);
  assert.strictEqual(OW.isLocked({ d: null }, new Date(2000, 0, 1)), false);
});

// --- links ------------------------------------------------------------------

test('linkFor and payloadFromHash are inverse', () => {
  const link = OW.linkFor('https://example.com/letters/#old', '1c.abc-_123');
  assert.strictEqual(link, 'https://example.com/letters/#g=1c.abc-_123');
  assert.strictEqual(OW.payloadFromHash('#g=1c.abc-_123'), '1c.abc-_123');
  assert.strictEqual(OW.payloadFromHash('#other=1&g=xyz'), 'xyz');
  assert.strictEqual(OW.payloadFromHash('#nothing'), null);
  assert.strictEqual(OW.payloadFromHash(''), null);
});

test('seedFromHash parses moment keys', () => {
  assert.deepStrictEqual(OW.seedFromHash('#seed=sleep,doubt,last'), ['sleep', 'doubt', 'last']);
  assert.strictEqual(OW.seedFromHash('#g=abc'), null);
});

test('every seed key in MOMENT_GROUPS resolves via findMoment', () => {
  OW.MOMENT_GROUPS.forEach(g => g.moments.forEach(mo => {
    assert.ok(OW.findMoment(mo.key), mo.key);
    assert.ok(/^[a-z0-9-]+$/.test(mo.key), 'seed-safe key: ' + mo.key);
    assert.ok(mo.hint.length > 10, 'every moment has a real hint');
  }));
});

// --- misc -------------------------------------------------------------------

test('linkHealth grades by length', () => {
  assert.strictEqual(OW.linkHealth(500).grade, 'g');
  assert.strictEqual(OW.linkHealth(4000).grade, 'a');
  assert.strictEqual(OW.linkHealth(9000).grade, 'o');
  assert.strictEqual(OW.linkHealth(20000).grade, 'r');
});

test('tinyHash is stable and distinguishes payloads', () => {
  assert.strictEqual(OW.tinyHash('abc'), OW.tinyHash('abc'));
  assert.notStrictEqual(OW.tinyHash('abc'), OW.tinyHash('abd'));
});

test('b64u round-trips arbitrary bytes including chunk boundaries', () => {
  const big = new Uint8Array(70000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
  const back = OW.b64uToBytes(OW.bytesToB64u(big));
  assert.strictEqual(back.length, big.length);
  for (let i = 0; i < big.length; i++) {
    if (back[i] !== big[i]) throw new Error('byte mismatch at ' + i);
  }
});

test("payloadFromHash sheds trailing messenger punctuation", () => {
  assert.strictEqual(OW.payloadFromHash("#g=1c.abc123)."), "1c.abc123");
  assert.strictEqual(OW.payloadFromHash("#g=1c.abc123"), "1c.abc123");
});

test("decompression bombs abort at the size cap", async () => {
  const zeros = new Uint8Array(8 * 1024 * 1024); // 8MB of zeros compresses tiny
  const stream = new Blob([zeros]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const packed = new Uint8Array(await new Response(stream).arrayBuffer());
  const payload = "1c." + OW.bytesToB64u(packed);
  assert.ok(payload.length < OW.LIMITS.payloadChars, "bomb fits the payload limit");
  await assert.rejects(OW.decodeBundle(payload), /large/);
});

test("CRLF is normalized to LF", () => {
  const b = OW.validateBundle(bundle([letter("line one\r\nline two\rline three")]));
  assert.strictEqual(b.letters[0].t, "line one\nline two\nline three");
});

// --- runner -----------------------------------------------------------------

(async () => {
  for (const t of tests) {
    try { await t.fn(); passed++; }
    catch (err) { failures.push({ name: t.name, err }); }
  }
  if (failures.length) {
    console.error('FAILED ' + failures.length + ' / ' + tests.length);
    for (const f of failures) {
      console.error('\n✗ ' + f.name);
      console.error('  ' + (f.err && f.err.message));
    }
    process.exit(1);
  }
  console.log('ok — ' + passed + ' tests passed');
})();
