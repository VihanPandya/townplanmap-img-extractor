import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHostname, classifyIpv4, classifyIpv6 } from '@/lib/security/ip';
import { parseTargetUrl, UrlSecurityError } from '@/lib/security/url-guard';

test('IPv4 classification blocks every non-routable range', () => {
  const blocked = [
    '127.0.0.1',
    '127.5.5.5',
    '10.0.0.7',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '240.0.0.1',
    '198.18.0.1',
  ];
  for (const address of blocked) {
    assert.equal(classifyIpv4(address).blocked, true, `${address} should be blocked`);
  }

  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1']) {
    assert.equal(classifyIpv4(address).blocked, false, `${address} should be allowed`);
  }
});

test('IPv6 classification covers loopback, ULA, link-local and mapped IPv4', () => {
  const blocked = [
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::192.168.0.1',
    '2002::1',
  ];
  for (const address of blocked) {
    assert.equal(classifyIpv6(address).blocked, true, `${address} should be blocked`);
  }

  for (const address of ['2606:4700:4700::1111', '2a00:1450:4001:80e::200e', '::ffff:8.8.8.8']) {
    assert.equal(classifyIpv6(address).blocked, false, `${address} should be allowed`);
  }
});

test('hostname classification blocks local and metadata names', () => {
  for (const host of ['localhost', 'app.localhost', 'printer.local', 'db.internal', 'metadata.google.internal']) {
    assert.equal(classifyHostname(host).blocked, true, `${host} should be blocked`);
  }
  assert.equal(classifyHostname('townplanmap.com').blocked, false);
});

test('parseTargetUrl rejects non-http protocols', () => {
  for (const input of [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'gopher://example.com',
  ]) {
    assert.throws(() => parseTargetUrl(input), UrlSecurityError, `${input} should be rejected`);
  }
});

test('parseTargetUrl rejects embedded credentials and blocked ports', () => {
  assert.throws(() => parseTargetUrl('https://user:pass@example.com'), UrlSecurityError);
  assert.throws(() => parseTargetUrl('http://example.com:22/'), UrlSecurityError);
  assert.throws(() => parseTargetUrl('http://example.com:6379/'), UrlSecurityError);
  // A non-standard but plausible web port stays allowed.
  assert.equal(parseTargetUrl('http://example.com:8080/').port, '8080');
});

test('parseTargetUrl adds a protocol, drops fragments and rejects empties', () => {
  assert.equal(parseTargetUrl('townplanmap.com').toString(), 'https://townplanmap.com/');
  assert.equal(parseTargetUrl('https://example.com/a#b').toString(), 'https://example.com/a');
  assert.throws(() => parseTargetUrl('   '), UrlSecurityError);
  assert.throws(() => parseTargetUrl('http://'), UrlSecurityError);
});
