import {
  buildPalette,
  DEFAULT_DARK,
  DESKTOP_LIGHT,
  mix,
} from '../../../src/ink/theme.js';
import type { BrowserCertificate } from './contracts';
export { privateHost } from '../../../src/browser/hosts.js';

// The scheme of the certificate warning Circle shows inside a tab, as Chrome does. Pages
// cannot reach it: navigations to it are refused unless they are the warning's own buttons.
export const WARNING_SCHEME = 'circle-warning';

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );

export interface WarningPage {
  token: string;
  certificate: BrowserCertificate;
  dark: boolean;
  text: (english: string) => string;
  lang: string;
  nonce: string;
}

/** Chrome's privacy error, in Circle's colours: one page the user and the model both use. */
export function warningPage({
  token,
  certificate,
  dark,
  text,
  lang,
  nonce,
}: WarningPage): string {
  const p = buildPalette(...(dark ? DEFAULT_DARK : DESKTOP_LIGHT));
  const rgb = (stop: number) => `rgb(${p.rainbow_stops[stop]![1].join(',')})`;
  const host = escape(certificate.host);
  const fill = (value: string) => escape(text(value)).replace('{host}', host);
  const date = (seconds: number) =>
    escape(new Date(seconds * 1000).toISOString().slice(0, 10));
  const code =
    'NET::' +
    (certificate.error.match(/ERR_[A-Z0-9_]+/i)?.[0].toUpperCase() ??
      certificate.error);
  const fact = (label: string, value: string) =>
    `<div><dt>${escape(text(label))}</dt><dd>${value}</dd></div>`;
  return `<!doctype html><html lang="${escape(lang)}"><head><meta charset="utf-8"><title>${escape(text('Privacy error'))}</title>
<style>
:root{color-scheme:${dark ? 'dark' : 'light'}}
body{margin:0;background:${p.bg_hex};color:${p.fg_hex};font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI Variable","Segoe UI Variable Text","Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
main{max-width:600px;margin:0 auto;padding:12vh 28px 40px}
.icon{width:44px;height:44px;color:${rgb(2)}}
h1{font-size:22px;font-weight:600;margin:20px 0 12px}
p{margin:0 0 12px;color:${mix(p.fg_hex, p.bg_hex, 0.22)}}
code{font:12px ui-monospace,Menlo,monospace;color:${mix(p.fg_hex, p.bg_hex, 0.39)}}
.actions{display:flex;justify-content:space-between;gap:12px;margin:28px 0 20px}
button{font:inherit;border-radius:6px;padding:7px 16px;cursor:pointer}
#advanced{background:transparent;color:${p.fg_hex};border:1px solid ${mix(p.bg_hex, p.fg_hex, 0.3)}}
#back{background:${rgb(0)};color:${p.bg_hex};border:1px solid ${rgb(0)}}
#details{border-top:1px solid ${mix(p.bg_hex, p.fg_hex, 0.15)};padding-top:16px}
#proceed{color:${rgb(2)};text-decoration:underline}
dl{margin:16px 0 0;display:grid;gap:6px}
dl div{display:grid;grid-template-columns:140px 1fr;gap:8px}
dt{color:${mix(p.fg_hex, p.bg_hex, 0.39)}}dd{margin:0;overflow-wrap:anywhere}dd code{word-break:break-all}
</style></head><body><main>
<svg class="icon" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 3 47 43H1Z" fill="currentColor"/><path d="M22 16h4v13h-4zm0 18h4v4h-4z" fill="${p.bg_hex}"/></svg>
<h1>${escape(text('Your connection is not private'))}</h1>
<p>${fill('Attackers might be trying to steal your information from {host} (for example, passwords, messages or credit cards).')}</p>
<code>${escape(code)}</code>
<div class="actions">
<button id="advanced" aria-expanded="false" data-circle-action="advanced">${escape(text('Advanced'))}</button>
<button id="back" data-circle-action="back">${escape(text('Back to safety'))}</button>
</div>
<section id="details" hidden>
<p>${fill('This server could not prove that it is {host}; its security certificate is not trusted by your device. This may be caused by a misconfiguration or an attacker intercepting your connection.')}</p>
<p><a id="proceed" data-circle-action="proceed" href="${WARNING_SCHEME}://${token}/proceed">${fill('Proceed to {host} (unsafe)')}</a></p>
<dl>
${fact('Issued to', escape(certificate.subject))}
${fact('Issued by', escape(certificate.issuer))}
${fact('Valid from', date(certificate.validStart))}
${fact('Valid until', date(certificate.validExpiry))}
${fact('SHA-256 fingerprint', `<code>${escape(certificate.fingerprint)}</code>`)}
</dl>
</section>
</main>
<script nonce="${nonce}">
const advanced = document.getElementById('advanced');
const details = document.getElementById('details');
advanced.addEventListener('click', () => {
  details.hidden = !details.hidden;
  advanced.setAttribute('aria-expanded', String(!details.hidden));
  advanced.textContent = details.hidden ? ${JSON.stringify(text('Advanced'))} : ${JSON.stringify(text('Hide advanced'))};
});
document.getElementById('back').addEventListener('click', () => {
  location.href = ${JSON.stringify(`${WARNING_SCHEME}://${token}/back`)};
});
</script></body></html>`;
}
