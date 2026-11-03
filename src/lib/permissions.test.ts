import { afterEach, describe, expect, it, vi } from 'vitest';
import { absoluteUrl, listGrantedOrigins, originPattern, requestOriginAccess } from './permissions';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('absoluteUrl', () => {
  it('resolves relative request URLs against the page', () => {
    expect(absoluteUrl('/api/fail', 'http://127.0.0.1:4820/shop?x')).toBe(
      'http://127.0.0.1:4820/api/fail'
    );
    expect(absoluteUrl('https://b.example/x', 'https://a.example/')).toBe('https://b.example/x');
  });

  it('returns the input when the page URL is unusable', () => {
    expect(absoluteUrl('/api/x', '')).toBe('/api/x');
  });
});

describe('originPattern', () => {
  it('reduces a URL to its origin pattern', () => {
    expect(originPattern('https://api.example.com:8443/v1/x?y=1#z')).toBe(
      'https://api.example.com:8443/*'
    );
    expect(originPattern('http://localhost:4820/api/fail')).toBe('http://localhost:4820/*');
  });

  it('rejects non-http(s) and garbage', () => {
    expect(originPattern('chrome://extensions')).toBeNull();
    expect(originPattern('data:text/plain,hi')).toBeNull();
    expect(originPattern('not a url')).toBeNull();
  });
});

describe('requestOriginAccess', () => {
  it('asks for exactly one origin', async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal('chrome', { permissions: { request } });
    await expect(requestOriginAccess('https://a.example/x')).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ['https://a.example/*'] });
  });

  it('returns false on denial or error without throwing', async () => {
    vi.stubGlobal('chrome', { permissions: { request: vi.fn(async () => false) } });
    await expect(requestOriginAccess('https://a.example/x')).resolves.toBe(false);
    vi.stubGlobal('chrome', {
      permissions: {
        request: vi.fn(async () => {
          throw new Error('no gesture');
        }),
      },
    });
    await expect(requestOriginAccess('https://a.example/x')).resolves.toBe(false);
  });

  it('never prompts for a non-http URL', async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal('chrome', { permissions: { request } });
    await expect(requestOriginAccess('file:///etc/hosts')).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('listGrantedOrigins', () => {
  it('keeps single-origin grants only', async () => {
    vi.stubGlobal('chrome', {
      permissions: {
        getAll: vi.fn(async () => ({
          origins: ['<all_urls>', 'https://b.example/*', '*://*/*', 'http://localhost:4820/*'],
        })),
      },
    });
    await expect(listGrantedOrigins()).resolves.toEqual([
      'http://localhost:4820/*',
      'https://b.example/*',
    ]);
  });
});
