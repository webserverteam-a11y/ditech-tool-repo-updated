/**
 * report.routes.js — SEO Client Scorecard report endpoint.
 *
 * GET /api/reports/seo-scorecard?client=X&month=YYYY-MM
 *   Returns summary stats + 7 grouped task sections derived from the
 *   tasks table. Pure read — no DB writes, no schema changes.
 *
 * GET /api/reports/seo-scorecard/months?client=X
 *   Returns distinct intake months available for a given client.
 *
 * GET /api/reports/seo-scorecard/clients
 *   Returns distinct client names that have tasks.
 *
 * Section classification (by focused_kw presence + rank movement):
 *   top10      — has keyword, current_rank 1-10
 *   dropped    — has keyword, current_rank > mar_rank, current_rank > 10
 *   improved   — has keyword, current_rank < mar_rank, current_rank > 10
 *   unranked   — has keyword, current_rank >= 100 AND mar_rank >= 100
 *   stable     — has keyword, current_rank == mar_rank (and not top10/unranked)
 *   other      — no keyword (Tech SEO, reports, strategy tasks)
 *   design     — task_type contains 'Design' or id starts with 'WH-'
 */

import { Router } from 'express';
import pool from '../config/db.js';

export const reportRouter = Router();

// ── GET /months?client=X ───────────────────────────────────────────────────
reportRouter.get('/months', async (req, res) => {
  const { client } = req.query;
  try {
    let query = `
      SELECT DISTINCT DATE_FORMAT(intake_date, '%Y-%m') AS month
      FROM tasks
      WHERE intake_date IS NOT NULL AND intake_date != ''
    `;
    const params = [];
    if (client && client !== 'all') {
      query += ' AND client = ?';
      params.push(client);
    }
    query += ' ORDER BY month DESC';
    const [rows] = await pool.query(query, params);
    res.json(rows.map(r => r.month).filter(Boolean));
  } catch (e) {
    console.error('GET /api/reports/seo-scorecard/months error:', e.message);
    res.status(500).json({ error: 'Failed to load months' });
  }
});

// ── GET /clients ───────────────────────────────────────────────────────────
reportRouter.get('/clients', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT client FROM tasks WHERE client IS NOT NULL AND client != '' ORDER BY client`
    );
    res.json(rows.map(r => r.client));
  } catch (e) {
    console.error('GET /api/reports/seo-scorecard/clients error:', e.message);
    res.status(500).json({ error: 'Failed to load clients' });
  }
});

// ── GET /owners?client=X&from=YYYY-MM-DD&to=YYYY-MM-DD ───────────────────
reportRouter.get('/owners', async (req, res) => {
  const { client, from, to } = req.query;
  if (!client) return res.status(400).json({ error: 'client param required' });
  try {
    const params = [client];
    let dateClause = '';
    if (from && to) {
      dateClause = 'AND intake_date >= ? AND intake_date <= ?';
      params.push(from, to);
    }
    const [rows] = await pool.query(
      `SELECT DISTINCT seo_owner FROM tasks
       WHERE client = ? AND seo_owner IS NOT NULL AND seo_owner != ''
       ${dateClause}
       ORDER BY seo_owner`,
      params
    );
    res.json(rows.map(r => r.seo_owner));
  } catch (e) {
    console.error('GET /api/reports/seo-scorecard/owners error:', e.message);
    res.status(500).json({ error: 'Failed to load owners' });
  }
});

// ── GET /?client=X&from=YYYY-MM-DD&to=YYYY-MM-DD[&owner=X] ───────────────
// Also accepts legacy &month=YYYY-MM for backward compat.
reportRouter.get('/', async (req, res) => {
  const { client, month, from, to, owner } = req.query;
  if (!client) return res.status(400).json({ error: 'client param required' });

  // Resolve date range: prefer explicit from/to, fall back to month prefix
  let dateClause, dateParams;
  if (from && to) {
    dateClause = 'AND intake_date >= ? AND intake_date <= ?';
    dateParams = [from, to];
  } else if (month) {
    dateClause = 'AND intake_date LIKE ?';
    dateParams = [`${month}%`];
  } else {
    return res.status(400).json({ error: 'from+to or month param required' });
  }

  try {
    // Fetch tasks for client + date range [+ optional owner filter]
    const params = [client, ...dateParams];
    let ownerClause = '';
    if (owner && owner !== 'all') {
      ownerClause = 'AND seo_owner = ?';
      params.push(owner);
    }

    const [rows] = await pool.query(
      `SELECT id, title, client, seo_owner, content_owner, focused_kw,
              volume, mar_rank, current_rank,
              est_hours, est_hours_seo, est_hours_content, est_hours_web,
              intake_date, execution_state, doc_url, target_url,
              task_type, dept_type, remarks, index_status, is_completed
       FROM tasks
       WHERE client = ?
         ${dateClause}
         ${ownerClause}
       ORDER BY intake_date DESC, id`,
      params
    );

    // ── Classify each task ────────────────────────────────────────────────
    const sections = {
      top10:    [],
      dropped:  [],
      improved: [],
      unranked: [],
      stable:   [],
      other:    [],
      design:   [],
    };

    const summaryHours = {
      onpage: 0, blogs: 0, content: 0, tech: 0,
      strategy: 0, reports: 0, design: 0, total: 0,
    };

    let kwTotal = 0, pos1to3 = 0, pos4to10 = 0, pos11plus = 0,
        kwUnranked = 0, improved = 0, dropped = 0, stable = 0,
        stillUnranked = 0;

    for (const r of rows) {
      const taskObj = mapTask(r);
      const type = (r.task_type || '').toLowerCase();
      const isDesign = type.includes('design') || String(r.id).startsWith('WH-');
      const hasKw = !!(r.focused_kw && r.focused_kw.trim());
      const was = Number(r.mar_rank)     || 0;
      const now = Number(r.current_rank) || 0;

      // Hours by type
      const hrs = Number(r.est_hours) || 0;
      summaryHours.total += hrs;
      if (isDesign)                         summaryHours.design   += hrs;
      else if (type.includes('blog'))       summaryHours.blogs    += hrs;
      else if (type.includes('tech'))       summaryHours.tech     += hrs;
      else if (type.includes('report'))     summaryHours.reports  += hrs;
      else if (type.includes('strat'))      summaryHours.strategy += hrs;
      else if (type.includes('on page') || type.includes('on_page') || type.includes('onpage'))
                                            summaryHours.onpage   += hrs;
      else if (!hasKw)                      summaryHours.tech     += hrs; // other no-kw tasks
      else                                  summaryHours.onpage   += hrs;

      // Keyword position stats
      if (hasKw && !isDesign) {
        kwTotal++;
        if (now >= 1 && now <= 3)         pos1to3++;
        else if (now >= 4 && now <= 10)   pos4to10++;
        else if (now >= 11 && now < 100)  pos11plus++;
        else if (now >= 100)              kwUnranked++;

        // Movement
        if (now > 0 && was > 0) {
          if (now < was)       improved++;
          else if (now > was)  dropped++;
          else                 stable++;
        }
        if (now >= 100 && was >= 100)    stillUnranked++;
      }

      // Section assignment
      if (isDesign) {
        sections.design.push(taskObj);
      } else if (!hasKw) {
        sections.other.push(taskObj);
      } else if (now >= 1 && now <= 10) {
        sections.top10.push(taskObj);
      } else if (now >= 100 && was >= 100) {
        sections.unranked.push(taskObj);
      } else if (now > was) {
        sections.dropped.push(taskObj);
      } else if (now < was) {
        sections.improved.push(taskObj);
      } else {
        sections.stable.push(taskObj);
      }
    }

    const pctImproved = kwTotal > 0
      ? Math.round((improved / kwTotal) * 1000) / 10
      : 0;

    res.json({
      client,
      month,
      summary: {
        totalTasks: rows.length,
        estHrs:     round2(summaryHours.total),
        hours: {
          onpage:   round2(summaryHours.onpage),
          blogs:    round2(summaryHours.blogs),
          content:  round2(summaryHours.content),
          tech:     round2(summaryHours.tech),
          strategy: round2(summaryHours.strategy),
          reports:  round2(summaryHours.reports),
          design:   round2(summaryHours.design),
        },
        keywords: {
          total:        kwTotal,
          pos1to3,
          pos4to10,
          pos11plus,
          unranked:     kwUnranked,
          improved,
          dropped,
          stable,
          stillUnranked,
          pctImproved,
        },
      },
      sections,
    });
  } catch (e) {
    console.error('GET /api/reports/seo-scorecard error:', e.message);
    res.status(500).json({ error: 'Failed to generate scorecard' });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────
function round2(n) { return Math.round(n * 100) / 100; }

function pctImpr(was, now) {
  if (!was || was === 0) return null;
  return Math.round(((was - now) / was) * 1000) / 10;
}

function movement(was, now, hasKw) {
  if (!hasKw) return null;
  if (now >= 100 && was >= 100) return 'Still unranked';
  if (now >= 1 && now <= 10)   return 'Top 10';
  if (now < was)               return 'Improved';
  if (now > was)               return 'Dropped';
  return 'Stable';
}

function mapTask(r) {
  const was = Number(r.mar_rank)     || 0;
  const now = Number(r.current_rank) || 0;
  const hasKw = !!(r.focused_kw && r.focused_kw.trim());
  const delta = hasKw ? (was - now) : null;
  const pct   = hasKw ? pctImpr(was, now) : null;
  return {
    id:           r.id,
    title:        r.title        || '',
    owner:        r.seo_owner    || '',
    contentOwner: r.content_owner || '-',
    keyword:      r.focused_kw   || '',
    volume:       Number(r.volume) || 0,
    was,
    now,
    delta,
    pctImpr:      pct,
    movement:     movement(was, now, hasKw),
    type:         r.task_type    || '',
    state:        r.execution_state || '',
    intake:       (r.intake_date || '').slice(0, 10),
    hours:        Number(r.est_hours) || 0,
    targetUrl:    r.target_url      || '',
    docUrl:       r.doc_url       || '',
    remarks:      r.remarks       || '',
    indexStatus:  r.index_status  || '',
  };
}
