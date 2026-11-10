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
  const token = process.env.GITHUB_TOKEN || '';
  const ongoingThresholdDays = Number(profile.ongoingThresholdDays) || 90;
  const portfolioTopic = (profile.portfolioTopic || 'portfolio').toLowerCase();
  const requireTopic = Boolean(profile.requirePortfolioTopic);

  console.log(`Fetching public repositories for @${username}...`);

  let rawRepos = [];
  try {
    rawRepos =
      (await githubFetch(
        `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed`,
        token
      )) || [];
  } catch (err) {
    console.warn(`Could not reach GitHub API (${err.message}). Keeping existing projects.json.`);
    return;
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
    console.log(`Processing repo: ${repo.name}...`);

    // 1. Fetch README
    let readmeRaw = null;
    try {
      readmeRaw = await githubFetch(
        `https://api.github.com/repos/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/readme`,
        token,
        'application/vnd.github.raw'
      );
    } catch (e) {
      console.warn(`  Warning: Failed to read README for ${repo.name}`);
    }

    const { excerpt, highlights: readmeHighlights } = parseReadme(readmeRaw);

    // 2. Fetch Languages (bytes per language)
    let languages = {};
    try {
      languages =
        (await githubFetch(
          `https://api.github.com/repos/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/languages`,
          token
        )) || {};
    } catch (e) {
      console.warn(`  Warning: Failed to read languages for ${repo.name}`);
    }

    if (Object.keys(languages).length === 0 && repo.language) {
      languages = { [repo.language]: 10000 };
    }

    // 3. Determine Ongoing vs Completed
    const daysSincePush = Math.max(
      0,
      (Date.now() - new Date(repo.pushed_at).getTime()) / (1000 * 60 * 60 * 24)
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

    fetchedProjects.push({
      id: repo.name,
      name: repo.name,
      title: override.title || repo.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      role: override.role || (isOngoing ? 'Active Development' : 'Creator & Maintainer'),
      description,
      readmeExcerpt: excerpt || repo.description || description,
      highlights,
      createdAt: repo.created_at,
      pushedAt: repo.pushed_at,
      dateLabel: override.dateLabel || buildDateLabel(repo.created_at, repo.pushed_at, isOngoing),
      isOngoing,
      featured: typeof override.featured === 'boolean' ? override.featured : repo.stargazers_count > 0,
      isPrivate: typeof override.isPrivate === 'boolean' ? override.isPrivate : Boolean(repo.private),
      privateMessage: override.privateMessage || '',
      htmlUrl: override.isPrivate ? '' : (override.htmlUrl || repo.html_url || `https://github.com/${username}/${repo.name}`),
      homepage: override.demoUrl || repo.homepage || '',
      topics: repo.topics || [],
      techStack,
      stars: repo.stargazers_count || 0,
      forks: repo.forks_count || 0,
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
        title: override.title || p.title,
        isPrivate: typeof override.isPrivate === 'boolean' ? override.isPrivate : Boolean(p.isPrivate),
        privateMessage: override.privateMessage || p.privateMessage || ''
      };
    });

  const allProjects = [...fetchedProjects, ...preservedCvProjects].sort((a, b) => {
    if (a.isOngoing !== b.isOngoing) return a.isOngoing ? -1 : 1;
    return new Date(b.pushedAt).getTime() - new Date(a.pushedAt).getTime();
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

  const output = {
    generatedAt: new Date().toISOString(),
    username,
    totalRepos: allProjects.length,
    ongoingCount,
    completedCount,
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

