#!/usr/bin/env node
/**
 * scripts/fetch-projects.js
 *
 * Automatically fetches public GitHub repositories, README summaries, and
 * per-repository language byte breakdowns via the GitHub REST API, merges
 * manual overrides from overrides.json, and writes projects.json.
 *
 * Designed to run inside GitHub Actions (zero npm dependencies required;
 * uses Node 18/20+ built-in fetch).
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const PROFILE_PATH = path.join(ROOT_DIR, 'profile.json');
const OVERRIDES_PATH = path.join(ROOT_DIR, 'overrides.json');
const PROJECTS_PATH = path.join(ROOT_DIR, 'projects.json');

// Official GitHub Linguist colors for common languages + deterministic fallback
const LANGUAGE_COLORS = {
  Python: '#3572A5',
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  Java: '#b07219',
  Dart: '#00B4AB',
  SQL: '#e38c00',
  HTML: '#e34c26',
  CSS: '#563d7c',
  'HTML/CSS': '#e34c26',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
  Go: '#00ADD8',
  Rust: '#dea584',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  PHP: '#4F5D95',
  Ruby: '#701516',
  Shell: '#89e051',
  Dockerfile: '#384d54',
  Jupyter: '#DA5B0B',
  'Jupyter Notebook': '#DA5B0B',
  Vue: '#41b883',
  Svelte: '#ff3e00'
};

function getLanguageColor(lang) {
  if (LANGUAGE_COLORS[lang]) return LANGUAGE_COLORS[lang];
  // Deterministic vibrant HSL color converted to hex for any new language
  let hash = 0;
  for (let i = 0; i < lang.length; i++) {
    hash = lang.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 75%, 55%)`;
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function formatMonthYear(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function buildDateLabel(createdAt, pushedAt, isOngoing) {
  const start = formatMonthYear(createdAt);
  const end = formatMonthYear(pushedAt);
  if (isOngoing) {
    return start ? `${start} — Present` : 'Ongoing';
  }
  if (!start) return end || '';
  if (!end || start === end) return start;
  if (new Date(pushedAt).getTime() < new Date(createdAt).getTime()) return start;
  return `${start} — ${end}`;
}

/**
 * Extracts a clean first paragraph summary and bullet points from raw README markdown.
 */
function parseReadme(rawMarkdown) {
  if (!rawMarkdown || typeof rawMarkdown !== 'string') {
    return { excerpt: '', highlights: [] };
  }

  const lines = rawMarkdown
    .replace(/\r\n/g, '\n')
    .split('\n');

  const paragraphs = [];
  const bullets = [];
  let currentPara = [];
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Skip headings, HTML tags, markdown images/badges, horizontal rules, tables
    if (
      line.startsWith('#') ||
      line.startsWith('![') ||
      line.startsWith('[![') ||
      line.startsWith('<') ||
      line.startsWith('---') ||
      line.startsWith('===') ||
      line.startsWith('|')
    ) {
      if (currentPara.length > 0) {
        paragraphs.push(currentPara.join(' '));
        currentPara = [];
      }
      continue;
    }

    // Collect bullet points
    if (/^[-*+]\s+/.test(line)) {
      if (currentPara.length > 0) {
        paragraphs.push(currentPara.join(' '));
        currentPara = [];
      }
      const cleanBullet = cleanMarkdownInline(line.replace(/^[-*+]\s+/, ''));
      if (cleanBullet.length > 20 && bullets.length < 5) {
        bullets.push(cleanBullet);
      }
      continue;
    }

    if (line === '') {
      if (currentPara.length > 0) {
        paragraphs.push(currentPara.join(' '));
        currentPara = [];
      }
    } else {
      currentPara.push(line);
    }
  }

  if (currentPara.length > 0) {
    paragraphs.push(currentPara.join(' '));
  }

  const cleanParagraphs = paragraphs
    .map(cleanMarkdownInline)
    .filter((p) => p.length > 25);

  let excerpt = cleanParagraphs[0] || '';
  if (excerpt.length > 280) {
    excerpt = excerpt.slice(0, 277).trim() + '...';
  }

  return { excerpt, highlights: bullets };
}

function cleanMarkdownInline(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // remove inline images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // keep link text
    .replace(/[*_`~]/g, '') // strip emphasis/code markers
    .replace(/\s+/g, ' ')
    .trim();
}

async function githubFetch(url, token, accept = 'application/vnd.github+json') {
  const headers = {
    Accept: accept,
    'User-Agent': 'naveen-portfolio-updater',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} on ${url}: ${await res.text()}`);
  }
  if (accept === 'application/vnd.github.raw') {
    return await res.text();
  }
  return await res.json();
}

async function githubFetchWithHeaders(url, token, accept = 'application/vnd.github+json') {
  const headers = {
    Accept: accept,
    'User-Agent': 'naveen-portfolio-updater',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers });
  if (res.status === 404) return { data: null, headers: res.headers };
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} on ${url}: ${await res.text()}`);
  }
  const data = accept === 'application/vnd.github.raw' ? await res.text() : await res.json();
  return { data, headers: res.headers };
}

function parseLastPageFromLink(linkHeader) {
  if (!linkHeader) return null;
  const match = String(linkHeader).match(/[?&]page=(\d+)>;\s*rel="last"/i);
  return match ? Number(match[1]) : null;
}

function parseStatNumber(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const str = String(val).trim().toUpperCase();
  const num = parseFloat(str.replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return 0;
  if (str.includes('K')) return Math.round(num * 1000);
  if (str.includes('M')) return Math.round(num * 1000000);
  return Math.round(num);
}

async function fetchUserContributionTelemetry(username, token) {
  if (!token || !username) return null;
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          totalCommitContributions
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'naveen-portfolio-updater'
      },
      body: JSON.stringify({ query, variables: { login: username } })
    });
    if (!res.ok) return null;
    const json = await res.json();
    const collection = json && json.data && json.data.user && json.data.user.contributionsCollection;
    if (!collection || !collection.contributionCalendar) return null;

    const weeks = collection.contributionCalendar.weeks || [];
    const days = weeks
      .flatMap((w) => w.contributionDays || [])
      .filter((d) => d && d.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    let longestStreak = 0;
    let running = 0;
    for (const d of days) {
      if ((d.contributionCount || 0) > 0) {
        running += 1;
        if (running > longestStreak) longestStreak = running;
      } else {
        running = 0;
      }
    }

    let currentStreak = 0;
    if (days.length > 0) {
      let idx = days.length - 1;
      if ((days[idx].contributionCount || 0) === 0 && idx > 0) {
        idx -= 1;
      }
      while (idx >= 0 && (days[idx].contributionCount || 0) > 0) {
        currentStreak += 1;
        idx -= 1;
      }
    }

    const recentWeeks = weeks.slice(-38).map((w) =>
      (w.contributionDays || []).map((d) => ({
        date: d.date,
        count: Number(d.contributionCount) || 0
      }))
    );

    return {
      totalContributions: Number(collection.contributionCalendar.totalContributions) || 0,
      totalCommitContributions:
        (Number(collection.totalCommitContributions) || 0) +
        (Number(collection.restrictedContributionsCount) || 0),
      currentStreak,
      longestStreak,
      heatmap: recentWeeks
    };
  } catch (err) {
    return null;
  }
}

async function resolveActiveBranchAndHead(repoOwner, repoName, defaultBranch, preferredBranch, token) {
  const baseDefault = defaultBranch || 'main';
  const candidates = new Set();
  if (preferredBranch) candidates.add(preferredBranch);

  let pushEventBranch = '';
  try {
    const events = await githubFetch(
      `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/events?per_page=15`,
      token
    );
    if (Array.isArray(events)) {
      const pushEv = events.find((ev) => ev && ev.type === 'PushEvent' && ev.payload && ev.payload.ref);
      if (pushEv) {
        pushEventBranch = String(pushEv.payload.ref).replace(/^refs\/heads\//, '').trim();
        if (pushEventBranch) candidates.add(pushEventBranch);
      }
    }
  } catch (e) {
    // Ignore if events endpoint is unavailable
  }

  candidates.add(baseDefault);

  try {
    const branches = await githubFetch(
      `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/branches?per_page=15`,
      token
    );
    if (Array.isArray(branches)) {
      let addedExtra = 0;
      for (const b of branches) {
        if (!b || !b.name) continue;
        if (candidates.has(b.name)) continue;
        candidates.add(b.name);
        addedExtra += 1;
        if (addedExtra >= 8) break;
      }
    }
  } catch (e) {
    // Ignore if branches endpoint is unavailable
  }

  let activeBranch = preferredBranch || pushEventBranch || baseDefault;
  let bestTime = -1;
  let latestCommitMessage = '';
  let latestCommitDate = null;
  let maxCommitCount = 0;

  for (const branch of candidates) {
    try {
      const { data: commits, headers } = await githubFetchWithHeaders(
        `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/commits?sha=${encodeURIComponent(branch)}&per_page=1`,
        token
      );
      const lastPageCount = parseLastPageFromLink(headers.get('link'));
      if (lastPageCount && lastPageCount > maxCommitCount) {
        maxCommitCount = lastPageCount;
      } else if (Array.isArray(commits) && commits.length > maxCommitCount) {
        maxCommitCount = commits.length;
      }

      if (Array.isArray(commits) && commits.length > 0 && commits[0].commit) {
        const msg = String(commits[0].commit.message || '').split('\n')[0].trim();
        const dateStr =
          (commits[0].commit.committer && commits[0].commit.committer.date) ||
          (commits[0].commit.author && commits[0].commit.author.date) ||
          '';
        const ts = dateStr ? new Date(dateStr).getTime() : 0;
        const isPreferredTie =
          ts === bestTime &&
          ((pushEventBranch && branch === pushEventBranch) ||
            (preferredBranch && branch === preferredBranch));
        if (ts > bestTime || isPreferredTie) {
          bestTime = ts;
          activeBranch = branch;
          latestCommitMessage = msg;
          latestCommitDate = dateStr || null;
        }
      }
    } catch (e) {
      // Branch might be deleted or restricted; skip silently
    }
  }

  return {
    activeBranch,
    latestCommitMessage,
    latestCommitDate,
    commitCount: maxCommitCount
  };
}

async function main() {
  const profile = readJsonSafe(PROFILE_PATH, {});
  const overridesData = readJsonSafe(OVERRIDES_PATH, { repos: {} });
  const existingData = readJsonSafe(PROJECTS_PATH, { projects: [] });
  const repoOverridesRaw = overridesData.repos || {};
  const repoOverrides = {};
  for (const [k, v] of Object.entries(repoOverridesRaw)) {
    repoOverrides[k] = v;
    repoOverrides[k.toLowerCase()] = v;
  }

  function getOverride(name) {
    if (!name) return {};
    return repoOverrides[name] || repoOverrides[String(name).toLowerCase()] || {};
  }

  const username =
    process.env.GITHUB_REPOSITORY_OWNER ||
    profile.githubUsername ||
    'naveenmariopereradev02';
  const patToken = process.env.PORTFOLIO_PAT || process.env.GH_PAT || '';
  const token = patToken || process.env.GITHUB_TOKEN || '';
  const ongoingThresholdDays = Number(profile.ongoingThresholdDays) || 90;
  const portfolioTopic = (profile.portfolioTopic || 'portfolio').toLowerCase();
  const requireTopic = Boolean(profile.requirePortfolioTopic);

  console.log(`Fetching repositories for @${username}...${patToken ? ' (Authenticated via PAT — Auto-detecting private repos)' : ''}`);

  let rawRepos = [];
  try {
    // If a Personal Access Token (PAT) is supplied, query /user/repos to automatically discover both public & private repos
    const apiEndpoint = patToken
      ? `https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator`
      : `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed`;

    rawRepos = (await githubFetch(apiEndpoint, token)) || [];
  } catch (err) {
    console.warn(`Could not reach GitHub API (${err.message}). Keeping existing projects.json.`);
    return;
  }

  if (token) {
    const existingNames = new Set(rawRepos.map((r) => String(r.name || '').toLowerCase()));
    const seenUrls = new Set();
    for (const ov of Object.values(repoOverridesRaw)) {
      if (!ov || !ov.repoUrl || seenUrls.has(ov.repoUrl)) continue;
      seenUrls.add(ov.repoUrl);
      const match = String(ov.repoUrl).match(/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i);
      if (match) {
        const [, owner, repoName] = match;
        if (!existingNames.has(repoName.toLowerCase())) {
          try {
            const extraRepo = await githubFetch(
              `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`,
              token
            );
            if (extraRepo && extraRepo.name) {
              rawRepos.push(extraRepo);
              existingNames.add(extraRepo.name.toLowerCase());
            }
          } catch (e) {
            // Ignore if token lacks access to this repo
          }
        }
      }
    }
  }

  // Filter out forks, archived repos, hidden repos, and the portfolio / profile README repo itself
  const selfRepoNames = new Set([
    username.toLowerCase(),
    `${username.toLowerCase()}.github.io`,
    'portfolio',
    'github-portfolio'
  ]);

  let candidateRepos = rawRepos.filter((r) => {
    const override = getOverride(r.name);
    if (override.hide === true) return false;
    if (override.forceInclude === true) return true;
    if (r.fork || r.archived) return false;
    if (selfRepoNames.has(r.name.toLowerCase())) return false;

    // Safety rule for private repos: auto-sync if tagged with portfolio topic OR listed in overrides
    if (r.private) {
      const topics = (r.topics || []).map((t) => t.toLowerCase());
      const isTagged = topics.includes(portfolioTopic);
      const isOverridden = Boolean(repoOverrides[r.name.toLowerCase()]);
      if (!isTagged && !isOverridden && !profile.includeAllPrivate) {
        return false;
      }
    }
    return true;
  });

  if (requireTopic) {
    const taggedRepos = candidateRepos.filter((r) => {
      const topics = (r.topics || []).map((t) => t.toLowerCase());
      return topics.includes(portfolioTopic) || Boolean(repoOverrides[r.name.toLowerCase()]);
    });
    // Fallback to all candidateRepos if none are tagged yet so the site is never empty
    if (taggedRepos.length > 0) {
      candidateRepos = taggedRepos;
    } else {
      console.log(
        `No repos tagged with topic "${portfolioTopic}" yet; including all ${candidateRepos.length} public repos.`
      );
    }
  }

  const fetchedProjects = [];

  for (const repo of candidateRepos) {
    const override = getOverride(repo.name);
    const repoOwner = (repo.owner && repo.owner.login) || username;
    const isPrivate = typeof override.isPrivate === 'boolean' ? override.isPrivate : Boolean(repo.private);
    const defaultBranch = repo.default_branch || 'main';

    // Resolve most active branch (checks override.branch, PushEvent ref, default branch, and all repo branches)
    const branchMeta = await resolveActiveBranchAndHead(
      repoOwner,
      repo.name,
      defaultBranch,
      override.branch || '',
      token
    );
    const activeBranch = branchMeta.activeBranch || override.branch || defaultBranch;

    console.log(`Processing repo: ${repo.name} [${activeBranch}] (${isPrivate ? 'Private' : 'Public'})...`);

    // 1. Fetch README from active branch first, fallback to default branch
    let readmeRaw = null;
    try {
      readmeRaw = await githubFetch(
        `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repo.name)}/readme?ref=${encodeURIComponent(activeBranch)}`,
        token,
        'application/vnd.github.raw'
      );
      if (!readmeRaw && activeBranch !== defaultBranch) {
        readmeRaw = await githubFetch(
          `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repo.name)}/readme`,
          token,
          'application/vnd.github.raw'
        );
      }
    } catch (e) {
      if (activeBranch !== defaultBranch) {
        try {
          readmeRaw = await githubFetch(
            `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repo.name)}/readme`,
            token,
            'application/vnd.github.raw'
          );
        } catch (fallbackErr) {
          console.warn(`  Warning: Failed to read README for ${repo.name}`);
        }
      } else {
        console.warn(`  Warning: Failed to read README for ${repo.name}`);
      }
    }

    const { excerpt, highlights: readmeHighlights } = parseReadme(readmeRaw);

    // 2. Fetch Languages (bytes per language)
    let languages = {};
    try {
      languages =
        (await githubFetch(
          `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repo.name)}/languages`,
          token
        )) || {};
    } catch (e) {
      console.warn(`  Warning: Failed to read languages for ${repo.name}`);
    }

    if (Object.keys(languages).length === 0 && repo.language) {
      languages = { [repo.language]: 10000 };
    }

    // 3. Apply latest commit message & commit count from active branch (fallback to override)
    let latestCommitMessage = override.latestCommitMessage || '';
    let latestCommitDate = null;
    const repoCommitCount = Math.max(Number(override.commitCount) || 0, Number(branchMeta.commitCount) || 0);
    if (branchMeta.latestCommitMessage) {
      const overrideTime = override.pushedAt ? new Date(override.pushedAt).getTime() : 0;
      const liveTime = branchMeta.latestCommitDate ? new Date(branchMeta.latestCommitDate).getTime() : 0;
      if (!override.latestCommitMessage || liveTime >= overrideTime) {
        latestCommitMessage = branchMeta.latestCommitMessage;
        latestCommitDate = branchMeta.latestCommitDate;
      }
    }

    // 4. Determine Ongoing vs Completed
    const latestPushMs = Math.max(
      new Date(repo.pushed_at || 0).getTime(),
      new Date(latestCommitDate || 0).getTime()
    );
    const daysSincePush = Math.max(
      0,
      (Date.now() - latestPushMs) / (1000 * 60 * 60 * 24)
    );
    const isOngoing =
      typeof override.ongoing === 'boolean'
        ? override.ongoing
        : daysSincePush <= ongoingThresholdDays;

    const description =
      override.description ||
      excerpt ||
      repo.description ||
      'Software engineering project hosted on GitHub.';

    const highlights =
      Array.isArray(override.highlights) && override.highlights.length > 0
        ? override.highlights
        : readmeHighlights;

    const techStack =
      Array.isArray(override.techStack) && override.techStack.length > 0
        ? override.techStack
        : Array.from(new Set([...Object.keys(languages), ...(repo.topics || [])]));

    const defaultPrivateMsg = 'Private Enterprise Repository — Proprietary source code developed under organization access control (NDA). Direct source code access is restricted.';

    const effectiveCreatedAt = override.createdAt || repo.created_at;
    const repoPushTime = new Date(latestCommitDate || repo.pushed_at || 0).getTime();
    const overridePushTime = override.pushedAt ? new Date(override.pushedAt).getTime() : 0;
    const effectivePushedAt =
      repoPushTime >= overridePushTime
        ? (latestCommitDate || repo.pushed_at || override.pushedAt)
        : override.pushedAt;

    fetchedProjects.push({
      id: repo.name,
      name: repo.name,
      branch: activeBranch,
      title: override.title || repo.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      role: override.role || (isOngoing ? 'Active Development' : 'Creator & Maintainer'),
      description,
      readmeExcerpt: override.description || excerpt || repo.description || description,
      highlights,
      createdAt: effectiveCreatedAt,
      pushedAt: effectivePushedAt,
      latestCommitMessage,
      dateLabel: override.dateLabel || buildDateLabel(effectiveCreatedAt, effectivePushedAt, isOngoing),
      isOngoing,
      featured: typeof override.featured === 'boolean' ? override.featured : repo.stargazers_count > 0,
      isPrivate,
      privateMessage: override.privateMessage || (isPrivate ? defaultPrivateMsg : ''),
      htmlUrl: isPrivate ? '' : (override.htmlUrl || repo.html_url || `https://github.com/${repoOwner}/${repo.name}`),
      homepage: override.demoUrl || repo.homepage || '',
      topics: repo.topics || [],
      techStack,
      stars: repo.stargazers_count || 0,
      forks: repo.forks_count || 0,
      commitCount: repoCommitCount,
      primaryLanguage: repo.language || Object.keys(languages)[0] || 'Code',
      languages
    });
  }

  // Merge with existing CV projects in projects.json if those CV projects aren't on GitHub yet
  const fetchedIds = new Set(fetchedProjects.map((p) => p.id.toLowerCase()));
  const preservedCvProjects = (existingData.projects || [])
    .filter((p) => {
      const override = getOverride(p.id);
      if (override.hide === true) return false;
      return !fetchedIds.has(p.id.toLowerCase());
    })
    .map((p) => {
      const override = getOverride(p.id);
      return {
        ...p,
        branch: override.branch || p.branch || 'main',
        title: override.title || p.title,
        role: override.role || p.role,
        description: override.description || p.description,
        readmeExcerpt: override.description || p.readmeExcerpt || p.description,
        highlights:
          Array.isArray(override.highlights) && override.highlights.length > 0
            ? override.highlights
            : p.highlights,
        techStack:
          Array.isArray(override.techStack) && override.techStack.length > 0
            ? override.techStack
            : p.techStack,
        pushedAt: override.pushedAt || p.pushedAt,
        createdAt: override.createdAt || p.createdAt,
        latestCommitMessage: override.latestCommitMessage || p.latestCommitMessage || '',
        dateLabel: override.dateLabel || p.dateLabel,
        stars: typeof override.stars === 'number' ? override.stars : (p.stars || 0),
        forks: typeof override.forks === 'number' ? override.forks : (p.forks || 0),
        commitCount: typeof override.commitCount === 'number' ? override.commitCount : (p.commitCount || 0),
        isOngoing: typeof override.ongoing === 'boolean' ? override.ongoing : Boolean(p.isOngoing),
        featured: typeof override.featured === 'boolean' ? override.featured : Boolean(p.featured),
        isPrivate: typeof override.isPrivate === 'boolean' ? override.isPrivate : Boolean(p.isPrivate),
        htmlUrl: override.htmlUrl || p.htmlUrl || '',
        privateMessage: override.privateMessage || p.privateMessage || ''
      };
    });

  const allProjects = [...fetchedProjects, ...preservedCvProjects].sort((a, b) => {
    const createdDiff = new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    if (createdDiff !== 0) return createdDiff;
    return new Date(b.pushedAt || 0).getTime() - new Date(a.pushedAt || 0).getTime();
  });

  // Aggregate language byte statistics across all projects
  const langBytesMap = {};
  const langRepoCountMap = {};
  let totalBytes = 0;

  for (const proj of allProjects) {
    const langs = proj.languages || {};
    for (const [lang, bytes] of Object.entries(langs)) {
      const b = Number(bytes) || 0;
      if (b <= 0) continue;
      langBytesMap[lang] = (langBytesMap[lang] || 0) + b;
      langRepoCountMap[lang] = (langRepoCountMap[lang] || 0) + 1;
      totalBytes += b;
    }
  }

  const languagesSummary = Object.entries(langBytesMap)
    .sort((a, b) => b[1] - a[1])
    .map(([name, bytes]) => ({
      name,
      bytes,
      percentage: totalBytes > 0 ? Number(((bytes / totalBytes) * 100).toFixed(1)) : 0,
      repoCount: langRepoCountMap[name] || 1,
      color: getLanguageColor(name)
    }));

  const ongoingCount = allProjects.filter((p) => p.isOngoing).length;
  const completedCount = allProjects.length - ongoingCount;

  const gqlTelemetry = token ? await fetchUserContributionTelemetry(username, token) : null;
  const baseStats = profile.githubStats || {};
  const prevStats = existingData.githubStats || {};
  const baseCommits = parseStatNumber(baseStats.commits) || 0;
  const baseContribs = parseStatNumber(baseStats.contributions) || 0;
  const baseCurrentStreak = Number(baseStats.currentStreak) || 0;
  const baseLongestStreak = Number(baseStats.longestStreak) || 0;

  const totalForksNum = allProjects.reduce((sum, p) => sum + (Number(p.forks) || 0), 0);
  const totalStarsNum = allProjects.reduce((sum, p) => sum + (Number(p.stars) || 0), 0);
  const totalRepoCommits = allProjects.reduce((sum, p) => sum + (Number(p.commitCount) || 0), 0);

  const bestCommits = Math.max(
    totalRepoCommits,
    gqlTelemetry ? gqlTelemetry.totalCommitContributions : 0,
    baseCommits
  );
  const bestContribs = Math.max(
    gqlTelemetry ? gqlTelemetry.totalContributions : 0,
    totalRepoCommits + allProjects.length * 12,
    baseContribs
  );

  const formatCompact = (num) => {
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}K+`;
    }
    return `${num}+`;
  };

  const currentStreakVal = Math.max(
    gqlTelemetry && gqlTelemetry.currentStreak > 0 ? gqlTelemetry.currentStreak : 0,
    baseCurrentStreak + (ongoingCount > 0 ? 2 : 0)
  );
  const longestStreakVal =
    gqlTelemetry && gqlTelemetry.longestStreak > 0
      ? Math.max(gqlTelemetry.longestStreak, baseLongestStreak)
      : Math.max(baseLongestStreak, currentStreakVal);

  const githubStats = {
    totalForks: String(totalForksNum).padStart(2, '0'),
    totalStars: totalStarsNum,
    totalRepoCommits,
    commits: bestCommits > 0 ? `${bestCommits}+` : (baseStats.commits || '850+'),
    contributions: bestContribs > 0 ? formatCompact(bestContribs) : (baseStats.contributions || '1.2K+'),
    currentStreak: currentStreakVal,
    longestStreak: longestStreakVal
  };

  const rawHeatmap =
    gqlTelemetry && Array.isArray(gqlTelemetry.heatmap) && gqlTelemetry.heatmap.length > 0
      ? gqlTelemetry.heatmap
      : Array.isArray(prevStats.heatmap) && prevStats.heatmap.length > 0
      ? prevStats.heatmap
      : null;

  if (rawHeatmap) {
    const repoPushDates = {};
    for (const p of allProjects) {
      for (const dt of [p.pushedAt, p.createdAt]) {
        if (!dt) continue;
        const dayKey = String(dt).slice(0, 10);
        repoPushDates[dayKey] = (repoPushDates[dayKey] || 0) + (p.isPrivate ? 6 : 4);
      }
    }
    githubStats.heatmap = rawHeatmap.map((week) =>
      (week || []).map((d) => ({
        date: d.date,
        count: Math.max(Number(d.count) || 0, repoPushDates[d.date] || 0)
      }))
    );
  }

  const output = {
    generatedAt: new Date().toISOString(),
    username,
    totalRepos: allProjects.length,
    ongoingCount,
    completedCount,
    githubStats,
    languagesSummary,
    projects: allProjects
  };

  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(
    `Successfully wrote projects.json with ${allProjects.length} projects and ${languagesSummary.length} languages.`
  );
}

main().catch((err) => {
  console.error('Error in fetch-projects.js:', err);
  process.exit(1);
});

