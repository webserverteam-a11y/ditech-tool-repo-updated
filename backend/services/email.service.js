/**
 * email.service.js — SendGrid email wrapper.
 *
 * Reads SENDGRID_API_KEY and SENDGRID_FROM_EMAIL from environment.
 * Exports sendOverrunEmail(task, totalHours) for timer overrun alerts.
 */

import sgMail from '@sendgrid/mail';

const API_KEY   = process.env.SENDGRID_API_KEY   || '';
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@ditechcdmdigital.com';

if (API_KEY) {
  sgMail.setApiKey(API_KEY);
} else {
  console.warn('[email] SENDGRID_API_KEY not set — email notifications disabled.');
}

/**
 * Send a timer overrun alert email to the task owner.
 * @param {object} task  - { id, title, client, ownerName, ownerEmail }
 * @param {number} hours - Total elapsed hours (e.g. 5.34)
 */
export async function sendOverrunEmail(task, hours) {
  if (!API_KEY) {
    console.warn(`[email] Skipping overrun email for ${task.id} — no API key.`);
    return;
  }
  if (!task.ownerEmail) {
    console.warn(`[email] Skipping overrun email for ${task.id} — owner has no email.`);
    return;
  }

  const hrsDisplay = hours.toFixed(1);
  const appUrl     = process.env.APP_URL || 'https://ditechcdmdigital.com';

  const subject = `⏱ Task overrun alert: "${task.title}" exceeded 5 hours`;

  const text = [
    `Hi ${task.ownerName},`,
    '',
    `This is an automated alert from DiTech CDM.`,
    '',
    `The following task has exceeded 5 hours of active timer time:`,
    '',
    `  Task ID : ${task.id}`,
    `  Task    : ${task.title}`,
    `  Client  : ${task.client || '—'}`,
    `  Owner   : ${task.ownerName}`,
    `  Elapsed : ${hrsDisplay} hrs`,
    '',
    `Please review the task and update its status if needed.`,
    `${appUrl}`,
    '',
    '— DiTech CDM (automated)',
  ].join('\n');

  const html = `
<div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b;max-width:560px">
  <div style="background:#1e2d5a;color:#fff;padding:14px 20px;border-radius:8px 8px 0 0">
    <strong>⏱ Task Timer Overrun Alert</strong>
  </div>
  <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
    <p>Hi <strong>${esc(task.ownerName)}</strong>,</p>
    <p>The following task has exceeded <strong>5 hours</strong> of active timer time:</p>
    <table style="width:100%;border-collapse:collapse;margin:14px 0">
      <tr><td style="padding:6px 10px;background:#f1f5f9;font-weight:700;width:110px">Task ID</td><td style="padding:6px 10px;font-family:monospace">${esc(task.id)}</td></tr>
      <tr><td style="padding:6px 10px;background:#f1f5f9;font-weight:700">Task</td><td style="padding:6px 10px">${esc(task.title)}</td></tr>
      <tr><td style="padding:6px 10px;background:#f1f5f9;font-weight:700">Client</td><td style="padding:6px 10px">${esc(task.client || '—')}</td></tr>
      <tr><td style="padding:6px 10px;background:#f1f5f9;font-weight:700">Owner</td><td style="padding:6px 10px">${esc(task.ownerName)}</td></tr>
      <tr><td style="padding:6px 10px;background:#fee2e2;font-weight:700;color:#b91c1c">Elapsed</td><td style="padding:6px 10px;color:#b91c1c;font-weight:700">${hrsDisplay} hrs</td></tr>
    </table>
    <p>Please review the task and update its status if needed.</p>
    <a href="${appUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-weight:600">Open DiTech CDM →</a>
    <p style="margin-top:20px;font-size:12px;color:#94a3b8">This is an automated message from DiTech CDM. Do not reply.</p>
  </div>
</div>`;

  const msg = {
    to:      task.ownerEmail,
    from:    FROM_EMAIL,
    subject,
    text,
    html,
  };

  try {
    await sgMail.send(msg);
    console.log(`[email] Overrun alert sent for ${task.id} to ${task.ownerEmail} (${hrsDisplay}h)`);
  } catch (err) {
    console.error(`[email] Failed to send overrun alert for ${task.id}:`, err?.response?.body || err.message);
  }
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
