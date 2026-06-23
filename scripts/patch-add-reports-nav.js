/**
 * scripts/patch-add-reports-nav.js
 *
 * Injects a "Reports" nav item after "Work Hub" in the sidebar.
 * Strategy: append a <script> block to dist/index.html that uses
 * MutationObserver to find the Work Hub nav link at runtime, clones
 * it for identical styling, and inserts a sibling that opens the
 * standalone scorecard page (/seo-report) in a new tab.
 *
 * Idempotent: detects the _dt-rep-nav-injected marker and exits cleanly.
 * Safe: only ADDS a new element — never modifies or removes existing nodes.
 *
 * Usage:
 *   node scripts/patch-add-reports-nav.js
 *
 * Wired into postinstall in package.json for auto-deploy.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'dist', 'index.html');

const MARKER    = '<!-- _dt-rep-nav-injected -->';
const ANCHOR    = '</body>';

if (!fs.existsSync(HTML_PATH)) {
  console.error('ERROR: dist/index.html not found');
  process.exit(1);
}

let html = fs.readFileSync(HTML_PATH, 'utf8');

// Idempotency check
if (html.includes(MARKER)) {
  console.log('[patch-add-reports-nav] Already applied — skipping.');
  process.exit(0);
}

if (!html.includes(ANCHOR)) {
  console.error('ERROR: </body> not found in index.html');
  process.exit(1);
}

const navScript = `${MARKER}
  <script>
    /* ── Reports nav item injection ─────────────────────────────────────
       Clones the "Work Hub" sidebar link, replaces its icon/label with a
       bar-chart icon + "Reports", then inserts it as the next sibling.
       Uses MutationObserver so it survives React's async renders.
       Opens /seo-report in a new tab — React app state is unaffected.
    ──────────────────────────────────────────────────────────────────── */
    (function () {
      var NAV_ID     = '_dt-rep-nav';
      var CHECK_INT  = null;
      var OBSERVER   = null;

      /* Bar chart icon SVG (matching sidebar icon size) */
      var CHART_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" ' +
        'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<line x1="18" y1="20" x2="18" y2="10"/>' +
        '<line x1="12" y1="20" x2="12" y2="4"/>' +
        '<line x1="6"  y1="20" x2="6"  y2="14"/>' +
        '</svg>';

      function findWorkHub() {
        /* Walk every <a> and <li> looking for one whose direct text
           contains "Work Hub". We avoid textContent (which includes
           children) to not false-match parent wrappers. */
        var candidates = document.querySelectorAll('a, li, button, div[role="button"]');
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          /* Check only leaf-ish text: get text nodes directly inside */
          var text = '';
          el.childNodes.forEach(function (n) {
            if (n.nodeType === 3) text += n.textContent; // TEXT_NODE
            if (n.nodeType === 1 && n.tagName !== 'SVG' && n.tagName !== 'svg') {
              text += n.textContent;
            }
          });
          if (text.trim() === 'Work Hub') return el;
        }
        return null;
      }

      function inject() {
        if (document.getElementById(NAV_ID)) return; // already injected

        var wh = findWorkHub();
        if (!wh) return; // not rendered yet

        /* Clone the Work Hub element to inherit all styles/classes exactly */
        var rep = wh.cloneNode(true);
        rep.id  = NAV_ID;

        /* Replace SVG with the chart icon */
        var existingSvg = rep.querySelector('svg');
        if (existingSvg) {
          var svgWrap = document.createElement('span');
          svgWrap.innerHTML = CHART_SVG;
          existingSvg.parentNode.replaceChild(svgWrap.firstChild, existingSvg);
        }

        /* Replace text nodes — find span/div holding the label text */
        var textNodes = [];
        (function findText(node) {
          node.childNodes.forEach(function (n) {
            if (n.nodeType === 3 && n.textContent.trim()) {
              textNodes.push(n);
            } else if (n.nodeType === 1 && n.tagName.toLowerCase() !== 'svg') {
              findText(n);
            }
          });
        })(rep);

        textNodes.forEach(function (n, idx) {
          if (idx === 0) n.textContent = 'Reports';
          else n.textContent = '';
        });

        /* Also fix any inner spans that might hold "Work Hub" text */
        rep.querySelectorAll('span, p, div').forEach(function (span) {
          if (span.childNodes.length === 1 &&
              span.childNodes[0].nodeType === 3 &&
              span.childNodes[0].textContent.trim() === 'Work Hub') {
            span.childNodes[0].textContent = 'Reports';
          }
        });

        /* Make it open /seo-report in a new tab */
        if (rep.tagName === 'A') {
          rep.href   = '/seo-report';
          rep.target = '_blank';
          rep.rel    = 'noopener';
          rep.removeAttribute('data-active');
        } else {
          /* Wrap in an anchor if it's not already one */
          var a = document.createElement('a');
          a.href   = '/seo-report';
          a.target = '_blank';
          a.rel    = 'noopener';
          a.style.cssText = 'text-decoration:none;display:contents;';
          rep.addEventListener('click', function (e) {
            e.preventDefault();
            window.open('/seo-report', '_blank');
          });
        }

        /* Reset any active/selected state classes from the clone */
        rep.classList.remove('active', 'selected', 'current');
        rep.setAttribute('aria-current', 'false');

        /* Insert immediately after Work Hub */
        if (wh.parentNode) {
          wh.parentNode.insertBefore(rep, wh.nextSibling);
          console.log('[dt-reports-nav] Reports nav item injected after Work Hub.');
          cleanup();
        }
      }

      function cleanup() {
        if (CHECK_INT)  { clearInterval(CHECK_INT);  CHECK_INT  = null; }
        if (OBSERVER)   { OBSERVER.disconnect();      OBSERVER   = null; }
      }

      /* Start: poll + observe until injected */
      function start() {
        inject(); // immediate attempt
        if (document.getElementById(NAV_ID)) return;

        OBSERVER = new MutationObserver(function () {
          if (!document.getElementById(NAV_ID)) inject();
        });
        OBSERVER.observe(document.body, { childList: true, subtree: true });

        /* Fallback interval in case MutationObserver misses the mount */
        CHECK_INT = setInterval(function () {
          if (!document.getElementById(NAV_ID)) inject();
          else cleanup();
        }, 800);

        /* Give up after 30s to avoid running forever */
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
console.log('[patch-add-reports-nav] Patch applied successfully. Total lines:', lineCount);
