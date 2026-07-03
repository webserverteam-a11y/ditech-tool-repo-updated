/**
 * scripts/patch-add-keyword-update-nav.js
 *
 * Injects a "Keyword Update" nav item after "Indexing Status" in the sidebar.
 * Strategy: append a <script> block to dist/index.html that uses
 * MutationObserver to find the Indexing Status nav link at runtime (which is
 * itself dynamically injected), clones it for identical styling, and
 * inserts a sibling that opens /keyword-update in a new tab.
 *
 * Idempotent: detects the _dt-kwu-nav-injected marker and exits cleanly.
 * Safe: only ADDS a new element — never modifies or removes existing nodes.
 *
 * Usage:
 *   node scripts/patch-add-keyword-update-nav.js
 *
 * Wired into postinstall in package.json for auto-deploy.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'dist', 'index.html');

const MARKER = '<!-- _dt-kwu-nav-injected -->';
const ANCHOR = '</body>';

if (!fs.existsSync(HTML_PATH)) {
  console.error('ERROR: dist/index.html not found');
  process.exit(1);
}

let html = fs.readFileSync(HTML_PATH, 'utf8');

// Idempotency check
if (html.includes(MARKER)) {
  console.log('[patch-add-keyword-update-nav] Already applied — skipping.');
  process.exit(0);
}

if (!html.includes(ANCHOR)) {
  console.error('ERROR: </body> not found in index.html');
  process.exit(1);
}

const navScript = `${MARKER}
  <script>
    /* ── Keyword Update nav item injection ────────────────────────────────
       Waits for the "Indexing Status" sidebar link (itself injected by the
       indexing-nav patch) then clones it to create a "Keyword Update"
       sibling that opens /keyword-update in a new tab.
       Uses MutationObserver so it survives React's async renders.
    ──────────────────────────────────────────────────────────────────── */
    (function () {
      var NAV_ID    = '_dt-kwu-nav';
      var CHECK_INT = null;
      var OBSERVER  = null;

      /* Pencil / edit icon (keyword-editing theme) */
      var KWU_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" ' +
        'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 20h9"/>' +
        '<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>' +
        '</svg>';

      function findIndexingNav() {
        /* First try the known injected id */
        var byId = document.getElementById('_dt-idx-nav');
        if (byId) return byId;

        /* Fallback: scan for element whose visible text is exactly "Indexing Status" */
        var candidates = document.querySelectorAll('a, li, button, div[role="button"]');
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          var text = '';
          el.childNodes.forEach(function (n) {
            if (n.nodeType === 3) text += n.textContent;
            if (n.nodeType === 1 && n.tagName !== 'SVG' && n.tagName !== 'svg') {
              text += n.textContent;
            }
          });
          if (text.trim() === 'Indexing Status') return el;
        }
        return null;
      }

      function inject() {
        if (document.getElementById(NAV_ID)) return; // already injected

        var idxNav = findIndexingNav();
        if (!idxNav) return; // Indexing Status nav not rendered yet — wait

        /* Clone the Indexing Status element to inherit all styles/classes exactly */
        var kwu = idxNav.cloneNode(true);
        kwu.id = NAV_ID;
        kwu.style.display = 'flex'; // Indexing Status nav is hidden with display:none (inherited by this clone) — restore the flex layout so icon/label sit inline like every sibling nav item

        /* Replace SVG with the keyword-update icon */
        var existingSvg = kwu.querySelector('svg');
        if (existingSvg) {
          var svgWrap = document.createElement('span');
          svgWrap.innerHTML = KWU_SVG;
          existingSvg.parentNode.replaceChild(svgWrap.firstChild, existingSvg);
        }

        /* Replace text nodes */
        var textNodes = [];
        (function findText(node) {
          node.childNodes.forEach(function (n) {
            if (n.nodeType === 3 && n.textContent.trim()) {
              textNodes.push(n);
            } else if (n.nodeType === 1 && n.tagName.toLowerCase() !== 'svg') {
              findText(n);
            }
          });
        })(kwu);

        textNodes.forEach(function (n, i) {
          if (i === 0) n.textContent = 'Keyword/Indexing';
          else n.textContent = '';
        });

        /* Fix any inner spans that still hold "Indexing Status" text */
        kwu.querySelectorAll('span, p, div').forEach(function (span) {
          if (span.childNodes.length === 1 &&
              span.childNodes[0].nodeType === 3 &&
              span.childNodes[0].textContent.trim() === 'Indexing Status') {
            span.childNodes[0].textContent = 'Keyword/Indexing';
          }
        });

        /* Make it open /keyword-update in a new tab */
        if (kwu.tagName === 'A') {
          kwu.href   = '/keyword-update';
          kwu.target = '_blank';
          kwu.rel    = 'noopener';
          kwu.removeAttribute('data-active');
        } else {
          kwu.addEventListener('click', function (e) {
            e.preventDefault();
            window.open('/keyword-update', '_blank');
          });
        }

        /* Reset any active/selected state classes from the clone */
        kwu.classList.remove('active', 'selected', 'current');
        kwu.setAttribute('aria-current', 'false');

        /* Insert immediately after Indexing Status */
        if (idxNav.parentNode) {
          idxNav.parentNode.insertBefore(kwu, idxNav.nextSibling);
          console.log('[dt-keyword-update-nav] Keyword Update nav item injected after Indexing Status.');
          cleanup();
        }
      }

      function cleanup() {
        if (CHECK_INT) { clearInterval(CHECK_INT); CHECK_INT = null; }
        if (OBSERVER)  { OBSERVER.disconnect();     OBSERVER  = null; }
      }

      function start() {
        inject(); // immediate attempt
        if (document.getElementById(NAV_ID)) return;

        OBSERVER = new MutationObserver(function () {
          if (!document.getElementById(NAV_ID)) inject();
        });
        OBSERVER.observe(document.body, { childList: true, subtree: true });

        CHECK_INT = setInterval(function () {
          if (!document.getElementById(NAV_ID)) inject();
          else cleanup();
        }, 800);

        /* Give up after 30s */
        setTimeout(cleanup, 30000);
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
      } else {
        start();
      }
    })();
  </script>
`;

// Insert before </body>
html = html.replace(ANCHOR, navScript + ANCHOR);
fs.writeFileSync(HTML_PATH, html, 'utf8');

const lineCount = html.split('\n').length;
console.log('[patch-add-keyword-update-nav] Patch applied successfully. Total lines:', lineCount);
