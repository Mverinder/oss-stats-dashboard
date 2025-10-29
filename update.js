// update.js — Open-Source Testing Dashboard (Insights-style counting)
// - Commit totals = sum of per-author commits EXCLUDING bots/service accounts
// - Unique contributors = humans only (same filter)
// - Top 5 = humans only (same filter)
// - Merges INCLUDED
// - 2024 = full year; 2025 YTD fixed at Oct 31 (UTC)
// - Outputs: docs/index.html + docs/verification.json
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
const YEAR_B = 2025;
const YTD_CUTOFF = new Date(Date.UTC(2025, 9, 31, 23, 59, 59)); // 2025-10-31 23:59:59Z
const MONTHS_A = 12;
const MONTHS_B = 10; // through October

/* ======================= BOT / SERVICE FILTER ==================== */

// Generic patterns that catch most bots and automation accounts
const BOT_PATTERNS = [
  /\[bot\]$/i, /-bot$/i, /^bot-/i,
  /\bdependabot\b/i, /\bgithub-actions\b/i, /\brenovate\b/i,
  /\bpre-commit-ci\b/i, /\bsemantic-release\b/i, /\bpercy\b/i,
  /\bsnyk\b/i, /\bauto[-_ ]?merge\b/i, /\bautomation\b/i, /\brelease[-_ ]?bot\b/i,
  /\bcopilot\b/i
];

// Your repo-specific “non-obvious” bots/service accounts
const REPO_DENY = {
  "SeleniumHQ/selenium": [
    "selenium-ci",
    "renovate[bot]"
  ],
  "microsoft/playwright": [
    "microsoft-playwright-automation[bot]",
    "playwrightmachine",
    "github-actions[bot]",
    "dependabot[bot]",
    "Copilot"
  ]
};

// Optional: allow extending via local bots.json (same shape as REPO_DENY)
async function loadExternalDeny() {
  try {
    const raw = await fs.readFile("./bots.json", "utf8");
    const j = JSON.parse(raw);
    for (const [repo, list] of Object.entries(j || {})) {
      REPO_DENY[repo] = Array.from(new Set([...(REPO_DENY[repo] || []), ...(list || [])]));
    }
  } catch { /* ignore */ }
}

/* =========================== GITHUB HELPERS ====================== */

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

function parseLinkHeader(h) {
  if (!h) return {};
  return Object.fromEntries(
    h.split(",").map(p=>{
      const m=p.match(/<([^>]+)>;\s*rel="([^"]+)"/);
      return m ? [m[2], m[1]] : null;
    }).filter(Boolean)
  );
}
async function ghPaginated(endpoint) {
  const out = [];
  let url = `https://api.github.com${endpoint}`;
  while (url) {
    const r = await ghRaw(url);
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`GitHub ${r.status} for ${url}: ${body}`);
    }
    out.push(...await r.json());
    const links = parseLinkHeader(r.headers.get("link"));
    url = links.next || null;
  }
  return out;
}
function iso(y,m,d,h=0,mi=0,s=0){ return new Date(Date.UTC(y,m-1,d,h,mi,s)).toISOString(); }

/* ====================== DATA FETCH (Commits API) ================= */

async function repoMeta(owner, repo) {
  const r = await ghRaw(`https://api.github.com/repos/${owner}/${repo}`);
  if (!r.ok) throw new Error(`Repo meta ${r.status} ${owner}/${repo}`);
  return r.json();
}

async function* listCommits(owner, repo, sinceISO, untilISO, sha) {
  let url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=100&since=${encodeURIComponent(sinceISO)}&until=${encodeURIComponent(untilISO)}&sha=${encodeURIComponent(sha)}`;
  while (url) {
    const r = await ghRaw(url);
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`GitHub ${r.status}: ${body}`);
    }
    const page = await r.json();
    for (const c of page) yield c;
    const links = parseLinkHeader(r.headers.get("link"));
    url = links.next || null;
  }
}

/* ======================== INSIGHTS-STYLE MATH ==================== */

function looksLikeBot(repoFull, login, name, email) {
  const repoList = new Set(REPO_DENY[repoFull] || []);
  if (login && repoList.has(login)) return true;
  const s = [login, name, email].filter(Boolean).join(" ");
  return BOT_PATTERNS.some(rx => rx.test(s));
}

// Return BOTH: all-commit totals and “human-only” numbers.
// Charts will use the human-only totals (matching your manual sum).
function aggregateInsightsStyle(commits, repoFull, monthsCount, year) {
  const monthlyAll = Array.from({ length: 12 }, () => 0);
  const monthlyHuman = Array.from({ length: 12 }, () => 0);

  const byAuthorAll = new Map();    // key -> commits (all identities)
  const byAuthorHuman = new Map();  // key -> commits (humans only)

  for (const c of commits) {
    const when = c.commit?.author?.date || c.commit?.committer?.date;
    if (!when) continue;
    const dt = new Date(when);
    if (dt.getUTCFullYear() !== year) continue;
    const m = dt.getUTCMonth(); // 0..11

    // Identity
    const login = c.author?.login || null;
    const name  = c.commit?.author?.name || "";
    const email = c.commit?.author?.email || "";
    const key = login || email || name || "unknown";

    // All-identities totals (includes bots & merges)
    monthlyAll[m] += 1;
    byAuthorAll.set(key, (byAuthorAll.get(key) || 0) + 1);

    // Humans-only
    if (!looksLikeBot(repoFull, login, name, email)) {
      monthlyHuman[m] += 1;
      byAuthorHuman.set(key, (byAuthorHuman.get(key) || 0) + 1);
    }
  }

  const totalAll = [...byAuthorAll.values()].reduce((a,b)=>a+b,0);
  const totalHuman = [...byAuthorHuman.values()].reduce((a,b)=>a+b,0);

  const avgAll = Math.round((totalAll / monthsCount) * 100) / 100;
  const avgHuman = Math.round((totalHuman / monthsCount) * 100) / 100;

  const uniqueHuman = byAuthorHuman.size;
  const topHuman = [...byAuthorHuman.entries()]
    .sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([author, commits]) => ({ author, commits }));

  return {
    // what the charts will use
    human: {
      total: totalHuman, monthly: monthlyHuman, avg: avgHuman,
      unique: uniqueHuman, top: topHuman
    },
    // extra transparency for verification.json
    all: {
      total: totalAll, monthly: monthlyAll, avg: avgAll,
      unique: byAuthorAll.size
    }
  };
}

/* ============================ HTML RENDER ======================== */

function escapeHtml(s){ return String(s).replace(/[&<>"]/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }

function renderHTML(snapshot) {
  const generatedAt = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  const labels   = snapshot.map(p => p.label);
  const commitsA = snapshot.map(p => p.y2024.human.total);
  const commitsB = snapshot.map(p => p.y2025.human.total);
  const devsA    = snapshot.map(p => p.y2024.human.unique);
  const devsB    = snapshot.map(p => p.y2025.human.unique);
  const forks    = snapshot.map(p => p.meta.forks_count);

  const perProjectMonthly = snapshot.map(p => ({
    label: p.label,
    m2024: p.y2024.human.monthly,
    m2025: p.y2025.human.monthly
  }));

  const dataJSON = JSON.stringify({ labels, commitsA, commitsB, devsA, devsB, forks, perProjectMonthly, YEAR_A, YEAR_B });

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Open-Source Testing: ${YEAR_A} vs ${YEAR_B} (YTD)</title>
<style>
:root{--bg:#0f1116;--panel:#161a23;--text:#e7e8ea;--muted:#9aa0ac;--border:#2a2f3a}
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
  <section class="card"><div class="pill">Commits (Humans only, merges included)</div><canvas id="commitsBar"></canvas></section>
  <section class="card"><div class="pill">Contributors (Unique Humans)</div><canvas id="devsBar"></canvas></section>
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
          <div><div class="muted">${YEAR_A} Commits (humans)</div><div style="font-size:22px">${p.y2024.human.total.toLocaleString()}</div><div class="muted">Avg/mo: ${p.y2024.human.avg}</div></div>
          <div><div class="muted">${YEAR_B} Commits (YTD, humans)</div><div style="font-size:22px">${p.y2025.human.total.toLocaleString()}</div><div class="muted">Avg/mo (10 mo): ${p.y2025.human.avg}</div></div>
          <div><div class="muted">${YEAR_A} Unique Humans</div><div style="font-size:22px">${p.y2024.human.unique.toLocaleString()}</div></div>
          <div><div class="muted">${YEAR_B} Unique Humans (YTD)</div><div style="font-size:22px">${p.y2025.human.unique.toLocaleString()}</div></div>
        </div>

        <div class="muted">Monthly Commits (humans; ${YEAR_A} vs ${YEAR_B} YTD)</div>
        <canvas class="mini" id="mini-${p.id}"></canvas>

        <h4 style="margin:14px 0 6px">Top 5 Committers (humans, ${YEAR_B} YTD)</h4>
        <table><thead><tr><th>#</th><th>Author</th><th>Commits</th></tr></thead>
          <tbody>
            ${p.y2025.human.top.map((t,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(t.author)}</td><td>${t.commits}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No data</td></tr>`}
          </tbody>
        </table>
        <div class="muted" style="margin-top:6px">Repo: <a href="${p.meta.html_url}">${p.meta.full_name}</a></div>
      </div>`).join("")}
    </div>
  </section>
</main>

<footer>Counting method matches GitHub Insights: per-committer sums with bot/service accounts excluded. Merges included. 2025 fixed through Oct 31.</footer>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js" defer></script>
<script>
(function () {
  const DATA = ${dataJSON};

  function ctx(id){ const el=document.getElementById(id); return el?el.getContext('2d'):null; }
  function bar(c,aLabel,a,bLabel,b){
    if(!c||!window.Chart) return;
    new Chart(c,{type:'bar',data:{labels:DATA.labels,datasets:[
      {label:String(DATA.YEAR_A),data:a},
      {label:String(DATA.YEAR_B)+' (YTD)',data:b}
    ]},options:{responsive:true,plugins:{legend:{labels:{color:'#e7e8ea'}}},scales:{x:{ticks:{color:'#e7e8ea'}},y:{ticks:{color:'#e7e8ea'}}}}});
  }
  function start(){
    bar(ctx('commitsBar'),'Commits',DATA.commitsA,'Commits',DATA.commitsB);
    bar(ctx('devsBar'),'Contribs',DATA.devsA,'Contribs',DATA.devsB);
    const f=ctx('forksBar'); if(f) new Chart(f,{type:'bar',data:{labels:DATA.labels,datasets:[{label:'Forks',data:DATA.forks}]},options:{responsive:true,plugins:{legend:{labels:{color:'#e7e8ea'}}},scales:{x:{ticks:{color:'#e7e8ea'}},y:{ticks:{color:'#e7e8ea'}}}}});
    const months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    for (const proj of DATA.perProjectMonthly){
      const el=document.getElementById('mini-'+proj.label.toLowerCase());
      if(!el) continue;
      new Chart(el.getContext('2d'),{type:'line',data:{labels:months,datasets:[
        {label:String(DATA.YEAR_A),data:proj.m2024,tension:.25},
        {label:String(DATA.YEAR_B)+' (YTD)',data:proj.m2025,tension:.25}
      ]},options:{responsive:true,plugins:{legend:{labels:{color:'#e7e8ea'}}},scales:{x:{ticks:{color:'#e7e8ea'}},y:{ticks:{color:'#e7e8ea'}}}}});
    }
  }
  if(document.readyState==='complete') start(); else window.addEventListener('load', start);
})();
</script>
</body></html>`;
}

/* ============================== MAIN ============================== */

function ymdISO(y, m, d, end=false){
  return new Date(Date.UTC(y, m-1, d, end?23:0, end?59:0, end?59:0)).toISOString();
}

(async () => {
  await loadExternalDeny();

  const outDir = path.join(process.cwd(), "docs");
  await fs.mkdir(outDir, { recursive: true });

  const results = [];
  const verify = [];

  for (const p of PROJECTS) {
    const [owner, repo] = p.slug.split("/");
    const meta = await repoMeta(owner, repo);
    const branch = meta.default_branch || "main";

    // Pull commits once per year window, scoped to default branch
    const c2024 = [];
    for await (const c of listCommits(owner, repo, ymdISO(2024,1,1), ymdISO(2024,12,31,true), branch)) c2024.push(c);
    const c2025 = [];
    for await (const c of listCommits(owner, repo, ymdISO(2025,1,1), YTD_CUTOFF.toISOString(), branch)) c2025.push(c);

    const a2024 = aggregateInsightsStyle(c2024, p.slug, MONTHS_A, 2024);
    const a2025 = aggregateInsightsStyle(c2025, p.slug, MONTHS_B, 2025);

    results.push({
      id: p.label.toLowerCase(),
      label: p.label,
      meta,
      y2024: a2024,
      y2025: a2025
    });

    verify.push({
      repo: p.slug,
      branch,
      windows: { y2024: "2024-01-01..2024-12-31", y2025: "2025-01-01..2025-10-31" },
      // what the charts use:
      human_totals: { "2024": a2024.human.total, "2025_YTD": a2025.human.total },
      human_unique: { "2024": a2024.human.unique, "2025_YTD": a2025.human.unique },
      // extra info:
      all_totals: { "2024": a2024.all.total, "2025_YTD": a2025.all.total },
      deny_applied: REPO_DENY[p.slug] || []
    });
  }

  const html = renderHTML(results);
  await fs.writeFile(path.join(outDir, "index.html"), html, "utf8");
  await fs.writeFile(path.join(outDir, "verification.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results: verify }, null, 2), "utf8");

  console.log("Wrote docs/index.html and docs/verification.json");
})();
