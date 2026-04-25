// Patch: Replace Action Board Not Started / Paused capsules script
// with positioned + click-to-filter version
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, '..', 'dist', 'index.html');

let html = readFileSync(htmlPath, 'utf8');

// Find the capsule section marker
const MARKER = '<!-- \u2500\u2500 Action Board: Not Started & Paused summary capsules';
const idx = html.indexOf(MARKER);
if (idx === -1) { console.error('MARKER NOT FOUND'); process.exit(1); }

// Everything before the marker
const before = html.slice(0, idx);

// New replacement block
const newBlock = `<!-- \u2500\u2500 Action Board: Not Started & Paused summary capsules \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
  <style id="_dt-filter-css"></style>
  <script>
    (function () {
      var _dtCachedTasks = [];
      var _dtActiveFilter = null; // 'Not Started' | 'Paused' | null
      var _dtSummaryTimer = null;
      var _dtTagTimer = null;

      /* \u2500\u2500 1. Cache tasks whenever React fetches /api/tasks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
      var _prevFetchCap = window.fetch.bind(window);
      window.fetch = function (input, init) {
        var url  = typeof input === 'string' ? input : (input && input.url) || '';
        var meth = ((init && init.method) || 'GET').toUpperCase();
        var promise = _prevFetchCap.apply(this, arguments);
        if (meth === 'GET' && /^\\/api\\/tasks(\\?.*)?$/.test(url)) {
          return promise.then(function (resp) {
            resp.clone().json().then(function (data) {
              if (Array.isArray(data)) {
                _dtCachedTasks = data;
                scheduleRefresh();
                if (_dtActiveFilter) {
                  clearTimeout(_dtTagTimer);
                  _dtTagTimer = setTimeout(tagAndApply, 200);
                }
              }
            }).catch(function () {});
            return resp;
          });
        }
        return promise;
      };

      /* \u2500\u2500 2. CSS injection for hiding non-matching cards \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
      var filterCSS = document.getElementById('_dt-filter-css');
      function setFilterCSS(state) {
        if (!state) { filterCSS.textContent = ''; return; }
        filterCSS.textContent =
          '[data-dt-card]:not([data-dt-flt="' + state + '"]) { display: none !important; }';
      }

      /* \u2500\u2500 3. Tag visible task cards in DOM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
      // A task card uniquely contains "Start Task", "Resume", or "End Task" buttons.
      // Walk up from the TASK-ID badge to the first ancestor with one of those buttons.
      var STATUS_WORDS = ['Not Started','Paused','In Progress','QC Pending',
                          'Completed','Rework','Delayed','In Review','QC Submitted'];

      function tagVisibleCards() {
        var candidates = document.querySelectorAll('span, div');
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          if (el.children.length > 0) continue; // text-only nodes
          var txt = el.textContent.trim();
          if (!/^[A-Z]+-\\d+/.test(txt)) continue;

          // Walk up to find the card wrapper containing an action button
          var card = el.parentElement;
          while (card && card !== document.body) {
            var hasBtn = false;
            var btns = card.querySelectorAll('button');
            for (var b = 0; b < btns.length; b++) {
              var bt = btns[b].textContent.trim();
              if (bt === 'Start Task' || bt === 'Resume' || bt === 'End Task') {
                hasBtn = true; break;
              }
            }
            if (hasBtn) break;
            card = card.parentElement;
          }
          if (!card || card === document.body) continue;

          // Get status from the card's status badge span
          var spans = card.querySelectorAll('span');
          var status = null;
          for (var s = 0; s < spans.length; s++) {
            var st = spans[s].textContent.trim();
            if (STATUS_WORDS.indexOf(st) !== -1) { status = st; break; }
          }
          if (!status) continue;

          card.setAttribute('data-dt-card', txt);
          card.setAttribute('data-dt-flt', status);
        }
      }

      function tagAndApply() {
        tagVisibleCards();
        setFilterCSS(_dtActiveFilter);
      }

      /* \u2500\u2500 4. Find the smallest summary bar container \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
      function findSummaryContainer() {
        var els = document.querySelectorAll('div, ul, section, nav');
        var best = null, bestLen = Infinity;
        for (var i = 0; i < els.length; i++) {
          var t = els[i].textContent || '';
          if (t.indexOf('In Progress') !== -1 && t.indexOf('QC Pending') !== -1 &&
              t.indexOf('Completed')   !== -1 && t.indexOf('Rework')     !== -1 &&
              t.indexOf('Total')       !== -1) {
            var len = t.length;
            if (len < bestLen && len < 600) { best = els[i]; bestLen = len; }
          }
        }
        return best;
      }

      /* \u2500\u2500 5. Read Action Board date inputs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
      function getDateRange() {
        var inputs = document.querySelectorAll('input[type="date"]');
        if (inputs.length < 2) return null;
        var from = inputs[0].value, to = inputs[1].value;
        return (from && to) ? { from: from, to: to } : null;
      }

      /* \u2500\u2500 6. Count Not Started / Paused in visible date range \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
      function filteredCounts() {
        var range = getDateRange();
        var tasks = _dtCachedTasks;
        if (range && tasks.length > 0) {
          tasks = tasks.filter(function (t) {
            var d = (t.intakeDate || '').slice(0, 10);
            return d >= range.from && d <= range.to;
          });
        }
        var ns = 0, pa = 0;
        tasks.forEach(function (t) {
          var s = (t.executionState || '').trim();
          if (s === 'Not Started') ns++;
          else if (s === 'Paused') pa++;
        });
        return { notStarted: ns, paused: pa };
      }

      /* \u2500\u2500 7. Inject capsules right after "Completed N" button \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
      function refreshCapsules() {
        var container = findSummaryContainer();
        if (!container) {
          _dtActiveFilter = null;
          setFilterCSS(null);
          var w = document.getElementById('_dt-cap-wrap');
          if (w) w.style.display = 'none';
          return;
        }

        // Find the "Completed N" button inside the summary bar
        var completedBtn = null;
        var allBtns = container.querySelectorAll('button');
        for (var i = 0; i < allBtns.length; i++) {
          if (/^Completed/.test(allBtns[i].textContent.trim())) {
            completedBtn = allBtns[i]; break;
          }
        }
        if (!completedBtn) return;

        var counts = filteredCounts();
        var nsActive = _dtActiveFilter === 'Not Started';
        var paActive = _dtActiveFilter === 'Paused';

        var cap = 'border-radius:999px;padding:3px 12px;font-size:13px;font-weight:600;' +
                  'cursor:pointer;white-space:nowrap;line-height:1.5;border-width:1.5px;border-style:solid;transition:opacity 0.15s;';

        var wrap = document.getElementById('_dt-cap-wrap');
        if (!wrap) {
          wrap = document.createElement('span');
          wrap.id = '_dt-cap-wrap';
          wrap.style.cssText = 'display:inline-flex;gap:6px;align-items:center;flex-shrink:0;margin-left:4px;';
        }
        wrap.style.display = 'inline-flex';
        wrap.innerHTML =
          '<button id="_dt-cap-ns" type="button" style="' + cap +
            'background:#6b7280;color:#fff;border-color:#6b7280;' +
            (nsActive ? 'outline:3px solid #374151;outline-offset:2px;' : paActive ? 'opacity:0.5;' : '') + '">' +
            'Not Started ' + counts.notStarted +
          '</button>' +
          '<button id="_dt-cap-pa" type="button" style="' + cap +
            'background:#f59e0b;color:#fff;border-color:#d97706;' +
            (paActive ? 'outline:3px solid #92400e;outline-offset:2px;' : nsActive ? 'opacity:0.5;' : '') + '">' +
            'Paused ' + counts.paused +
          '</button>';

        document.getElementById('_dt-cap-ns').onclick = function () {
          _dtActiveFilter = (_dtActiveFilter === 'Not Started') ? null : 'Not Started';
          tagAndApply();
          refreshCapsules();
        };
        document.getElementById('_dt-cap-pa').onclick = function () {
          _dtActiveFilter = (_dtActiveFilter === 'Paused') ? null : 'Paused';
          tagAndApply();
          refreshCapsules();
        };

        // Insert as direct sibling of completedBtn, immediately after it
        var insertParent = completedBtn.parentNode;
        if (wrap.parentNode !== insertParent || wrap.previousElementSibling !== completedBtn) {
          insertParent.insertBefore(wrap, completedBtn.nextSibling);
        }
      }

      function scheduleRefresh() {
        clearTimeout(_dtSummaryTimer);
        _dtSummaryTimer = setTimeout(refreshCapsules, 300);
      }

      /* \u2500\u2500 8. DOM observer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
      new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          if (mutations[i].addedNodes.length > 0 || mutations[i].removedNodes.length > 0) {
            scheduleRefresh();
            if (_dtActiveFilter) {
              clearTimeout(_dtTagTimer);
              _dtTagTimer = setTimeout(tagAndApply, 150);
            }
            return;
          }
        }
      }).observe(document.body, { childList: true, subtree: true });

      // Clear OUR filter when a React summary capsule is clicked
      document.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.tagName === 'BUTTON' && t.id !== '_dt-cap-ns' && t.id !== '_dt-cap-pa') {
          var c = findSummaryContainer();
          if (c && c.contains(t)) { _dtActiveFilter = null; setFilterCSS(null); scheduleRefresh(); }
        }
      }, true);

      // Clear filter on date change
      document.addEventListener('change', function (e) {
        if (e.target && e.target.type === 'date') {
          _dtActiveFilter = null; setFilterCSS(null); scheduleRefresh();
        }
      }, true);

      setTimeout(function () {
        if (_dtCachedTasks.length === 0) fetch('/api/tasks').catch(function () {});
      }, 2500);
    })();
  </script>
</body>

</html>`;

const newHtml = before + '  ' + newBlock;
writeFileSync(htmlPath, newHtml, 'utf8');
console.log('Patch applied successfully. Lines:', newHtml.split('\n').length);
