/**
 * scripts/patch-add-alt-action-board-nav.js
 *
 * Injects an "Action Board 2.0" nav item into the sidebar, right after the
 * existing "Action Board" link.
 *
 * Strategy: append a <script> block to dist/index.html (same technique as
 * patch-add-unified-timesheet-nav.js / patch-add-client-reports-nav.js) that
 * uses MutationObserver to find the existing "Action Board" sidebar link at
 * runtime, clones it for identical styling, and inserts a sibling that opens
 * /alt-action-board in a new tab.
 *
 * This never touches dist/assets/*.js (the compiled bundle) — only appends
 * to dist/index.html, and only ever ADDS a DOM node at runtime. The existing
 * Action Board link, its click handler, and its behavior are untouched.
 *
 * Idempotent: detects the _dt-aab-nav-injected marker and exits cleanly.
 *
 * Usage:
 *   node scripts/patch-add-alt-action-board-nav.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'dist', 'index.html');

const MARKER = '<!-- _dt-aab-nav-injected -->';
const ANCHOR = '</body>';

if (!fs.existsSync(HTML_PATH)) {
  console.error('ERROR: dist/index.html not found');
  process.exit(1);
}

let html = fs.readFileSync(HTML_PATH, 'utf8');

if (html.includes(MARKER)) {
  console.log('[patch-add-alt-action-board-nav] Already applied — skipping.');
  process.exit(0);
}

if (!html.includes(ANCHOR)) {
  console.error('ERROR: </body> not found in index.html');
  process.exit(1);
}

const navScript = `${MARKER}
  <script>
    /* ── Action Board 2.0 nav item injection ───────────────────────────────
       Waits for the "Action Board" sidebar link (rendered by the React
       bundle) then clones it to create an "Action Board 2.0" sibling that
       opens /alt-action-board in a new tab. Uses MutationObserver so it
       survives React's async renders.
    ──────────────────────────────────────────────────────────────────── */
    (function () {
      var NAV_ID    = '_dt-aab-nav';
      var CHECK_INT = null;
      var OBSERVER  = null;
      var LABELS_TO_TRY = ['Action Board', 'Work Hub', 'Task Entry'];

      /* Layout-grid icon (matches the alt-action-board.html header mark) */
      var AAB_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" ' +
        'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="3" y="3" width="7" height="9" rx="1.5"/>' +
        '<rect x="14" y="3" width="7" height="5" rx="1.5"/>' +
        '<rect x="14" y="12" width="7" height="9" rx="1.5"/>' +
        '<rect x="3" y="16" width="7" height="5" rx="1.5"/>' +
        '</svg>';

      function findSourceNav() {
        var candidates = document.querySelectorAll('a, li, button, div[role="button"]');
        for (var li = 0; li < LABELS_TO_TRY.length; li++) {
          var label = LABELS_TO_TRY[li];
          for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var text = '';
            el.childNodes.forEach(function (n) {
              if (n.nodeType === 3) text += n.textContent;
              if (n.nodeType === 1 && n.tagName !== 'SVG' && n.tagName !== 'svg') {
                text += n.textContent;
              }
            });
            if (text.trim() === label) return el;
          }
        }
        return null;
      }

      function inject() {
        if (document.getElementById(NAV_ID)) return; // already injected

        var srcNav = findSourceNav();
        if (!srcNav) return; // sidebar not rendered yet — wait

        /* Clone to inherit all styles/classes exactly */
        var aab = srcNav.cloneNode(true);
        aab.id = NAV_ID;
        aab.style.display = srcNav.style.display === 'none' ? 'flex' : srcNav.style.display;

        /* Replace SVG with the Action Board 2.0 icon */
        var existingSvg = aab.querySelector('svg');
        if (existingSvg) {
          var svgWrap = document.createElement('span');
          svgWrap.innerHTML = AAB_SVG;
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
        })(aab);

        textNodes.forEach(function (n, i) {
          if (i === 0) n.textContent = 'Action Board 2.0';
          else n.textContent = '';
        });

        aab.querySelectorAll('span, p, div').forEach(function (span) {
          if (span.childNodes.length === 1 &&
              span.childNodes[0].nodeType === 3 &&
              span.childNodes[0].textContent.trim() &&
              span.childNodes[0].textContent.trim() !== 'Action Board 2.0') {
            span.childNodes[0].textContent = 'Action Board 2.0';
          }
        });

        /* Make it open /alt-action-board in a new tab */
        if (aab.tagName === 'A') {
          aab.href   = '/alt-action-board';
          aab.target = '_blank';
          aab.rel    = 'noopener';
          aab.removeAttribute('data-active');
        } else {
          aab.addEventListener('click', function (e) {
            e.preventDefault();
            window.open('/alt-action-board', '_blank');
          });
        }

        aab.classList.remove('active', 'selected', 'current');
        aab.setAttribute('aria-current', 'false');

        if (srcNav.parentNode) {
          srcNav.parentNode.insertBefore(aab, srcNav.nextSibling);
          console.log('[dt-alt-action-board-nav] Action Board 2.0 nav item injected.');
          cleanup();
        }
      }

      function cleanup() {
        if (CHECK_INT) { clearInterval(CHECK_INT); CHECK_INT = null; }
        if (OBSERVER)  { OBSERVER.disconnect();     OBSERVER  = null; }
      }

      function start() {
        inject();
        if (document.getElementById(NAV_ID)) return;

        OBSERVER = new MutationObserver(function () {
          if (!document.getElementById(NAV_ID)) inject();
        });
        OBSERVER.observe(document.body, { childList: true, subtree: true });

        CHECK_INT = setInterval(function () {
          if (!document.getElementById(NAV_ID)) inject();
          else cleanup();
        }, 800);

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
console.log('[patch-add-alt-action-board-nav] Patch applied successfully. Total lines:', lineCount);
