#!/usr/bin/env node
// rss-to-slack.mjs
// Reads digest.xml, takes the newest item, posts full content to Slack via Incoming Webhook.
// Triggered by GitHub Actions on every push that touches digest.xml.

import { readFileSync } from 'fs';
import { request } from 'https';

const xml = readFileSync('digest.xml', 'utf8');
const item = xml.match(/<item>([\s\S]*?)<\/item>/)?.[1];
if (!item) { console.log('No items in feed'); process.exit(0); }

const get = (re) => item.match(re)?.[1]?.trim() ?? '';
const title = get(/<title>([^<]+)<\/title>/);
const encoded = get(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/);
const description = get(/<description>([^<]+)<\/description>/);

// Convert HTML subset → Slack mrkdwn
function md(html) {
  return html
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, t) => `*${md(t)}*`)
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_, t) => `_${md(t)}_`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${t.replace(/<[^>]+>/g, '')}\``)
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, u, t) => `<${u}|${md(t)}>`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `• ${md(t).trim()}\n`)
    .replace(/<\/?(?:ul|ol|div|p|body|html|head|DOCTYPE)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&middot;/g, '·').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Split into sections by h2/h3
const sectionRe = /<h[23][^>]*>([\s\S]*?)<\/h[23]>([\s\S]*?)(?=<h[23]|$)/gi;
const sections = [];
let m;
while ((m = sectionRe.exec(encoded)) !== null) {
  const heading = m[1].replace(/<[^>]+>/g, '').trim();
  const body = md(m[2]).slice(0, 2800);
  if (heading && body) sections.push({ heading, body });
}

// Build Block Kit payload
const blocks = [
  { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
  { type: 'divider' },
];

if (sections.length) {
  for (const { heading, body } of sections) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${heading}*\n${body}` } });
    blocks.push({ type: 'divider' });
  }
} else {
  // Fallback: no h2/h3 sections found, post description + stripped full text
  const full = md(encoded).slice(0, 2900) || description;
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: full } });
}

const webhookUrl = process.env.SLACK_WEBHOOK_URL;
if (!webhookUrl) { console.error('SLACK_WEBHOOK_URL secret not set'); process.exit(1); }

const payload = JSON.stringify({ text: title, blocks });
const url = new URL(webhookUrl);

const req = request({
  hostname: url.hostname,
  path: url.pathname + url.search,
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    console.log(`Slack ${res.statusCode}:`, body);
    if (res.statusCode !== 200) process.exit(1);
  });
});
req.on('error', e => { console.error(e.message); process.exit(1); });
req.write(payload);
req.end();
