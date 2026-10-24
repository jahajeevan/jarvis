import { randomBytes } from 'node:crypto'
import { fetchText, peek, proxyError } from './net.mjs'

/**
 * Showing a web page on the display.
 *
 * The problem this solves is specific and, until now, unsolvable from the
 * browser side. JARVIS finds an article and wants to put it on screen. Three
 * separate mechanisms stop him:
 *
 *   1. `X-Frame-Options: DENY` / `frame-ancestors` — most publishers refuse to
 *      be framed at all, so an <iframe> pointed at the article is a blank box.
 *   2. CORS — the page cannot fetch the article's HTML to render it itself.
 *   3. Hotlink blocking — even the images inside it 403 for anything that is
 *      not the publisher's own page.
 *
 * All three are the *origin server's* rules about who may load its content, and
 * all three are enforced against the browser. So we take the browser out of it.
 * The bridge fetches the document server-side and serves it back from
 * http://localhost:8787, and at that point the page in the iframe is, as far as
 * the browser is concerned, ours. There is no cross-origin request to refuse, no
 * frame-ancestors to violate, and no CORS preflight to fail. The publisher's
 * headers are not bypassed so much as made irrelevant — they were never about
 * this machine reading the article, which is a thing the user is entitled to do.
 *
 * Two modes, because "show me the article" means two different things:
 *
 *   reader — the words, restyled into this interface. Always legible, never
 *            looks like the source. Nothing loads from the publisher at all;
 *            even the images come back through the bridge's own /img.
 *   live   — the real page, scripts removed. Looks like the site, because
 *            sometimes the layout IS the information. Its own stylesheets and
 *            images load from the publisher, so this mode does tell the
 *            publisher that somebody read it — which is exactly as true as it
 *            would be if the user had opened the tab themselves.
 */

/**
 * The one script allowed to run inside a proxied page.
 *
 * A blade shows articles in an iframe, and an iframe is its own document — the
 * parent cannot scroll it, cannot reach into it, and must not be able to. That
 * is correct for safety and inconvenient for reading: a hand has no scroll
 * wheel, so without a channel the only way through a long article is a mouse.
 *
 * So the page gets one listener, injected by us, that scrolls on request and
 * does nothing else. It is admitted by nonce rather than by 'unsafe-inline', so
 * this exact script runs and anything the publisher shipped does not — and the
 * frame is sandboxed WITHOUT allow-same-origin, so the script executes in an
 * opaque origin that cannot touch this application even though it can move its
 * own scroll position.
 */
const SCROLL_SHIM = `
addEventListener('message', function (e) {
  var d = e.data
  if (!d || d.jarvis !== 'scroll') return
  if (d.to === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return }
  if (d.to === 'bottom') { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); return }
  window.scrollBy({ top: d.dy || 0, behavior: d.smooth ? 'smooth' : 'auto' })
})
// Announce, so the blade knows the listener exists rather than posting into a
// document that has rendered but not yet run anything. Without this the first
// scroll of every article is silently dropped, which reads as scrolling being
// broken rather than early.
try { parent.postMessage({ jarvis: 'ready' }, '*') } catch (e) {}
`

const MAX_PAGE_BYTES = 8 * 1024 * 1024
const PAGE_TIMEOUT_MS = 15_000
const PEEK_TIMEOUT_MS = 8_000

// ---------------------------------------------------------------------------
// Cheap HTML surgery
//
// No DOM parser here on purpose: adding jsdom to a project whose entire pitch
// is "one npm install and it runs" is a poor trade for a reading view. These
// are deliberately blunt, and the failure mode is chosen to be safe — a regex
// that over-matches removes too much and the article reads a little bare; one
// that under-matches would leave a <script> in, so every pattern below errs
// toward removing.
// ---------------------------------------------------------------------------

/** Elements whose entire subtree is noise, or worse. */
const KILL = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'form',
  'iframe', 'object', 'embed', 'applet', 'link', 'meta',
]

function stripDangerous(html) {
  let out = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const tag of KILL) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), '')
    // Void and unclosed forms of the same tags.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '')
  }
  // Inline event handlers, and the two URL schemes that are code.
  out = out.replace(/\son[a-z]+\s*=\s*(["'])[\s\S]*?\1/gi, '')
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
  out = out.replace(/(href|src|action|poster)\s*=\s*(["'])\s*(javascript|data:text\/html|vbscript):[\s\S]*?\2/gi, '$1="#"')
  return out
}

const textOf = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()

const escape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function metaContent(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*>`,
      'i',
    )
    const tag = re.exec(html)?.[0]
    if (!tag) continue
    const value = /content\s*=\s*["']([\s\S]*?)["']/i.exec(tag)?.[1]
    if (value) return textOf(value)
  }
  return ''
}

function titleOf(html) {
  return (
    metaContent(html, ['og:title', 'twitter:title']) ||
    textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') ||
    ''
  )
}

/**
 * Furniture: whole subtrees that are never the article.
 *
 * Stripped before anything is scored, because a navigation region sitting
 * inside <main> is otherwise indistinguishable from content by any measure of
 * size — and on a site whose sidebar is a list of a hundred language names, it
 * is *larger* than the article. That was not hypothetical: the reading view of
 * a Wikipedia page opened on "Afrikaans, العربية, অসমীয়া" and never reached a
 * sentence.
 */
function stripFurniture(html) {
  let out = html
  for (const tag of ['nav', 'aside', 'header', 'footer']) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), '')
  }
  return out
}

/** The text inside a container that is actually prose, in characters. */
function proseLength(html) {
  let total = 0
  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    total += textOf(m[1]).length
  }
  return total
}

/**
 * Find the element that actually holds the article.
 *
 * Scored on how much of a container is *prose* rather than on how big it is.
 * That distinction is the whole algorithm: the largest block on any news page
 * is reliably the entire page, and the largest list is reliably the navigation.
 * Paragraph text is the one signal that separates an article from a menu with
 * the same character count.
 *
 * Deliberately generic. There is no site-specific selector anywhere in here —
 * the moment this file starts naming publishers it becomes a thing that has to
 * be maintained against the web, and it will lose.
 */
function articleBody(html) {
  const clean = stripFurniture(html)

  const candidates = []
  const add = (fragment) => {
    if (!fragment) return
    const prose = proseLength(fragment)
    if (prose > 200) candidates.push({ fragment, prose })
  }

  for (const m of clean.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) add(m[1])
  for (const m of clean.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main>/gi)) add(m[1])
  // Divs and sections too, so a page that uses neither semantic element — still
  // most of the web — is not stuck with the whole document.
  for (const m of clean.matchAll(/<(?:div|section)\b[^>]*>([\s\S]*?)<\/(?:div|section)>/gi)) {
    add(m[1])
  }

  if (candidates.length) {
    // Densest wins, and on a tie the smaller one: nested containers all match,
    // and the innermost is the one that is only the article.
    candidates.sort((a, b) => b.prose - a.prose || a.fragment.length - b.fragment.length)
    const best = candidates[0]
    // Among containers within a whisker of the best score, prefer the tightest
    // — an outer wrapper scores identically to the article it wraps.
    const tight = candidates
      .filter((c) => c.prose >= best.prose * 0.98)
      .sort((a, b) => a.fragment.length - b.fragment.length)[0]
    return tight.fragment
  }

  // Nothing container-shaped held prose. Take the paragraphs wherever they are.
  const paras = [...clean.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi)].map((m) => m[0])
  if (paras.length) return paras.join('\n')
  return clean
}

/**
 * The text the reading view would actually show.
 *
 * Deliberately not "the text in the container". probe_url exists to stop the
 * interface promising things it cannot deliver, so the number it reports has to
 * be measured the same way the renderer measures — otherwise it recommends a
 * reading view for a page like Hacker News, which is four thousand characters
 * of link text and not one paragraph, and the blade opens on a title and
 * nothing else. Same rules, one implementation, no disagreement possible.
 */
function readableText(body) {
  const parts = []
  let seenProse = false
  const pattern = /<(h1|h2|h3|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
  let m
  while ((m = pattern.exec(body)) !== null) {
    const tag = m[1].toLowerCase()
    const text = textOf(m[2])
    if (!text) continue
    if (tag === 'li' && !seenProse) continue
    if (tag === 'p' && text.split(/\s+/).length > 8) seenProse = true
    parts.push(text)
  }
  return parts.join(' ')
}

/** Absolute-ise a URL found in the document against the page it came from. */
function absolute(href, base) {
  try {
    return new URL(href, base).href
  } catch {
    return null
  }
}

/**
 * Pull the readable article out and rebuild it in this interface's own type.
 *
 * Everything that survives is a heading, a paragraph or an image; anything else
 * was furniture. Images are rewritten through /img so that even in reading mode
 * the browser never talks to the publisher.
 */
function toReader(html, pageUrl, bridgeOrigin) {
  const clean = stripDangerous(html)
  const body = articleBody(clean)
  const title = titleOf(html)
  const lead = metaContent(html, ['og:image', 'twitter:image'])

  const blocks = []
  /**
   * List items are only content once prose has started.
   *
   * A run of <li> before the first paragraph is, essentially without exception,
   * metadata: an infobox, a breadcrumb trail, a set of category links, a table
   * of contents. After a paragraph has been seen the same markup is a list
   * *in* the article and belongs. This one bit of state is the difference
   * between a Wikipedia article opening on its first sentence and opening on
   * "Stan Lee (editor/concept), Larry Lieber (writer)".
   */
  let seenProse = false
  const pattern = /<(h1|h2|h3|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>|<img\b([^>]*)>/gi
  let m
  while ((m = pattern.exec(body)) !== null) {
    if (m[3] !== undefined) {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[3])?.[1]
      const abs = src ? absolute(src, pageUrl) : null
      // Spacers, tracking pixels and sprite sheets all arrive as <img>; a data
      // URI here is almost always one of those rather than a photograph.
      if (abs && /^https?:/i.test(abs)) {
        blocks.push(
          `<img class="rd-img" loading="lazy" src="${bridgeOrigin}/img?url=${encodeURIComponent(abs)}" alt="">`,
        )
      }
      continue
    }
    const tag = m[1].toLowerCase()
    const text = textOf(m[2])
    if (!text || text.length < 2) continue
    if (tag === 'li') {
      if (!seenProse) continue
      blocks.push(`<li class="rd-li">${escape(text)}</li>`)
    } else if (tag === 'blockquote') {
      blocks.push(`<blockquote class="rd-q">${escape(text)}</blockquote>`)
    } else if (tag === 'p') {
      // Two words is a caption or a byline fragment, not the body starting.
      if (text.split(/\s+/).length > 8) seenProse = true
      blocks.push(`<p class="rd-p">${escape(text)}</p>`)
    } else {
      blocks.push(`<${tag} class="rd-h">${escape(text)}</${tag}>`)
    }
  }

  const leadImg =
    lead && /^https?:/i.test(lead)
      ? `<img class="rd-lead" src="${bridgeOrigin}/img?url=${encodeURIComponent(lead)}" alt="">`
      : ''

  const host = (() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  })()

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title || host)}</title>
<style>
  :root { color-scheme: dark; }
  html,body { margin:0; background:transparent; }
  body {
    font: 400 15px/1.62 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
    color: #cfe9ee; padding: 18px 22px 40px;
    -webkit-font-smoothing: antialiased;
  }
  .rd-src { font: 500 10px/1 ui-monospace, monospace; letter-spacing:.16em;
            text-transform:uppercase; color:#5fd8e0; opacity:.8; }
  .rd-title { font-size: 25px; line-height:1.2; font-weight:600; color:#eafcff;
              margin: 10px 0 18px; }
  .rd-h { font-size: 16px; color:#eafcff; margin: 22px 0 8px; font-weight:600; }
  .rd-p { margin: 0 0 14px; }
  .rd-li { margin: 0 0 7px 18px; }
  .rd-q { margin: 16px 0; padding-left: 14px; border-left: 2px solid #19c4c4;
          color:#9fdbe2; font-style: italic; }
  img { max-width:100%; height:auto; display:block; border-radius:4px;
        margin: 14px 0; }
  .rd-lead { margin-bottom: 18px; }
  ::-webkit-scrollbar { width: 9px; }
  ::-webkit-scrollbar-thumb { background: #19c4c455; border-radius: 9px; }
</style></head><body>
<div class="rd-src">${escape(host)}</div>
<h1 class="rd-title">${escape(title)}</h1>
${leadImg}
${blocks.join('\n') || '<p class="rd-p">Nothing readable could be extracted from this page.</p>'}
</body></html>`
}

/**
 * The real page, with everything that can execute taken out.
 *
 * `<base>` is what makes this work at all: with the original URL as the base,
 * every relative stylesheet, image and font in the document resolves back to
 * the publisher and loads normally, so the page looks like itself. What it
 * cannot do is run — the response carries `script-src 'none'` and every
 * <script> is gone from the markup before it is served.
 */
function toLive(html, pageUrl) {
  let out = stripDangerous(html)
  // Anything the page said about its own framing or transport belongs to a
  // context that no longer exists, and a stale <base> would send every relative
  // URL somewhere we did not choose.
  out = out.replace(/<base\b[^>]*>/gi, '')
  const injected =
    `<base href="${escape(pageUrl)}">` +
    '<style>html{background:#06101a;color-scheme:dark}' +
    '::-webkit-scrollbar{width:9px}::-webkit-scrollbar-thumb{background:#19c4c455;border-radius:9px}</style>'
  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (h) => `${h}${injected}`)
  } else {
    out = `<!doctype html><html><head><meta charset="utf-8">${injected}</head><body>${out}</body></html>`
  }
  return out
}

/**
 * Serve a page. Returns { body, headers } ready to write.
 *
 * @param {string} url
 * @param {'reader'|'live'} mode
 * @param {string} bridgeOrigin  e.g. http://localhost:8787
 */
export async function renderPage(url, mode, bridgeOrigin) {
  const page = await fetchText(url, {
    maxBytes: MAX_PAGE_BYTES,
    timeoutMs: PAGE_TIMEOUT_MS,
  })
  if (!/^text\/html|^application\/xhtml/.test(page.type)) {
    throw proxyError(415, `not a web page (got ${page.type || 'nothing'})`)
  }

  const live = mode === 'live'
  const nonce = randomBytes(16).toString('base64')
  const shim = `<script nonce="${nonce}">${SCROLL_SHIM}</script>`
  const rendered = live
    ? toLive(page.text, page.url)
    : toReader(page.text, page.url, bridgeOrigin)
  // Appended rather than injected into <head>: by this point every other script
  // is gone, so there is nothing for it to race, and </body> is somewhere every
  // one of these documents actually has.
  const body = rendered.includes('</body>')
    ? rendered.replace('</body>', `${shim}</body>`)
    : rendered + shim

  // The framed document's own policy. The parent page's CSP does not reach in
  // here — an iframe gets its rules from its own response — so this is the only
  // thing standing between a hostile page and script execution on an origin
  // that is allowed to open the agent socket.
  const csp = live
    ? "default-src 'none'; img-src https: http: data: blob:; " +
      "style-src 'unsafe-inline' https: http: data:; font-src https: http: data:; " +
      `media-src https: http: data:; script-src 'nonce-${nonce}'; form-action 'none'; ` +
      "frame-src 'none'; object-src 'none'; base-uri 'none'"
    : `default-src 'none'; img-src ${bridgeOrigin} data:; ` +
      `style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'none'; ` +
      "frame-src 'none'; object-src 'none'; base-uri 'none'"

  return {
    body,
    title: titleOf(page.text),
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      referrerpolicy: 'no-referrer',
      /**
       * Not cached, deliberately.
       *
       * A proxied article is read once and the bytes are cheap to re-fetch, so
       * caching buys very little. What it costs is real: the document carries a
       * per-response CSP nonce and an injected script, and a cached copy is a
       * frozen pairing of both. During development that meant iframes silently
       * replaying a version of the page from before the scroll shim existed —
       * scrolling appeared broken while the freshly served bytes were perfect,
       * which took far longer to find than the feature took to write.
       */
      'cache-control': 'no-store',
    },
  }
}

/**
 * What is at this URL, and what would be the sensible way to show it?
 *
 * This exists so that nothing downstream has to guess. The alternative — a
 * client that sniffs file extensions, or a model that assumes anything ending
 * in .jpg is an image — is wrong often enough to be embarrassing on screen: CDN
 * image URLs routinely carry no extension, news pages redirect to consent
 * walls, and a "video" link is as likely to be an HTML page about a video.
 *
 * The `suggestion` is advice, not instruction. The caller knows things this
 * does not — whether the user asked to *read* it or just to see it, what is
 * already on screen, whether the point was the picture or the argument. It is
 * here so the decision can be informed, not so it can be delegated.
 */
export async function probeUrl(url) {
  let head
  try {
    head = await peek(url, { timeoutMs: PEEK_TIMEOUT_MS })
  } catch (err) {
    return {
      ok: false,
      url,
      reason: err?.message ?? String(err),
      suggestion: 'unavailable',
    }
  }

  const type = head.type || ''
  const kind = /^image\//.test(type)
    ? 'image'
    : /^video\//.test(type)
      ? 'video'
      : /^audio\//.test(type)
        ? 'audio'
        : /^application\/pdf/.test(type)
          ? 'pdf'
          : /^text\/html|^application\/xhtml/.test(type)
            ? 'page'
            : 'other'

  const base = {
    ok: head.status === 200,
    url: head.url,
    status: head.status,
    contentType: type,
    bytes: head.bytes,
    kind,
  }

  if (kind === 'image') {
    return { ...base, suggestion: base.ok ? 'blade_image' : 'unavailable' }
  }
  if (kind === 'video' || kind === 'audio') {
    return { ...base, suggestion: base.ok ? 'blade_video' : 'unavailable' }
  }
  if (kind !== 'page' || !base.ok) {
    return { ...base, suggestion: base.ok ? 'speak_only' : 'unavailable' }
  }

  // It is a page, so find out whether there is an article in it worth reading
  // before promising one.
  try {
    const full = await fetchText(head.url, {
      maxBytes: MAX_PAGE_BYTES,
      timeoutMs: PAGE_TIMEOUT_MS,
    })
    const clean = stripDangerous(full.text)
    const readable = readableText(articleBody(clean))
    const title = titleOf(full.text)
    const lead = metaContent(full.text, ['og:image', 'twitter:image'])
    return {
      ...base,
      title,
      readableChars: readable.length,
      leadImage: lead || null,
      excerpt: readable.slice(0, 300),
      // Enough prose to be worth reading gets the reading view; a page that is
      // mostly interface — a dashboard, a search result, a video page — is only
      // itself when it looks like itself.
      suggestion: readable.length > 900 ? 'blade_reader' : 'blade_live',
    }
  } catch (err) {
    return { ...base, suggestion: 'blade_live', reason: err?.message ?? String(err) }
  }
}
