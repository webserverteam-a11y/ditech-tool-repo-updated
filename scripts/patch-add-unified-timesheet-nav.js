/**
 * scripts/patch-add-unified-timesheet-nav.js
 *
 * Injects a "Unified Timesheet" nav item into the sidebar.
 * Strategy: append a <script> block to dist/index.html that uses
 * MutationObserver to find the existing "Timesheet" sidebar link at runtime,
 * clones it for identical styling, and inserts a sibling that opens
 * /unified-timesheet in a new tab.
 *
 * Idempotent: detects the _dt-uts-nav-injected marker and exits cleanly.
 * Safe: only ADDS a new element — never modifies or removes existing nodes.
 *
 * Usage:
 *   node scripts/patch-add-unified-timesheet-nav.js
 *
 * Wired into postinstall in package.json for auto-deploy.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'dist', 'index.html');

const MARKER = '<!-- _dt-uts-nav-injected -->';
const ANCHOR = '</body>';

if (!fs.existsSync(HTML_PATH)) {
  console.error('ERROR: dist/index.html not found');
  process.exit(1);
}

let html = fs.readFileSync(HTML_PATH, 'utf8');

// Idempotency check
if (html.includes(MARKER)) {
  console.log('[patch-add-unified-timesheet-nav] Already applied — skipping.');
  process.exit(0);
}

if (!html.includes(ANCHOR)) {
  console.error('ERROR: </body> not found in index.html');
  process.exit(1);
}

const navScript = `${MARKER}
  <script>
    /* ── Unified Timesheet nav item injection ─────────────────────────────
       Waits for the "Timesheet" sidebar link (rendered by the React bundle)
       then clones it to create a "Unified Timesheet" sibling that opens
       /unified-timesheet in a new tab. Falls back to cloning any nav item
       whose text matches a known sibling label if "Timesheet" isn't found.
       Uses MutationObserver so it survives React's async renders.
    ──────────────────────────────────────────────────────────────────── */
    (function () {
      var NAV_ID    = '_dt-uts-nav';
      var CHECK_INT = null;
      var OBSERVER  = null;
      var LABELS_TO_TRY = ['Timesheet', 'Indexing Status', 'Reports'];

      /* Clock/table icon (timesheet theme) */
      var UTS_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" ' +
        'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="3" y="4" width="18" height="17" rx="2"/>' +
        '<path d="M8 2v4M16 2v4M3 10h18"/>' +
        '</svg>';

      function findSourceNav() {
        var byId = document.getElementById('_dt-idx-nav') || document.getElementById('_dt-kwu-nav');
        if (byId) return byId;

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
        var uts = srcNav.cloneNode(true);
        uts.id = NAV_ID;
        uts.style.display = srcNav.style.display === 'none' ? 'flex' : srcNav.style.display;

        /* Replace SVG with the timesheet icon */
        var existingSvg = uts.querySelector('svg');
        if (existingSvg) {
          var svgWrap = document.createElement('span');
          svgWrap.innerHTML = UTS_SVG;
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
        })(uts);

        textNodes.forEach(function (n, i) {
          if (i === 0) n.textContent = 'Unified Timesheet';
          else n.textContent = '';
        });

        uts.querySelectorAll('span, p, div').forEach(function (span) {
          if (span.childNodes.length === 1 &&
              span.childNodes[0].nodeType === 3 &&
              span.childNodes[0].textContent.trim() &&
              span.childNodes[0].textContent.trim() !== 'Unified Timesheet') {
            span.childNodes[0].textContent = 'Unified Timesheet';
          }
        });

        /* Make it open /unified-timesheet in a new tab */
        if (uts.tagName === 'A') {
          uts.href   = '/unified-timesheet';
          uts.target = '_blank';
          uts.rel    = 'noopener';
          uts.removeAttribute('data-active');
        } else {
          uts.addEventListener('click', function (e) {
            e.preventDefault();
            window.open('/unified-timesheet', '_blank');
          });
        }

        uts.classList.remove('active', 'selected', 'current');
        uts.setAttribute('aria-current', 'false');

        if (srcNav.parentNode) {
          srcNav.parentNode.insertBefore(uts, srcNav.nextSibling);
          console.log('[dt-unified-timesheet-nav] Unified Timesheet nav item injected.');
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
console.log('[patch-add-unified-timesheet-nav] Patch applied successfully. Total lines:', lineCount);
