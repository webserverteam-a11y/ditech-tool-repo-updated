/**
 * scripts/patch-add-client-reports-nav.js
 *
 * Injects a "Client Reports" nav item after "Keyword/Indexing" in the sidebar.
 * Strategy: append a <script> block to dist/index.html that uses
 * MutationObserver to find the "Keyword/Indexing" sidebar link at runtime
 * (itself injected by the keyword-update-nav patch), clones it for identical
 * styling, and inserts a sibling that opens /client-reports in a new tab.
 *
 * Idempotent: detects the _dt-cr-nav-injected marker and exits cleanly.
 * Safe: only ADDS a new element — never modifies or removes existing nodes.
 *
 * Usage:
 *   node scripts/patch-add-client-reports-nav.js
 *
 * Wired into postinstall in package.json for auto-deploy.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'dist', 'index.html');

const MARKER = '<!-- _dt-cr-nav-injected -->';
const ANCHOR = '</body>';

if (!fs.existsSync(HTML_PATH)) {
  console.error('ERROR: dist/index.html not found');
  process.exit(1);
}

let html = fs.readFileSync(HTML_PATH, 'utf8');

// Idempotency check
if (html.includes(MARKER)) {
  console.log('[patch-add-client-reports-nav] Already applied — skipping.');
  process.exit(0);
}

if (!html.includes(ANCHOR)) {
  console.error('ERROR: </body> not found in index.html');
  process.exit(1);
}

const navScript = `${MARKER}
  <script>
    /* ── Client Reports nav item injection ────────────────────────────────
       Waits for the "Keyword/Indexing" sidebar link (itself injected by the
       keyword-update-nav patch) then clones it to create a "Client Reports"
       sibling that opens /client-reports in a new tab.
       Uses MutationObserver so it survives React's async renders.
    ──────────────────────────────────────────────────────────────────── */
    (function () {
      var NAV_ID    = '_dt-cr-nav';
      var CHECK_INT = null;
      var OBSERVER  = null;
      var LABELS_TO_TRY = ['Keyword/Indexing', 'Unified Timesheet', 'Reports'];

      /* Bar-chart / report icon (client performance reporting theme) */
      var CR_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" ' +
        'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>' +
        '</svg>';

      function findSourceNav() {
        /* First try the known injected id */
        var byId = document.getElementById('_dt-kwu-nav');
        if (byId) return byId;

        /* Fallback: scan for element whose visible text matches a known sibling label */
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

        /* Clone the source element to inherit all styles/classes exactly */
        var cr = srcNav.cloneNode(true);
        cr.id = NAV_ID;
        cr.style.display = srcNav.style.display === 'none' ? 'flex' : srcNav.style.display;

        /* Replace SVG with the client-reports icon */
        var existingSvg = cr.querySelector('svg');
        if (existingSvg) {
          var svgWrap = document.createElement('span');
          svgWrap.innerHTML = CR_SVG;
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
        })(cr);

        textNodes.forEach(function (n, i) {
          if (i === 0) n.textContent = 'Client Reports';
          else n.textContent = '';
        });

        /* Fix any inner spans that still hold the source label text */
        cr.querySelectorAll('span, p, div').forEach(function (span) {
          if (span.childNodes.length === 1 &&
              span.childNodes[0].nodeType === 3 &&
              span.childNodes[0].textContent.trim() &&
              span.childNodes[0].textContent.trim() !== 'Client Reports') {
            span.childNodes[0].textContent = 'Client Reports';
          }
        });

        /* Make it open /client-reports in a new tab */
        if (cr.tagName === 'A') {
          cr.href   = '/client-reports';
          cr.target = '_blank';
          cr.rel    = 'noopener';
          cr.removeAttribute('data-active');
        } else {
          cr.addEventListener('click', function (e) {
            e.preventDefault();
            window.open('/client-reports', '_blank');
          });
        }

        /* Reset any active/selected state classes from the clone */
        cr.classList.remove('active', 'selected', 'current');
        cr.setAttribute('aria-current', 'false');

        /* Insert immediately after the source nav item (i.e. below Keyword/Indexing) */
        if (srcNav.parentNode) {
          srcNav.parentNode.insertBefore(cr, srcNav.nextSibling);
          console.log('[dt-client-reports-nav] Client Reports nav item injected.');
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
console.log('[patch-add-client-reports-nav] Patch applied successfully. Total lines:', lineCount);
