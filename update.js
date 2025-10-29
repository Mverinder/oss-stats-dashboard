// update.js — generates docs/index.html with 2024 vs 2025 stats
// Node 20+ (built-in fetch). No external deps required for the build script.
// Charts are client-side via Chart.js CDN in the generated HTML.

import fs from "node:fs/promises";
import path from "node:path";

// === Configure the tracked projects here ===
const PROJECTS = [
  { label: "Playwright", slug: "microsoft/playwright" },
  { label: "Selenium",   slug: "SeleniumHQ/selenium" },
  { label: "JMeter",     slug: "apache/jmeter" },
  { label: "Cypress",    slug: "cypress-io/cypress" }
];

// Years to compare
const YEAR_A = 2024;
const YEAR_B = 2025;

// Treat 2025 as YTD (use current date to determine months elapsed)
const NOW = new Date();

// ---- Helpers ----
function iso(y, m = 1, d = 1) {
  return new Date(Date.UTC(y, m - 1, d)).toISOString();
}

function endOfYearISO(y) {
  return new Date(Date.UTC(y, 11, 31, 23, 59, 59)).toISOString();
}

function monthsElapsedInYear(y, refDate) {
  if (y < refDate.getUTCFullYear()) return 12;
  if (y > refDate.getUTCFullYear()) return 0;
  return refDate.getUTCMonth() + 1;
}

function isBotCommit(c) {
  const login = c.author?.login || "";
  const authorType = c.author?.type || "";
  const name = (c.commit?.author?.name || "").toLowerCase();
  const email = (c.commit?.author?.email || "").toLowerCase();
  if (authorType === "Bot") return true;
  if (/\[bot\]$/i.test(login)) return true;
  if (/bot/.test(name)) return true;
  if (/bot/.test(email)) return true;
  return false;
}

function authorId(c) {
  return c.author?.login || (c.commit?.author?.email || c.commit?.author?.name || "unknown");
}

async function gh(endpoint) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "oss-stats-dashboard"
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.PAT;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${endpoint}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} for ${endpoint}: ${body}`);
  }
  return res;
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
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "oss-stats-dashboard"
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.PAT;
  if (token) headers.Authorization = `Bearer ${token}`;

  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status} for ${url}: ${body}`);
    }
    const page = await res.json();
    items.push(...page);
    const links = parseLinkHeader(res.headers.get("link"));
    url = links.next || null;
  }
  return items;
}

async function fetchRepoMeta(owner, repo) {
  const res = await gh(`/repos/${owner}/${repo}`);
  return res.json();
}

async function fetchCommitsForRange(owner, repo, sinceISO, untilISO) {
  const perPage = 100;
  const endpoint = `/repos/${owner}/${repo}/commits?per_page=${perPage}&since=${encodeURIComponent(sinceISO)}&until=${encodeURIComponent(untilISO)}`;
  return ghPaginated(endpoint);
}

function aggregateYear(commits, year) {
  const list = commits.filter(c => {
    const t = c.commit?.author?.date;
    if (!t) return false;
    const d = new Date(t);
    return d.getUTCFullYear() === year;
  });

  const totalCommits = list.length;

  const monthly = Array.from({ length: 12 }, () => 0);
  for (const c of list) {
    const d = new Date(c.commit.author.date);
    monthly[d.getUTCMonth()]++;
  }

  const devs = new Set();
  for (const c of list) {
    if (!isBotCommit(c)) devs.add(authorId(c));
  }
  const uniqueDevs = devs.size;

  const elapsed = monthsElapsedInYear(year, NOW) || 12;
  const avgPerMonth = elapsed ? Math.round((totalCommits / elapsed) * 100) / 100 : 0;

  const counts = new Map();
  for (const c of list) {
    if (isBotCommit(c)) continue;
    const id = authorId(c);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, n]) => ({ author: id, commits: n }));

  return { totalCommits, monthly, avgPerMonth, uniqueDevs, top };
}

function renderHTML(snapshot) {
  const generatedAt = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  const labels = snapshot.map(p => p.label);
  const commits2024 = snapshot.map(p => p[2024].totalCommits);
  const commits2025 = snapshot.map(p => p[2025].totalCommits);
  const devs2024 = snapshot.map(p => p[2024].uniqueDevs);
  const devs2025 = snapshot.map(p => p[2025].uniqueDevs);
  const forks = snapshot.map(p => p.meta.forks_count);

  const perProjectMonthly = snapshot.map(p => ({
    label: p.label,
    m2024: p[2024].monthly,
    m2025: p[2025].monthly
  }));

  const htmlSafe = JSON.stringify({ labels, commits2024, commits2025, devs2024, devs2025, forks, perProjectMonthly, YEAR_A: 2024, YEAR_B: 2025 });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Open-Source Testing: 2024 vs 2025</title>
  <meta name="description" content="Daily-updated dashboard comparing Playwright, Selenium, JMeter, and Cypress across commits, contributors, forks, and top committers." />
  <link rel="preconnect" href="https://cdn.jsdelivr.net">
  <style>
    :root { --bg:#0f1116; --panel:#161a23; --text:#e7e8ea; --muted:#9aa0ac; --accent:#5aa2ff; --border:#2a2f3a; }
    * { box-sizing: border-box; }
    html,body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 Inter, system-ui, Segoe UI, Roboto, Arial, sans-serif; }
    header { position:sticky; top:0; z-index:10; background:rgba(15,17,22,.9); backdrop-filter: blur(8px); border-bottom:1px solid var(--border); }
    .wrap { max-width:1150px; margin:0 auto; padding:18px 20px; }
    h1 { margin:0 0 4px; font-size:22px; }
    .sub { color:var(--muted); font-size:13px; }
    main { max-width:1150px; margin:0 auto; padding:22px 20px 36px; display:grid; gap:18px; }
    .grid { display:grid; gap:18px; grid-template-columns: repeat(12, 1fr); }
    .card { grid-column: span 12; background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:16px 16px 18px; }
    .card h2 { margin:0 0 10px; font-size:16px; color:#fff; }
    .kpis { display:grid; grid-template-columns: repeat(12,1fr); gap:12px; }
    .kpi { grid-column: span 3; background:#181d29; border:1px solid var(--border); border-radius:14px; padding:14px; }
    .kpi .label { color:var(--muted); font-size:12px; letter-spacing:.03em; text-transform:uppercase; }
    .kpi .value { font-size:22px; margin-top:6px; }
    @media (max-width: 900px) { .kpi { grid-column: span 6; } }
    @media (max-width: 600px) { .kpi { grid-column: span 12; } }
    .projects { display:grid; gap:14px; grid-template-columns: repeat(12,1fr); }
    .project { grid-column: span 6; background:#181d29; border:1px solid var(--border); border-radius:14px; padding:14px; }
    @media (max-width: 900px) { .project { grid-column: span 12; } }
    .row { display:flex; justify-content:space-between; align-items:baseline; gap:10px; }
    .muted { color:var(--muted); }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    table { width:100%; border-collapse: collapse; }
    th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); }
    th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
    canvas { width:100%; height:360px; }
    .mini { height:220px; }
    footer { color:var(--muted); text-align:center; padding:26px 10px; border-top:1px solid var(--border); }
    .pill { display:inline-block; border:1px solid var(--border); background:#141925; padding:2px 8px; border-radius:999px; font-size:12px; color:var(--muted); }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>Open-Source Testing Dashboard</h1>
      <div class="sub">Daily updates for Playwright, Selenium, JMeter, and Cypress — generated ${generatedAt}.</div>
    </div>
  </header>

  <main>
    <section class="card">
      <h2>Overview</h2>
      <div class="grid">
        <div class="card" style="grid-column: span 12;">
          <div class="row"><div><span class="pill">Commits</span></div></div>
          <canvas id="commitsBar"></canvas>
        </div>
        <div class="card" style="grid-column: span 12;">
          <div class="row"><div><span class="pill">Contributors (Unique Non-Bots)</span></div></div>
          <canvas id="devsBar"></canvas>
        </div>
        <div class="card" style="grid-column: span 12;">
          <div class="row"><div><span class="pill">Forks</span></div></div>
          <canvas id="forksBar"></canvas>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Per-Project Details</h2>
      <div class="projects">
        ${snapshot.map(p => `
          <div class="project">
            <div class="row">
              <h3 style="margin:0;">${p.label}</h3>
              <div class="muted">★ ${p.meta.stargazers_count} • Forks ${p.meta.forks_count}</div>
            </div>
            <div class="kpis" style="margin:10px 0 6px;">
              <div class="kpi">
                <div class="label">${p.YA} Total Commits</div>
                <div class="value">${p[2024].totalCommits.toLocaleString()}</div>
                <div class="muted">Avg/mo: ${p[2024].avgPerMonth}</div>
              </div>
              <div class="kpi">
                <div class="label">${p.YB} Total Commits</div>
                <div class="value">${p[2025].totalCommits.toLocaleString()}</div>
                <div class="muted">Avg/mo (YTD): ${p[2025].avgPerMonth}</div>
              </div>
              <div class="kpi">
                <div class="label">${p.YA} Unique Devs</div>
                <div class="value">${p[2024].uniqueDevs.toLocaleString()}</div>
              </div>
              <div class="kpi">
                <div class="label">${p.YB} Unique Devs</div>
                <div class="value">${p[2025].uniqueDevs.toLocaleString()}</div>
              </div>
            </div>

            <div class="row"><div class="muted">Monthly Commits (${p.YA} vs ${p.YB})</div></div>
            <canvas class="mini" id="mini-${p.id}"></canvas>

            <h4 style="margin:14px 0 6px;">Top 5 Committers (non-bots, ${p.YB} YTD)</h4>
            <table>
              <thead><tr><th>#</th><th>Author</th><th>Commits</th></tr></thead>
              <tbody>
                ${p[2025].top.map((t, i) => `
                  <tr><td>${i+1}</td><td>${escapeHtml(t.author)}</td><td>${t.commits}</td></tr>
                `).join("") || `<tr><td colspan="3" class="muted">No data</td></tr>`}
              </tbody>
            </table>
            <div class="muted" style="margin-top:6px;">Repo: <a href="${p.meta.html_url}">${p.meta.full_name}</a></div>
          </div>
        `).join("")}
      </div>
    </section>
  </main>

  <footer>Built with GitHub Actions + GitHub Pages. Data sources: GitHub REST API.</footer>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    const DATA = ${htmlSafe};

    const ctx1 = document.getElementById('commitsBar').getContext('2d');
    new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: DATA.labels,
        datasets: [
          { label: String(DATA.YEAR_A), data: DATA.commits2024 },
          { label: String(DATA.YEAR_B) + ' (YTD)', data: DATA.commits2025 }
        ]
      },
      options: { responsive:true, plugins:{ legend:{ labels:{ color:'#e7e8ea' } } }, scales:{ x:{ ticks:{ color:'#e7e8ea' } }, y:{ ticks:{ color:'#e7e8ea' } } } }
    });

    const ctx2 = document.getElementById('devsBar').getContext('2d');
    new Chart(ctx2, {
      type: 'bar',
      data: {
        labels: DATA.labels,
        datasets: [
          { label: String(DATA.YEAR_A), data: DATA.devs2024 },
          { label: String(DATA.YEAR_B) + ' (YTD)', data: DATA.devs2025 }
        ]
      },
      options: { responsive:true, plugins:{ legend:{ labels:{ color:'#e7e8ea' } } }, scales:{ x:{ ticks:{ color:'#e7e8ea' } }, y:{ ticks:{ color:'#e7e8ea' } } } }
    });

    const ctx3 = document.getElementById('forksBar').getContext('2d');
    new Chart(ctx3, {
      type: 'bar',
      data: {
        labels: DATA.labels,
        datasets: [{ label: 'Forks', data: DATA.forks }]
      },
      options: { responsive:true, plugins:{ legend:{ labels:{ color:'#e7e8ea' } } }, scales:{ x:{ ticks:{ color:'#e7e8ea' } }, y:{ ticks:{ color:'#e7e8ea' } } } }
    });

    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    for (const proj of DATA.perProjectMonthly) {
      const c = document.getElementById('mini-' + proj.label.toLowerCase());
      if (!c) continue;
      new Chart(c.getContext('2d'), {
        type: 'line',
        data: {
          labels: months,
          datasets: [
            { label: String(DATA.YEAR_A), data: proj.m2024, tension:.25 },
            { label: String(DATA.YEAR_B) + ' (YTD)', data: proj.m2025, tension:.25 }
          ]
        },
        options: { responsive:true, plugins:{ legend:{ labels:{ color:'#e7e8ea' } } }, scales:{ x:{ ticks:{ color:'#e7e8ea' } }, y:{ ticks:{ color:'#e7e8ea' } } } }
      });
    }

    function escapeHtml(s){ return s.replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
  </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}

(async () => {
  const outDir = path.join(process.cwd(), "docs");
  const outFile = path.join(outDir, "index.html");

  const results = [];
  for (const p of PROJECTS) {
    const [owner, repo] = p.slug.split("/");
    const meta = await fetchRepoMeta(owner, repo);

    const since = iso(2024, 1, 1);
    const until = endOfYearISO(2025);
    const commits = await fetchCommitsForRange(owner, repo, since, until);

    const statsA = aggregateYear(commits, 2024);
    const statsB = aggregateYear(commits, 2025);

    const id = p.label.toLowerCase();
    results.push({
      id,
      label: p.label,
      meta,
      2024: statsA,
      2025: statsB,
      YA: 2024,
      YB: 2025
    });
  }

  const html = renderHTML(results);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, html, "utf8");
  console.log("Wrote", outFile);
})();
