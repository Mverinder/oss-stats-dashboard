// update.js — fixes contributor counts by using the Commits API per-year (exact dates)
// Node 20+. No external deps. Charts rendered client-side via Chart.js.

import fs from "node:fs/promises";
import path from "node:path";

const PROJECTS = [
  { label: "Playwright", slug: "microsoft/playwright" },
  { label: "Selenium",   slug: "SeleniumHQ/selenium" },
  { label: "JMeter",     slug: "apache/jmeter" },
  { label: "Cypress",    slug: "cypress-io/cypress" }
];

const YEAR_A = 2024;
const YEAR_B = 2025;
const NOW = new Date();

/* --------------------------- HTTP helpers --------------------------- */
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function headers() {
  const h = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "oss-stats-dashboard"
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.PAT;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghRaw(url) {
  return fetch(url, { headers: headers() });
}
async function gh(endpoint) {
  const res = await ghRaw(`https://api.github.com${endpoint}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} for ${endpoint}: ${body}`);
  }
  return res.json();
}
function parseLinkHeader(h) {
  if (!h) return {};
  return Object.fromEntries(
    h.split(",").map(p => {
      const m = p.match(/<([^>]+)>;\s*rel="([^"]+)"/);
      return m ? [m[2], m[1]] : null;
    }).filter(Boolean)
  );
}
async function ghPaginated(endpoint) {
  const items = [];
  let url = `https://api.github.com${endpoint}`;
  while (url) {
    const res = await ghRaw(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status} for ${url}: ${body}`);
    }
    items.push(...await res.json());
    const links = parseLinkHeader(res.headers.get("link"));
    url = links.next || null;
  }
  return items;
}

/* ---------------------------- BOT filter ---------------------------- */
// Conservative but comprehensive patterns seen across OSS repos
const BOT_PATTERNS = [
  /\[bot\]$/i,                // user[bot]
  /-bot$/i, /^bot-/i,         // renovate-bot, bot-xyz
  /\bdependabot\b/i,
  /\bgithub-actions\b/i,
  /\brenovate\b/i,
  /\bpre-commit-ci\b/i,
  /\bsemantic-release\b/i,
  /\bpercy\b/i,
  /\bsnyk\b/i,
  /\bauto[-_]?merge\b/i,
  /\bautomation\b/i,
  /\brelease[-_ ]?bot\b/i
];

function isBotLogin(login) {
  if (!login) return false;
  return BOT_PATTERNS.some(rx => rx.test(login));
}
function isBotNameOrEmail(name, email) {
  const s = `${name || ""} ${email || ""}`;
  return BOT_PATTERNS.some(rx => rx.test(s));
}
function isBotAuthor(author, commit) {
  if (author?.type === "Bot") return true;
  if (isBotLogin(author?.login)) return true;
  const cn = commit?.author?.name || "";
  const ce = commit?.author?.email || "";
  return isBotNameOrEmail(cn, ce);
}

/* ---------------------------- Data fetch ---------------------------- */
async function fetchRepoMeta(owner, repo) {
  return gh(`/repos/${owner}/${repo}`);
}

// Official weekly totals (last ~52 weeks) for monthly charts
async function fetchWeeklyCommitActivity(owner, repo, tries=10) {
  for (let i=0;i<tries;i++) {
    const res = await ghRaw(`https://api.github.com/repos/${owner}/${repo}/stats/commit_activity`);
    if (res.status === 202) { await sleep(2000); continue; }
    if (!res.ok) throw new Error(`commit_activity ${res.status}`);
    return res.json(); // [{week,total,days:[7]}]
  }
  // final attempt
  const final = await ghRaw(`https://api.github.com/repos/${owner}/${repo}/stats/commit_activity`);
  if (!final.ok) throw new Error(`commit_activity ${final.status}`);
  return final.json();
}

// EXACT per-year contributor set from the Commits API
async function fetchYearContributors(owner, repo, year) {
  const since = new Date(Date.UTC(year, 0, 1)).toISOString();
  const until = new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString();
  const endpoint = `/repos/${owner}/${repo}/commits?per_page=100&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;

  const commits = await ghPaginated(endpoint);

  const byAuthor = new Map(); // key -> count
  for (const c of commits) {
    const login = c.author?.login || null;
    const name  = c.commit?.author?.name || "";
    const email = c.commit?.author?.email || "";

    if (isBotAuthor(c.author, c.commit)) continue;

    const key = login || (email || name || "unknown");
    byAuthor.set(key, (byAuthor.get(key) || 0) + 1);
  }

  // Unique contributor count is the map size
  const unique = byAuthor.size;

  // Top 5 = sorted by commit count desc
  const top = [...byAuthor.entries()]
    .sort((a,b)=>b[1]-a[1])
    .slice(0,5)
    .map(([author, commits]) => ({ author, commits }));

  return { unique, top, byAuthor };
}

/* ----------------------- Aggregation & rendering -------------------- */
function monthsElapsedInYear(y, refDate) {
  if (y < refDate.getUTCFullYear()) return 12;
  if (y > refDate.getUTCFullYear()) return 0;
  return refDate.getUTCMonth() + 1;
}
function ymdUTC(ts) { const d=new Date(ts*1000); return {y:d.getUTCFullYear(),m:d.getUTCMonth()+1}; }
function toYearlyMonthlyFromWeekly(weeks, yearA, yearB) {
  const monthsA = Array.from({ length: 12 }, () => 0);
  const monthsB = Array.from({ length: 12 }, () => 0);
  let totalA = 0, totalB = 0;

  for (const w of weeks) {
    const wk = ymdUTC(w.week); // week start
    if (wk.y === yearA) { monthsA[wk.m-1] += w.total; totalA += w.total; }
    else if (wk.y === yearB) { monthsB[wk.m-1] += w.total; totalB += w.total; }
  }

  const avgA = Math.round((totalA / (monthsElapsedInYear(yearA, NOW) || 12)) * 100) / 100;
  const avgB = Math.round((totalB / (monthsElapsedInYear(yearB, NOW) || 12)) * 100) / 100;

  return { monthsA, monthsB, totalA, totalB, avgA, avgB };
}

function escapeHtml(s){ return String(s).replace(/[&<>"]/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }

function renderHTML(snapshot) {
  const generatedAt = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  const labels   = snapshot.map(p => p.label);
  const commitsA = snapshot.map(p => p.commits.totalA);
  const commitsB = snapshot.map(p => p.commits.totalB);
  const devsA    = snapshot.map(p => p.contribA.unique);
  const devsB    = snapshot.map(p => p.contribB.unique);
  const forks    = snapshot.map(p => p.meta.forks_count);

  const perProjectMonthly = snapshot.map(p => ({
    label: p.label,
    m2024: p.commits.monthsA,
    m2025: p.commits.monthsB
  }));

  const htmlSafe = JSON.stringify({ labels, commitsA, commitsB, devsA, devsB, forks, perProjectMonthly, YEAR_A, YEAR_B });

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Open-Source Testing: ${YEAR_A} vs ${YEAR_B}</title>
<style>
:root{--bg:#0f1116;--panel:#161a23;--text:#e7e8ea;--muted:#9aa0ac;--accent:#5aa2ff;--border:#2a2f3a}
*{box-sizing:border-box} html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif}
header{position:sticky;top:0;background:rgba(15,17,22,.9);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
.wrap{max-width:1150px;margin:0 auto;padding:18px 20px}
h1{margin:0 0 4px;font-size:22px}.sub{color:var(--muted);font-size:13px}
main{max-width:1150px;margin:0 auto;padding:22px 20px 36px;display:grid;gap:18px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:16px 16px 18px}
.muted{color:var(--muted)} .pill{display:inline-block;border:1px solid var(--border);background:#141925;padding:2px 8px;border-radius:999px;font-size:12px;color:var(--muted)}
.projects{display
