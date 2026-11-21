function resolve(input) {
  // §18.1.1, on the string, before anything else.
  if (!/^mcpl:\/\//i.test(input)) throw new Error('reject: no mcpl:// at the start');
  if (/[\\\x00-\x20]/.test(input)) throw new Error('reject: backslash, control character or space');
  if (input.includes('#')) throw new Error('reject: fragment');
  const afterScheme = input.slice(input.indexOf('//') + 2);
  const authEnd = afterScheme.search(/[\/?]/);
  const authority = authEnd === -1 ? afterScheme : afterScheme.slice(0, authEnd);
  if (authority === '') throw new Error('reject: empty authority');
  if (authority.includes('@')) throw new Error('reject: userinfo');
  const pathPart = authEnd === -1 ? '' : afterScheme.slice(authEnd);
  const pathOnly = pathPart.split('?')[0];
  for (const seg of pathOnly.split('/')) {
    const d = seg.replace(/%2e/gi, '.');
    if (d === '.' || d === '..') throw new Error('reject: dot segment');
  }
  const wss = 'wss://' + input.slice(input.indexOf('//') + 2);
  const u = new URL(wss);          // throws on an invalid port or host
  return { resolved: u.href, canonical: 'mcpl://' + u.href.slice('wss://'.length) };
}
// §18.2's steps 2 and 3 alone: what an input becomes when §18.1.1 is skipped.
function unchecked(input) {
  try { return new URL(input.replace(/^mcpl:/i, 'wss:')).href; } catch { return null; }
}
// §18.7.1, vectors 1 to 13, in the order of the table: the input, then its resolvedTransport.
// The canonicalUri is that value with the scheme mapped back.
const accepted = [
  ['mcpl://example.com', 'wss://example.com/'],
  ['mcpl://example.com/path', 'wss://example.com/path'],
  ['mcpl://example.com:8443/x', 'wss://example.com:8443/x'],
  ['mcpl://eidoverse.animalabs.ai?world=abc', 'wss://eidoverse.animalabs.ai/?world=abc'],
  ['MCPL://Example.COM/x', 'wss://example.com/x'],
  ['mcpl://EIDOVERSE.Animalabs.AI:443/x', 'wss://eidoverse.animalabs.ai/x'],
  ['mcpl://ünicode.example/x', 'wss://xn--nicode-2ya.example/x'],
  ['mcpl://[2001:DB8::1]:8443/x', 'wss://[2001:db8::1]:8443/x'],
  ['mcpl://localhost/x', 'wss://localhost/x'],
  ['mcpl://h/p?b=2&a=1', 'wss://h/p?b=2&a=1'],
  ['mcpl://h/x?a=1&a=2', 'wss://h/x?a=1&a=2'],
  ['mcpl://h/a%2fb', 'wss://h/a%2fb'],
  ['mcpl://h/%7Euser', 'wss://h/%7Euser'],
];
// §18.7.2, vectors 14 to 29.
const rejected = [
  'mcpl:///x', 'mcpl://u:p@h/x', 'mcpl://h/x#frag', 'mcpl://h/a/../b', 'mcpl://h/a/%2e%2e/b',
  'mcpl://h/a/./b', 'mcpl://h:99999/x',
  'mcpl:/h/x', 'mcpl:h/x', 'mcpl:/\\h/x', 'mcpl:\\\\h/x', 'mcpl://h/a\\..\\b', 'mcpl://h/a/.\t./b',
  'MCPL:///x', 'mcpl:////x', 'mcpl://h/x ',
];
let n = 0;
let failed = 0;
for (const [c, want] of accepted) {
  n++;
  try {
    const r = resolve(c);
    const ok = r.resolved === want && r.canonical === 'mcpl://' + want.slice('wss://'.length);
    if (!ok) failed++;
    console.log(String(n).padStart(2), ok ? 'OK    ' : 'WRONG ', c.padEnd(38), '->', r.resolved, '| canon:', r.canonical, ok ? '' : `| expected ${want}`);
  } catch (e) { failed++; console.log(String(n).padStart(2), 'WRONG ', c.padEnd(38), '-> rejected:', e.message); }
}
for (const c of rejected) {
  n++;
  const shown = JSON.stringify(c).slice(1, -1);
  const else_ = unchecked(c);
  try { const r = resolve(c); failed++; console.log(String(n).padStart(2), 'WRONG ', shown.padEnd(38), '-> accepted as', r.resolved); }
  catch (e) { console.log(String(n).padStart(2), 'REJECT', shown.padEnd(38), '->', e.message, '| unchecked:', else_ ?? 'the parser throws'); }
}
if (failed) { console.log(`${failed} vector(s) wrong`); process.exit(1); }
