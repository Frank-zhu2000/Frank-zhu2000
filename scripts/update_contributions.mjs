import fs from 'node:fs';

const USERNAME = 'Frank-zhu2000';
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error('Error: GITHUB_TOKEN environment variable is required.');
  process.exit(1);
}

const README_PATH = new URL('../README.md', import.meta.url);
const HISTORICAL_PATH = new URL('../.github/historical-contributions.json', import.meta.url);

const PR_QUERY = `
query($login: String!, $cursor: String) {
  user(login: $login) {
    pullRequests(first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        number
        title
        state
        createdAt
        mergedAt
        url
        repository {
          nameWithOwner
          stargazerCount
          isPrivate
        }
      }
    }
  }
}
`;

async function githubGraphQL(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Frank-zhu2000-profile-updater',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub GraphQL HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function fetchRepoMetaRest(ownerRepo, fallbackStars) {
  try {
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Frank-zhu2000-profile-updater',
      },
    });
    if (!res.ok) return { repo: ownerRepo, stars: fallbackStars };
    const data = await res.json();
    return {
      repo: data.full_name || ownerRepo,
      stars: typeof data.stargazers_count === 'number' ? data.stargazers_count : fallbackStars,
    };
  } catch {
    return { repo: ownerRepo, stars: fallbackStars };
  }
}

async function fetchAllExternalPRs() {
  let cursor = null;
  const nodes = [];

  for (let page = 0; page < 20; page++) {
    const data = await githubGraphQL(PR_QUERY, { login: USERNAME, cursor });
    const conn = data?.user?.pullRequests;
    if (!conn) break;

    for (const pr of conn.nodes) {
      if (!pr?.repository) continue;
      if (pr.repository.isPrivate) continue;
      if (pr.repository.nameWithOwner.toLowerCase().startsWith(`${USERNAME.toLowerCase()}/`)) continue;
      nodes.push(pr);
    }

    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return nodes;
}

const ORG_CONFIG = {
  tencent: { key: 'tencent', label: 'Tencent 腾讯', shortTag: '腾讯', color: '0052D9', logo: null },
  tencentcloud: { key: 'tencent', label: 'Tencent 腾讯', shortTag: '腾讯', color: '0052D9', logo: null },
  alibaba: { key: 'alibaba', label: 'Alibaba 阿里', shortTag: '阿里', color: 'FF6A00', logo: 'alibabadotcom' },
  'agentscope-ai': { key: 'alibaba', label: 'Alibaba 阿里', shortTag: '阿里', color: 'FF6A00', logo: 'alibabadotcom' },
  'thu-maic': { key: 'tsinghua', label: 'Tsinghua 清华', shortTag: '清华', color: '660874', logo: null },
  hkuds: { key: 'hku', label: 'HKU 港大', shortTag: '港大', color: '006B54', logo: null },
};

const ORG_DISPLAY_ORDER = [
  ORG_CONFIG.tencent,
  ORG_CONFIG.alibaba,
  ORG_CONFIG['thu-maic'],
  ORG_CONFIG.hkuds,
];

function getOrgInfo(repoFullName) {
  const owner = String(repoFullName || '').split('/')[0].toLowerCase();
  return ORG_CONFIG[owner] || null;
}

function renderRepoCell(repoFullName) {
  const owner = String(repoFullName || '').split('/')[0];
  const avatar = `<img src="https://github.com/${owner}.png?size=40" width="18" height="18" align="absmiddle" alt="${owner}" />`;
  const org = getOrgInfo(repoFullName);
  const tag = org
    ? ` <img src="https://img.shields.io/badge/${encodeURIComponent(org.shortTag)}-${org.color}?style=flat-square" height="16" align="absmiddle" alt="${org.shortTag}" />`
    : '';
  return `${avatar} [${repoFullName}](https://github.com/${repoFullName})${tag}`;
}

function formatStars(count) {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

function escapeCell(text) {
  return String(text || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function pickRepresentativePR(liveMergedPrs, historicalRep) {
  if (!liveMergedPrs.length) return historicalRep;
  const sorted = [...liveMergedPrs].sort((a, b) => (b.mergedAt || '').localeCompare(a.mergedAt || ''));
  const nonDocs = sorted.find((pr) => !/^docs(?:\([^)]*\))?:/i.test(pr.title || ''));
  return nonDocs || sorted[0];
}

function replaceMarkerBlock(content, markerName, replacement) {
  const startTag = `<!-- ${markerName}:START -->`;
  const endTag = `<!-- ${markerName}:END -->`;
  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Missing or malformed marker pair for ${markerName}`);
  }

  const before = content.slice(0, startIdx + startTag.length);
  const after = content.slice(endIdx);
  return `${before}${replacement}${after}`;
}

async function main() {
  const historical = JSON.parse(fs.readFileSync(HISTORICAL_PATH, 'utf8'));
  const readmeRaw = fs.readFileSync(README_PATH, 'utf8');
  const lineEnding = readmeRaw.includes('\r\n') ? '\r\n' : '\n';

  const allPRs = await fetchAllExternalPRs();
  const liveMergedPRs = allPRs.filter((pr) => pr.state === 'MERGED');
  const liveOpenPRs = allPRs.filter((pr) => pr.state === 'OPEN');

  // Seed live repo metadata cache from all PRs returned
  const repoCache = new Map();
  for (const pr of allPRs) {
    const key = pr.repository.nameWithOwner.toLowerCase();
    repoCache.set(key, {
      repo: pr.repository.nameWithOwner,
      stars: pr.repository.stargazerCount,
    });
  }

  // Resolve live stars for any historical repo not already cached
  for (const h of historical) {
    const key = h.repo.toLowerCase();
    if (!repoCache.has(key)) {
      const meta = await fetchRepoMetaRest(h.repo, h.fallbackStars || 0);
      repoCache.set(key, meta);
    }
  }

  // Aggregate merged contributions by repo
  const mergedByRepo = new Map();

  for (const h of historical) {
    const key = h.repo.toLowerCase();
    const meta = repoCache.get(key) || { repo: h.repo, stars: h.fallbackStars || 0 };
    mergedByRepo.set(key, {
      repo: meta.repo,
      stars: meta.stars,
      historicalCount: h.count,
      historicalRep: h.representative,
      liveMergedPrs: [],
    });
  }

  for (const pr of liveMergedPRs) {
    const key = pr.repository.nameWithOwner.toLowerCase();
    if (!mergedByRepo.has(key)) {
      mergedByRepo.set(key, {
        repo: pr.repository.nameWithOwner,
        stars: pr.repository.stargazerCount,
        historicalCount: 0,
        historicalRep: null,
        liveMergedPrs: [],
      });
    }
    const entry = mergedByRepo.get(key);
    entry.stars = pr.repository.stargazerCount;
    entry.repo = pr.repository.nameWithOwner;
    // Avoid double-counting if historical representative PR were ever the same number
    if (!entry.historicalRep || entry.historicalRep.number !== pr.number) {
      entry.liveMergedPrs.push({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        mergedAt: (pr.mergedAt || pr.createdAt || '').slice(0, 10),
        repo: pr.repository.nameWithOwner,
        stars: pr.repository.stargazerCount,
      });
    }
  }

  const mergedRepos = [...mergedByRepo.values()]
    .map((entry) => ({
      ...entry,
      mergedCount: entry.historicalCount + entry.liveMergedPrs.length,
      representative: pickRepresentativePR(entry.liveMergedPrs, entry.historicalRep),
    }))
    .sort((a, b) => b.stars - a.stars || b.mergedCount - a.mergedCount || a.repo.localeCompare(b.repo));

  const totalMerged = mergedRepos.reduce((sum, r) => sum + r.mergedCount, 0);
  const totalRepos = mergedRepos.length;
  const totalStars = mergedRepos.reduce((sum, r) => sum + (r.stars || 0), 0);
  const totalStarsLabel = `${Math.floor(totalStars / 1000)}k+`;
  const historicalTotal = historical.reduce((sum, h) => sum + h.count, 0);

  // Build sorted list of all live merged PRs for Drawer 1
  const allLiveMergedFlat = liveMergedPRs
    .map((pr) => ({
      mergedAt: (pr.mergedAt || pr.createdAt || '').slice(0, 10),
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      title: pr.title,
      url: pr.url,
    }))
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || b.number - a.number);

  // Build sorted list of historical archive entries using live stars
  const historicalRows = historical
    .map((h) => {
      const meta = repoCache.get(h.repo.toLowerCase()) || { repo: h.repo, stars: h.fallbackStars || 0 };
      return {
        repo: meta.repo,
        stars: meta.stars,
        count: h.count,
        rep: h.representative,
      };
    })
    .sort((a, b) => b.stars - a.stars || b.count - a.count || a.repo.localeCompare(b.repo));

  // Build sorted list of Open PRs for Drawer 2
  const openPRsSorted = liveOpenPRs
    .map((pr) => ({
      repo: pr.repository.nameWithOwner,
      stars: pr.repository.stargazerCount,
      createdAt: (pr.createdAt || '').slice(0, 10),
      number: pr.number,
      title: pr.title,
      url: pr.url,
    }))
    .sort((a, b) => b.stars - a.stars || b.createdAt.localeCompare(a.createdAt) || b.number - a.number);

  const openReposCount = new Set(openPRsSorted.map((p) => p.repo.toLowerCase())).size;

  // Render marker 1: Header Badge
  const badgeMsg = encodeURIComponent(`${totalMerged} Merged · ${totalStarsLabel}★`);
  const badgeBlock = `<img src="https://img.shields.io/badge/OSS%20PRs-${badgeMsg}-0ea5e9?style=flat-square&logo=github" alt="OSS PRs" />`;

  // Render marker 2: About Me OSS highlight & Org Badges
  const aboutStatBlock = `**${totalMerged} 个已合并 PR · ${totalRepos} 个仓库 · ${totalStarsLabel} Stars 生态**`;

  const orgCounts = {};
  for (const r of mergedRepos) {
    const org = getOrgInfo(r.repo);
    if (org) {
      orgCounts[org.key] = (orgCounts[org.key] || 0) + r.mergedCount;
    }
  }

  const orgBadgesBlock = ORG_DISPLAY_ORDER.filter((org) => (orgCounts[org.key] || 0) > 0)
    .map((org) => {
      const count = orgCounts[org.key];
      const logoPart = org.logo ? `&logo=${org.logo}&logoColor=white` : '';
      return `<img src="https://img.shields.io/badge/${encodeURIComponent(org.label)}-${count}%20PRs-1e293b?style=flat-square&labelColor=${org.color}${logoPart}" alt="${org.label}" />`;
    })
    .join(' ');

  // Render marker 3: Full Contributions section
  const mainRows = mergedRepos
    .map(
      (r) =>
        `| ${renderRepoCell(r.repo)} | ${formatStars(r.stars)} | ${r.mergedCount} | [#${r.representative.number} ${escapeCell(r.representative.title)}](${r.representative.url}) |`
    )
    .join('\n');

  const liveDetailRows = allLiveMergedFlat
    .map(
      (pr) =>
        `| ${pr.mergedAt} | ${renderRepoCell(pr.repo)} | [#${pr.number} ${escapeCell(pr.title)}](${pr.url}) |`
    )
    .join('\n');

  const histDetailRows = historicalRows
    .map(
      (h) =>
        `| ${renderRepoCell(h.repo)} | ${formatStars(h.stars)} | ${h.count} | [#${h.rep.number} ${escapeCell(h.rep.title)}](${h.rep.url}) |`
    )
    .join('\n');

  const openDetailRows = openPRsSorted
    .map(
      (pr) =>
        `| ${renderRepoCell(pr.repo)} | ${formatStars(pr.stars)} | ${pr.createdAt} | [#${pr.number} ${escapeCell(pr.title)}](${pr.url}) |`
    )
    .join('\n');

  const openSection = openPRsSorted.length
    ? `\n\n<details>\n<summary>🔄 展开查看评审中 Open PR（${openPRsSorted.length} 条 · 覆盖 ${openReposCount} 个仓库，合入后自动晋升至主表）</summary>\n\n| 仓库 | ⭐ Stars | 提交日期 | PR |\n| :--- | :---: | :---: | :--- |\n${openDetailRows}\n\n</details>`
    : '';

  const contributionsBlock = `
> 累计向 **腾讯（Tencent）**、**阿里（Alibaba / AgentScope）**、**清华大学（THU-MAIC）**、**香港大学（HKUDS）** 等知名企业、高校实验室与高星开源社区贡献 **${totalMerged}** 个已合并 PR，覆盖 **${totalRepos}** 个开源项目，上游生态累计 **${totalStarsLabel} Stars** · 每日由 GitHub Actions 自动同步。

| 仓库 | ⭐ Stars | 已合并 PR | 代表 PR |
| :--- | :---: | :---: | :--- |
${mainRows}

<details>
<summary>📂 展开查看全部已合并 PR 完整明细（${allLiveMergedFlat.length} 条实时记录 + ${historicalRows.length} 条历史归档代表记录）</summary>

#### 近期实时已合并 PR（${allLiveMergedFlat.length} 条）

| 合并日期 | 仓库 | PR |
| :---: | :--- | :--- |
${liveDetailRows}

#### 早期历史归档代表记录（${historicalTotal} PR · ${historicalRows.length} 仓库）

| 仓库 | ⭐ Stars | 历史合并数 | 代表 PR |
| :--- | :---: | :---: | :--- |
${histDetailRows}

</details>${openSection}
`;

  let next = readmeRaw;
  next = replaceMarkerBlock(next, 'OSS_BADGE', badgeBlock);
  next = replaceMarkerBlock(next, 'ABOUT_OSS_STAT', aboutStatBlock);
  next = replaceMarkerBlock(next, 'ORG_BADGES', orgBadgesBlock);
  next = replaceMarkerBlock(next, 'CONTRIBUTIONS', contributionsBlock);

  if (lineEnding === '\r\n') {
    next = next.replace(/\r?\n/g, '\r\n');
  }

  fs.writeFileSync(README_PATH, next, 'utf8');
  console.log(
    JSON.stringify(
      {
        totalMerged,
        totalRepos,
        totalStarsLabel,
        liveMergedCount: allLiveMergedFlat.length,
        historicalTotal,
        openCount: openPRsSorted.length,
        openReposCount,
        orgCounts,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
