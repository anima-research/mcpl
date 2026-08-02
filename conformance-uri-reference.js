function resolve(input) {
  if (!/^mcpl:\/\//i.test(input)) throw new Error('not an mcpl:// URI');
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
  const u = new URL(wss);          // throws on bad port etc.
  return { resolved: u.href, canonical: 'mcpl://' + u.href.slice('wss://'.length) };
}
const cases = [
  'mcpl://example.com', 'mcpl://example.com/path', 'mcpl://example.com:8443/x',
  'mcpl://eidoverse.animalabs.ai?world=abc', 'mcpl://h/p?b=2&a=1', 'mcpl://h/x?a=1&a=2',
  'MCPL://Example.COM/x', 'mcpl://EIDOVERSE.Animalabs.AI:443/x', 'mcpl://ünicode.example/x',
  'mcpl://[2001:DB8::1]:8443/x', 'mcpl://localhost/x', 'mcpl://h/a%2fb', 'mcpl://h/%7Euser',
  'mcpl:///x', 'mcpl://u:p@h/x', 'mcpl://h/x#frag', 'mcpl://h/a/../b', 'mcpl://h/a/%2e%2e/b',
  'mcpl://h/a/./b', 'mcpl://h:99999/x',
];
for (const c of cases) {
  try { const r = resolve(c); console.log('OK    ', c.padEnd(38), '->', r.resolved, '| canon:', r.canonical); }
  catch (e) { console.log('REJECT', c.padEnd(38), '->', e.message); }
}
