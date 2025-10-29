// update.js — Dashboard with exact date-bounded counts that match Mike's sheet
// - Commits, monthly buckets, contributors, top 5 => GitHub Commits API (not /stats)
// - 2024 = full year; 2025 YTD is capped at Oct 31, 23:59:59Z (10 months)
// - Excludes merges (parents.length > 1) and filters bots/service accounts
// Node 20+, no npm deps.

import fs from "node:fs/promises";
import path from "node:path";

/* ============================ CONFIG ============================ */

const PROJECTS = [
  { label: "Playwright", slug: "microsoft/playwright" },
  { label: "Selenium",   slug: "SeleniumHQ/selenium" },
  { label: "JMeter",     slug: "apache/jmeter" },
  { label: "Cypress",    slug: "cypress-io/cypress" }
];

const YEAR_A = 2024;
// IMPORTANT: we freeze 2025 YTD at end of October to match the spreadsheet (10 months)
const YEAR_B = 2025;
const YTD_CUTOFF = new Date(Date.UTC(2025, 9, 31, 23, 59, 59)); // 2025-10-31T23:59:59Z
const MONTHS_A = 12;
const MONTHS_B = 10; // YTD through October

/* =========================== HELPERS ============================ */

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

async function ghRaw(url) { return fetch(url, { headers: headers() }); }

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
  const out = [];
  let url = `https://api.github.com${endpoint}`;
  while (url) {
    const res = await ghRaw(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status} for ${url}: ${body}`);
    }
    out.push(...await res.json());
    const links = parseLinkHeader(res.headers.get("link"));
    url = links.next || null;
  }
  return out;
}

/* ========================= BOT FILTERING ======================== */

const BOT_PATTERNS = [
  /\[bot\]$/i, /-bot$/i, /^bot-/i,
  /\bdependabot\b/i, /\bgithub-actions\b/i, /\brenovate\b/i,
  /\bpre-commit-ci\b/i, /\bsemantic-release\b/i, /\bpercy\b/i,
  /\bsnyk\b/i, /\bauto[-_ ]?merge\b/i, /\bautomation\b/i, /\brelease[-_ ]?bot\b/i
];

function isBotLogin(login) { return !!login && BOT_PATTERNS.some(rx => rx.test(login)); }
function isBotNameOrEmail(name, email) {
  const s = `${name || ""} ${email || ""}`;
  return BOT_PATTERNS.some(rx => rx.test(s));
}
function isBotAuthor(author, commit) {
  if (author?.type === "Bot") return true;
  if (isBotLogin(author?.login)) return true;
  const n = commit?.author?.name || "";
  const e = commit?.author?.email || "";
  return isBotNameOrEmail(n, e);
}

/* =========================== DATA FETCH ========================= */

async function fetchRepoMeta(owner, repo) {
  return gh(`/repos/${owner}/${repo}`);
}

// Date-bounded commits with pagination
async function fetchCommits(owner, repo, since, until) {
  const endpoint = `/repos/${owner}/${repo}/commits?per_page=100&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
  return ghPaginated(endpoint);
}

// Compute: totals, monthly buckets, unique contributors, top 5 (non-bots, non-merges)
function aggregateFromCommits(commits, monthsCount, year) {
  const monthly = Array.from({ length: 12 }, () => 0);
  const byAuthor = new Map(); // key (login OR email/name) -> commit count
  let total = 0;

  for (const c of commits) {
    // Exclude merges
    if (Array.isArray(c.parents) && c.parents.length > 1) continue;
    if (isBotAuthor(c.author, c.commit)) continue;

    // Month bucket
    const dt = new Date(c.commit?.author?.date || c.commit?.committer?.date || 0);
    const y = dt.getUTCFullYear();
    if (y !== year) continue; // safety

    const m = dt.getUTCMonth(); // 0..11
    monthly[m] += 1;
    total += 1;

    // Contributor tally
    const login = c.author?.login || null;
    const name  = c.commit?.author?.name || "";
    const email = c.commit?.author?.email || "";
    const key = login || (email || name || "unknown");
    byAuthor.set(key, (byAuthor.get(key) || 0) + 1);
  }

  // Average per month (divide by declared monthsCount)
  const avg = Math.round((total / monthsCount) * 100) / 100;

  const unique = byAuthor.size;
  const top = [...byAuthor.entries()]
    .sort((a,b)=>b[1]-a[1])
    .slice(0,5)
    .map(([author, commits]) => ({ author, commits }));

  return { total, monthly, avg, unique, top };
}

/* =========================== RENDER HTML ========================= */

function escapeHtml(s){ return String(s).replace(/[&<>"]/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }

function renderHTML(snapshot) {
  const generatedAt = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  const labels   = snapshot.map(p => p.label);
  const commitsA = snapshot.map(p => p.y2024.total);
  const commitsB = snapshot.map(p => p.y2025.total);
  const devsA    = snapshot.map(p => p.y2024.unique);
  const devsB    = snapshot.map(p => p.y2025.unique);
  const forks    = snapshot.map(p => p.meta.forks_count);

  const perProjectMonthly = snapshot.map(p => ({
    label: p.label,
    m2024: p.y2024.monthly,
    m2025: p.y2025.monthly
  }));

  const dataJSON = JSON.stringify({
    labels, commitsA, commitsB, devsA, devsB, forks, perProjectMonthly,
    YEAR_A, YEAR_B
  });

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Open-Source Testing: ${YEAR_A} vs ${YEAR_B} (YTD)</title>
<style>
:root{--bg:#0f1116;--panel:#161a23;--text:#e7e8ea;--muted:#9aa0ac;--accent:#5aa2ff;--border:#2a2f3a}
*{box-sizing:border-box} html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif}
header{position:sticky;top:0;background:rgba(15,17,22,.9);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
.wrap{max-width:1150px;margin:0 auto;padding:18px 20px}
h1{margin:0 0 4px;font-size:22px}.sub{color:var(--muted);font-size:13px}
main{max-width:1150px;margin:0 auto;padding:22px 20px 36px;display:grid;gap:18px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:16px 16px 18px}
.projects{display:grid;gap:14px;grid-template-columns:repeat(12,1fr)}
.project{grid-column:span 6;background:#181d29;border:1px solid var(--border);border-radius:14px;padding:14px}
@media (max-width:900px){.project{grid-column:span 12}}
.muted{color:var(--muted)} .pill{display:inline-block;border:1px solid var(--border);background:#141925;padding:2px 8px;border-radius:999px;font-size:12px;color:var(--muted)}
table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
canvas{width:100%;height:360px}.mini{height:220px}
footer{color:var(--muted);text-align:center;padding:26px 10px;border-top:1px solid var(--border)}
</style>
</head><body>
<header><div class="wrap">
  <h1>Open-Source Testing Dashboard</h1>
  <div class="sub">Daily updates — generated ${generatedAt}</div>
</div></header>

<main>
  <section class="card"><div class="pill">Commits</div><canvas id="commitsBar"></canvas></section>
  <section class="card"><div class="pill">Contributors (Unique, Non-Bots)</div><canvas id="devsBar"></canvas></section>
  <section class="card"><div class="pill">Forks</div><canvas id="forksBar"></canvas></section>

  <section class="card">
    <h2 style="margin:0 0 10px">Per-Project Details</h2>
    <div class="projects">
      ${snapshot.map(p => `
      <div class="project">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
          <h3 style="margin:0">${p.label}</h3>
          <div class="muted">★ ${p.meta.stargazers_count} • Forks ${p.meta.forks_count}</div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:10px 0 6px">
          <div><div class="muted">${YEAR_A} Total Commits</div><div style="font-size:22px">${p.y2024.total.toLocaleString()}</div><div class="muted">Avg/mo: ${p.y2024.avg}</div></div>
          <div><div class="muted">${YEAR_B} Total Commits (YTD)</div><div style="font-size:22px">${p.y2025.total.toLocaleString()}</div><div class="muted">Avg/mo (10 mo): ${p.y2025.avg}</div></div>
          <div><div class="muted">${YEAR_A} Unique Devs</div><div style="font-size:22px">${p.y2024.unique.toLocaleString()}</div></div>
          <div><div class="muted">${YEAR_B} Unique Devs (YTD)</div><div style="font-size:22px">${p.y2025.unique.toLocaleString()}</div></div>
        </div>

        <div class="muted">Monthly Commits (${YEAR_A} vs ${YEAR_B} YTD)</div>
        <canvas class="mini" id="mini-${p.id}"></canvas>

        <h4 style="margin:14px 0 6px">Top 5 Committers (non-bots, ${YEAR_B} YTD)</h4>
        <table><thead><tr><th>#</th><th>Author</th><th>Commits</th></tr></thead>
          <tbody>
            ${p.y2025.top.map((t,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(t.author)}</td><td>${t.commits}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No data</td></tr>`}
          </tbody>
        </table>
        <div class="muted" style="margin-top:6px">Repo: <a href="${p.meta.html_url}">${p.meta.full_name}</a></div>
      </div>`).join("")}
    </div>
  </section>
</main>

<footer>Date bounds: 2024 full year; 2025 through Oct 31 (10 months). Bots and merges excluded.</footer>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js" defer></script>
<script>
(function () {
  const DATA = ${dataJSON};

  function g(id){ const el=document.getElementById(id); return el?el.getContext('2d'):null; }

  function bar(ctx, label, data, label2, data2){
    if (!ctx || !window.Chart) return;
    new Chart(ctx,{type:'bar',data:{labels:DATA.labels,datasets:[
      {label:String(DATA.YEAR_A),data:data},
      {label:String(DATA.YEAR_B)+' (YTD)',data:data2}
    ]},options:{responsive:true,plugins:{legend:{labels:{color:'#e7e8ea'}}},scales:{x:{ticks:{color:'#e7e8ea'}},y:{ticks:{color:'#e7e8ea'}}}}});
  }

  function start(){
    bar(g('commitsBar'), 'Commits', DATA.commitsA, 'Commits', DATA.commitsB);
    bar(g('devsBar'), 'Contribs', DATA.devsA, 'Contribs', DATA.devsB);

    const f=g('forksBar');
    if (f) new Chart(f,{type:'bar',data:{labels:DATA.labels,datasets:[{label:'Forks',data:DATA.forks}]},options:{responsive:true,plugins:{legend:{labels:{color:'#e7e8ea'}}},scales:{x:{ticks:{color:'#e7e8ea'}},y:{ticks:{color:'#e7e8ea'}}}}});

    const months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    for (const proj of DATA.perProjectMonthly){
      const el=document.getElementById('mini-'+proj.label.toLowerCase());
      if (!el) continue;
      new Chart(el.getContext('2d'),{type:'line',data:{labels:months,datasets:[
        {label:String(DATA.YEAR_A),data:proj.m2024,tension:.25},
        {label:String(DATA.YEAR_B)+' (YTD)',data:proj.m2025,tension:.25}
      ]},options:{responsive:true,plugins:{legend:{labels:{color:'#e7e8ea'}}},scales:{x:{ticks:{color:'#e7e8ea'}},y:{ticks:{color:'#e7e8ea'}}}}});
    }
  }

  if (document.readyState==='complete') start();
  else window.addEventListener('load', start);
})();
</script>
</body></html>`;
}

/* ============================== MAIN ============================== */

function iso(y,m,d,h=0,mi=0,s=0){ return new Date(Date.UTC(y,m-1,d,h,mi,s)).toISOString(); }

(async () => {
  const outDir = path.join(process.cwd(), "docs");
  const outFile = path.join(outDir, "index.html");

  const results = [];
  for (const p of PROJECTS) {
    const [owner, repo] = p.slug.split("/");

    const meta = await fetchRepoMeta(owner, repo);

    // 2024 full-year window
    const commits2024 = await fetchCommits(owner, repo, iso(2024,1,1), iso(2024,12,31,23,59,59));
    const y2024 = aggregateFromCommits(commits2024, MONTHS_A, 2024);

    // 2025 YTD: Jan 1 through Oct 31 (fixed to 10 months to match sheet)
    const commits2025 = await fetchCommits(owner, repo, iso(2025,1,1), YTD_CUTOFF.toISOString());
    const y2025 = aggregateFromCommits(commits2025, MONTHS_B, 2025);

    results.push({
      id: p.label.toLowerCase(),
      label: p.label,
      meta,
      y2024,
      y2025
    });
  }

  const html = renderHTML(results);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, html, "utf8");
  console.log("Wrote", outFile);
})();
