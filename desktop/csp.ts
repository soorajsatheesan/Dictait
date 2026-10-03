import type { Plugin } from 'vite'

/** Strict Content Security Policy for packaged builds; the dev server needs inline HMR scripts. */
export function contentSecurityPolicy(): Plugin {
  const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; media-src 'none'; object-src 'none'"
  return {
    name: 'dictait-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }]
  }
}
