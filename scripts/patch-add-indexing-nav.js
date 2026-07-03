/**
 * scripts/patch-add-indexing-nav.js
 *
 * Injects an "Indexing Status" nav item after "Reports" in the sidebar.
 * Strategy: append a <script> block to dist/index.html that uses
 * MutationObserver to find the Reports nav link at runtime (which is
 * itself dynamically injected), clones it for identical styling, and
 * inserts a sibling that opens /indexing-status in a new tab.
 *
 * Idempotent: detects the _dt-idx-nav-injected marker and exits cleanly.
 * Safe: only ADDS a new element — never modifies or removes existing nodes.
 *
 * Usage:
 *   node scripts/patch-add-indexing-nav.js
 *
 * Wired into postinstall in package.json for auto-deploy.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'dist', 'index.html');

const MARKER = '<!-- _dt-idx-nav-injected -->';
const ANCHOR = '</body>';

if (!fs.existsSync(HTML_PATH)) {
  console.error('ERROR: dist/index.html not found');
  process.exit(1);
}

let html = fs.readFileSync(HTML_PATH, 'utf8');

// Idempotency check
if (html.includes(MARKER)) {
  console.log('[patch-add-indexing-nav] Already applied — skipping.');
  process.exit(0);
}

if (!html.includes(ANCHOR)) {
  console.error('ERROR: </body> not found in index.html');
  process.exit(1);
}

const navScript = `${MARKER}
  <script>
    /* ── Indexing Status nav item injection ──────────────────────────────
       Waits for the "Reports" sidebar link (itself injected by the
       reports-nav patch) then clones it to create an "Indexing Status"
       sibling that opens /indexing-status in a new tab.
       Uses MutationObserver so it survives React's async renders.
    ──────────────────────────────────────────────────────────────────── */
    (function () {
      var NAV_ID    = '_dt-idx-nav';
      var CHECK_INT = null;
      var OBSERVER  = null;

      /* Magnifying glass icon (search/index theme) */
      var IDX_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" ' +
        'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="11" cy="11" r="8"/>' +
        '<line x1="21" y1="21" x2="16.65" y2="16.65"/>' +
        '</svg>';

      function findReportsNav() {
        /* First try the known injected id */
        var byId = document.getElementById('_dt-rep-nav');
        if (byId) return byId;

        /* Fallback: scan for element whose visible text is exactly "Reports" */
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
          if (text.trim() === 'Reports') return el;
        }
        return null;
      }

      function inject() {
        if (document.getElementById(NAV_ID)) return; // already injected

        var rep = findReportsNav();
        if (!rep) return; // Reports nav not rendered yet — wait

        /* Clone the Reports element to inherit all styles/classes exactly */
        var idx = rep.cloneNode(true);
        idx.id = NAV_ID;

        /* Replace SVG with the indexing icon */
        var existingSvg = idx.querySelector('svg');
        if (existingSvg) {
          var svgWrap = document.createElement('span');
          svgWrap.innerHTML = IDX_SVG;
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
        })(idx);

        textNodes.forEach(function (n, i) {
          if (i === 0) n.textContent = 'Indexing Status';
          else n.textContent = '';
        });

        /* Fix any inner spans that still hold "Reports" text */
        idx.querySelectorAll('span, p, div').forEach(function (span) {
          if (span.childNodes.length === 1 &&
              span.childNodes[0].nodeType === 3 &&
              span.childNodes[0].textContent.trim() === 'Reports') {
            span.childNodes[0].textContent = 'Indexing Status';
          }
        });

        /* Make it open /indexing-status in a new tab */
        if (idx.tagName === 'A') {
          idx.href   = '/indexing-status';
          idx.target = '_blank';
          idx.rel    = 'noopener';
          idx.removeAttribute('data-active');
        } else {
          idx.addEventListener('click', function (e) {
            e.preventDefault();
            window.open('/indexing-status', '_blank');
          });
        }

        /* Reset any active/selected state classes from the clone */
        idx.classList.remove('active', 'selected', 'current');
        idx.setAttribute('aria-current', 'false');

        /* Hidden: the Indexing Status panel is superseded by the Keyword
           Update panel's built-in Index Status column, so this nav item is
           no longer surfaced. It's kept in the DOM (rather than skipped)
           because the Keyword Update nav patch clones it for identical
           styling — see patch-add-keyword-update-nav.js. */
        idx.style.display = 'none';

        /* Insert immediately after Reports */
        if (rep.parentNode) {
          rep.parentNode.insertBefore(idx, rep.nextSibling);
          console.log('[dt-indexing-nav] Indexing Status nav item injected after Reports.');
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
console.log('[patch-add-indexing-nav] Patch applied successfully. Total lines:', lineCount);
