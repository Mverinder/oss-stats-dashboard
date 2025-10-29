// update.js — accurate yearly stats using GitHub /stats endpoints
// Node 20+. No external deps. Charts rendered client-side via Chart.js.

import fs from "node:fs/promises";
import path from "node:path";

// === Projects to track ===
const PROJECTS = [
  { label: "Playwright", slug: "microsoft/playwright" },
  { label: "Selenium",   slug: "SeleniumHQ/selenium" },
  { label: "JMeter",     slug: "apache/jmeter" },
  { label: "Cypress",    slug: "cypress-io/cypress" }
];

// Compare these years
const YEAR_A = 2024;
const YEAR_B = 2025;
const NOW = new Date();

// ---------- Helpers ----------
function monthsElapsedInYear(y, refDate) {
  if (y < refDate.getUTCFullYear()) return 12;
  if (y > refDate.getUTCFullYear()) return 0;
  return refDate.getUTCMonth() + 1; // 1..12
}
function ymdUTC(ts) {
  const d = new Date(ts * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
function monthIndex(d) { return d.m - 1; } // 0..11
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function ghRaw(url) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "oss-stats-dashboard"
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.PAT;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  return res;
}
async function gh(endpoint) {
  const res = await ghRaw(`https://api.github.com${endpoint}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} for ${endpoint}: ${body}`);
  }
  return res.json();
}

// Poll a /stats endpoint until it’s ready (GitHub may return 202 initially)
async function ghStats(endpoint, tries = 10, delayMs = 2000) {
  for (let i = 0; i < tries; i++) {
    const res = await ghRaw(`https://api.github.com${endpoint}`);
    if (res.status === 202) { await sleep(delayMs); continue; }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status} for ${endpoint}: ${body}`);
    }
    return res.json();
  }
  // Final attempt even if still 202
  const final = await ghRaw(`https://api.github.com${endpoint}`);
  if (!final.ok) {
    const body = await final.text();
    throw new Error(`GitHub API ${final.status} for ${endpoint}: ${body}`);
  }
  return final.json();
}

// Repo metadata (forks, stars, link)
async function fetchRepoMeta(owner, repo) {
  return gh(`/repos/${owner}/${repo}`);
}

// Weekly commits (total) across the whole repo (last 52 weeks)
async function fetchWeeklyCommitActivity(owner, repo) {
  // returns [{week, total, days:[7]}] for last 52 weeks
  return ghStats(`/repos/${owner}/${repo}/stats/commit_activity`);
}

// Per-contributor weekly commits for last 52 weeks
async function fetchContributorWeekly(owner, repo) {
  // returns [{author, weeks:[{w, a, d, c}...]}]
  return ghStats(`/repos/${owner}/${repo}/stats/contributors`);
}

// Convert weekly totals → calendar-year monthly totals for YEAR_A/YEAR_B
function toYearlyMonthlyFromWeekly(weeks) {
  const monthsA = Array.from({ length: 12 }, () => 0);
  const monthsB = Array.from({ length: 12 }, () => 0);
  let totalA = 0, totalB = 0;

  for (const w of weeks) {
    const wk = ymdUTC(w.week);
    if (wk.y === YEAR_A) {
      monthsA[monthIndex(wk)] += w.total;
      totalA += w.total;
    } else if (wk.y === YEAR_B) {
      monthsB[monthIndex(wk)] += w.total;
      totalB += w.total;
    }
  }

  const avgA = Math.round((totalA / (monthsElapsedInYear(YEAR_A, NOW) || 12)) * 100) / 100;
  const avgB = Math.round((totalB / (monthsElapsedInYear(YEAR_B, NOW) || 12)) * 100) / 100;

  return { monthsA, monthsB, totalA, totalB, avgA, avgB };
}

// Compute unique contributors per year and top committers (non-bots) from /stats/contributors
function contributorStatsPerYear(contribs) {
  const isBot = a => (a?.type === "Bot") || /\[bot\]$/i.test(a?.login || "");
  const mapA = new Map(); // author_login -> commits in YEAR_A
  const mapB = new Map(); // author_login -> commits in YEAR_B

  for (const row of contribs) {
    const author = row.author || {};
    if (isBot(author)) continue;

    let sumA = 0, sumB = 0;
    for (const wk of row.weeks || []) {
      const d = ymdUTC(wk.w);
      if (d.y === YEAR_A) sumA += wk.c || 0;
      else if (d.y === YEAR_B) sumB += wk.c || 0;
    }
    if (sumA > 0) mapA.set(author.login || "(unknown)", (mapA.get(author.login || "(unknown)") || 0) + sumA);
    if (sumB > 0) mapB.set(author.login || "(unknown)", (mapB.get(author.login || "(unknown)") || 0) + sumB);
  }

  const uniqueA = mapA.size;
  const uniqueB = mapB.size;

  const topB = [...mapB.entries()]
    .sort((a,b)=>b[1]-a[1])
    .slice(0,5)
    .map(([author, commits]) => ({ author, commits }));

  return { uniqueA, uniqueB, topB, mapA, mapB };
}

function renderHTML(snapshot) {
  const generatedAt = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  const labels = snapshot.map(p => p.label);
  const commitsA = snapshot.map(p => p.commits.totalA);
  const commitsB = snapshot.map(p => p.commits.totalB);
  const devsA = snapshot.map(p => p.contributors.uniqueA);
  const devsB = snapshot.map(p => p.contributors.uniqueB);
  const forks = snapshot.map(p => p.meta.forks_count);

  const perProjectMonthly = snapshot.map(p => ({
    label: p.label,
    m2024: p.commits.monthsA,
    m2025: p.commits.monthsB
  }));

  const htmlSafe = JSON.stringify({
    labels, commitsA, commitsB, devsA, devsB, forks, perProjectMonthly,
    YEAR_A, YEAR_B
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Open-Source Testing: ${YEAR_A} vs ${YEAR_B}</title>
<style>
:root{--bg:#0f1116;--panel:#161a23;--text:#e7e8ea;--muted:#9aa0ac;--accent:#5aa2ff;--border:#2a2f3a}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif}
header{position:sticky;top:0;background:rgba(15,17,22,.9);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
.wrap{max-width:1150px;margin:0 auto;padding:18px 20px}
h1{margin:0 0 4px;font-size:22px}
.sub{color:var(--muted);font-size:13px}
main{max-width:1150px;margin:0 auto;padding:22px 20px 36px;display:grid;gap:18px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:16px 16px 18px}
.kpis{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}
.kpi{grid-column:span 3;background:#181d29;border:1px solid var(--border);border-radius:14px;padding:14px}
.kpi .label{color:var(--muted);font-size:12px;letter-spacing:.03em;text-transform:uppercase}
.kpi .value{font-size:22px;margin-top:6px}
@media (max-width:900px){.kpi{grid-column:span 6}}
@media (max-width:600px){.kpi{grid-column:span 12}}
.projects{display:grid;gap:14px;grid-template-columns:repeat(12,1fr)}
.project{grid-column:span 6;background:#181d29;border:1px solid var(--border);border-radius:14px;padding:14px}
@media (max-width:900px){.project{grid-column:span 12}}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.muted{color:var(--muted)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
canvas{width:100%;height:360px}.mini{height:220px}
.pill{display:inline-block;border:1px solid var(--border);background:#141925;padding:2px 8px;border-radius:999px;font-size:12px;color:var(--muted)}
footer{color:var(--muted);text-align:center;padding:26px 10px;border-top:1px solid var(--border)}
</style>
</head>
<body>
<header><div class="wrap">
  <h1>Open-Source Testing Dashboard</h1>
  <div class="sub">Daily updates — generated ${generatedAt}</div>
</div></header>

<main>
  <section class="card">
    <div class="row"><div><span class="pill">Commits</span></div></div>
    <canvas id="commitsBar"></canvas>
  </section>

  <section class="card">
    <div class="row"><div><span class="pill">Contributors (Unique, Non-Bots)</span></div></div>
    <canvas id="devsBar"></canvas>
  </section>

  <section class="card">
    <div class="row"><div><span class="pill">Forks</span></div></div>
    <canvas id="forksBar"></canvas>
  </section>

  <section class="card">
    <h2 style="margin:0 0 10px">Per-Project Details</h2>
    <div class="projects">
      ${snapshot.map(p => `
      <div class="project">
        <div class="row">
          <h3 style="margin:0">${p.label}</h3>
          <div class="muted">★ ${p.meta.stargazers_count} • Forks ${p.meta.forks_count}</div>
        </div>

        <div class="kpis" style="margin:10px 0 6px">
          <div class="kpi"><div class="label">${YEAR_A} Total Commits</div><div class="value">${p.commits.totalA.toLocaleString()}</div><div class="muted">Avg/mo: ${p.commits.avgA}</div></div>
          <div class="kpi"><div class="label">${YEAR_B} Total Commits</div><div class="value">${p.commits.totalB.toLocaleString()}</div><div class="muted">Avg/mo (YTD): ${p.commits.avgB}</div></div>
          <div class="kpi"><div class="label">${YEAR_A} Unique Devs</div><div class="value">${p.contributors.uniqueA.toLocaleString()}</div></div>
          <div class="kpi"><div class="label">${YEAR_B} Unique Devs</div><div class="value">${p.contributors.uniqueB.toLocaleString()}</div></div>
        </div>

        <div class="row"><div class="muted">Monthly Commits (${YEAR_A} vs ${YEAR_B})</div></div>
        <canvas class="mini" id="mini-${p.id}"></canvas>

        <h4 style="margin:14px 0 6px">Top 5 Committers (non-bots, ${YEAR_B} YTD)</h4>
        <table><thead><tr><th>#</th><th>Author</th><th>Commits</th></tr></thead>
          <tbody>
            ${p.topB.map((t,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(t.author)}</td><td>${t.commits}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No data</td></tr>`}
          </tbody>
        </table>
        <div class="muted" style="margin-top:6px">Repo: <a href="${p.meta.html_url}">${p.meta.full_name}</a></div>
      </div>`).join("")}
    </div>
  </section>
</main>

<footer>Data from GitHub REST API /stats endpoints.</footer>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
const DATA = ${htmlSafe};

const ctx1 = document.getElementById('commitsBar').getContext('2d');
new Chart(ctx1, { type:'bar',
  data:{ labels: DATA.labels, datasets:[
    { label: String(DATA.YEAR_A), data: DATA.commitsA },
    { label: String(DATA.YEAR_B)+' (YTD)', data: DATA.commitsB }
  ]},
  options:{ responsive:true, plugins:{ legend:{ labels:{ color:'#e7e8ea' } } }, scales:{ x:{ ticks:{ color:'#e7e8ea' } }, y:{ ticks:{ color:'#e7e8ea' } } } }
});

const ctx2 = document.getElementById('devsBar').getContext('2d');
new Chart(ctx2, { type:'bar',
  data:{ labels: DATA.labels, datasets:[
    { label: String(DATA.YEAR_A), data: DATA.devsA },
    { label: String(DATA.YEAR_B)+' (YTD)', data: DATA.devsB }
  ]},
  options:{ responsive:true, plugins:{ legend:{ labels:{ color:'#e7e8ea' } } }, scales:{ x:{ ticks:{ color:'#e7e8ea' } }, y:{ ticks:{ color:'#e7e8ea' } } } }
});

const ctx3 = document.getElementById('forksBar').getContext('2d');
new Chart(ctx3, { type:'bar',
  data:{ labels: DATA.labels, datasets:[{ label:'Forks', data: DATA.forks }]},
  options:{ responsive:true, plugins:{ legend:{ labels:{ color:'#e7e8ea' } } }, scales:{ x:{ ticks:{ color:'#e7e8ea' } }, y:{ ticks:{ color:'#e7e8ea' } } } }
});

// Per-project monthly
const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
for (const proj of DATA.perProjectMonthly) {
  const c = document.getElementById('mini-'+proj.label.toLowerCase());
  if (!c) continue;
  new Chart(c.getContext('2d'), {
    type:'line',
    data:{ labels: months, datasets:[
      { label:String(DATA.YEAR_A), data: proj.m2024, tension:.25 },
      { label:String(DATA.YEAR_B)+' (YTD)', data: proj.m2025, tension:.25 }
    ]},
    options:{ responsive:true, plugins:{ legend:{ labels:{ color:'#e7e8ea' } } }, scales:{ x:{ ticks:{ color:'#e7e8ea' } }, y:{ ticks:{ color:'#e7e8ea' } } } }
  });
}
function escapeHtml(s){ return String(s).replace(/[&<>"]/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
</script>
</body></html>`;
}

function escapeHtml(s){ return String(s).replace(/[&<>"]/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }

(async () => {
  const outDir = path.join(process.cwd(), "docs");
  const outFile = path.join(outDir, "index.html");

  const results = [];
  for (const p of PROJECTS) {
    const [owner, repo] = p.slug.split("/");

    const meta = await fetchRepoMeta(owner, repo);
    const weekly = await fetchWeeklyCommitActivity(owner, repo);          // [{week,total,days}]
    const perAuthor = await fetchContributorWeekly(owner, repo);          // [{author, weeks:[{w,c,...}]}]

    const commits = toYearlyMonthlyFromWeekly(weekly);
    const contrib = contributorStatsPerYear(perAuthor);

    results.push({
      id: p.label.toLowerCase(),
      label: p.label,
      meta,
      commits,
      contributors: { uniqueA: contrib.uniqueA, uniqueB: contrib.uniqueB },
      topB: contrib.topB
    });
  }

  const html = renderHTML(results);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, html, "utf8");
  console.log("Wrote", outFile);
})();
