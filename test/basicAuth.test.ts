import { describe, expect, it } from 'vitest';
import { checkBasicAuth } from '../src/proxy/basicAuth';

const creds = { user: 'admin', pass: 's3cret' };

function header(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

describe('checkBasicAuth', () => {
  it('accepts valid credentials', () => {
    expect(checkBasicAuth(header('admin', 's3cret'), creds)).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(checkBasicAuth(header('admin', 'wrong'), creds)).toBe(false);
  });

  it('rejects a wrong user', () => {
    expect(checkBasicAuth(header('root', 's3cret'), creds)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(checkBasicAuth(undefined, creds)).toBe(false);
  });

  it('does not throw on malformed base64', () => {
    expect(checkBasicAuth('Basic !!!not-base64!!!', creds)).toBe(false);
    expect(checkBasicAuth('Basic ' + Buffer.from('no-colon-here').toString('base64'), creds)).toBe(false);
  });

  it('handles passwords containing colons', () => {
    const c = { user: 'admin', pass: 'p:a:ss' };
    expect(checkBasicAuth(header('admin', 'p:a:ss'), c)).toBe(true);
  });

  it('is case-insensitive on the scheme', () => {
    expect(checkBasicAuth(`basic ${Buffer.from('admin:s3cret').toString('base64')}`, creds)).toBe(true);
  });
});
