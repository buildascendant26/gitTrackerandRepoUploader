/* ══════════════════════════════════════════════════════════════
   Ascendant 2026 — Repo Tracker backend (Google Apps Script)

   Tracks GitHub repo submissions + post-problem-statement-release
   commit activity for ~30 build-phase teams.

   SETUP INSTRUCTIONS:
   1. https://script.google.com → New Project, paste this whole file in.
   2. Project Settings → Script Properties → add:
        GITHUB_TOKEN     = a GitHub personal access token (public_repo read is enough)
        DASHBOARD_SECRET = a password only you know, gates the dashboard endpoint
   3. Deploy → New deployment → Type: Web app, Execute as: Me, Who has access: Anyone.
   4. Copy the deployed URL into submit.html and dashboard.html (ENDPOINT constant).
   5. In the bound Google Sheet, add a tab named "Config" with the release
      timestamp (ISO 8601, e.g. 2026-07-15T09:00:00Z) in cell B1. Leave it
      blank until you reveal the problem statement — every commit counts as
      pre-release until that cell has a value.
   ══════════════════════════════════════════════════════════════ */

var SUBMISSIONS_SHEET_NAME = 'Submissions';
var CONFIG_SHEET_NAME = 'Config';

/* ─── PURE LOGIC (no GAS globals — unit tested in repo-tracker-backend.test.js) ─── */

function parseRepoUrl(url) {
  if (!url || typeof url !== 'string') return null;
  var match = url.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function validateSubmission(data, existingTeamNames) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'missing submission data' };
  var team = (data.team || '').toString().trim();
  var members = (data.members || '').toString().trim();
  var repoUrl = (data.repoUrl || '').toString().trim();
  if (!team) return { ok: false, error: 'team name is required' };
  if (!members) return { ok: false, error: 'at least one member name is required' };
  if (!repoUrl) return { ok: false, error: 'repo URL is required' };
  if (!parseRepoUrl(repoUrl)) return { ok: false, error: 'repo URL must look like https://github.com/owner/repo' };
  var duplicate = (existingTeamNames || []).some(function (existing) {
    return (existing || '').toString().trim().toLowerCase() === team.toLowerCase();
  });
  if (duplicate) return { ok: false, error: 'team "' + team + '" has already submitted' };
  return { ok: true };
}

function normalizeGithubCommit(apiCommit) {
  var commitInfo = apiCommit.commit || {};
  var authorInfo = commitInfo.author || {};
  var login = apiCommit.author && apiCommit.author.login;
  return {
    sha: apiCommit.sha,
    date: authorInfo.date,
    author: login || authorInfo.email || authorInfo.name || 'unknown',
    message: commitInfo.message || ''
  };
}

function splitCommitsByRelease(commits, releaseIso) {
  var releaseTime = releaseIso ? new Date(releaseIso).getTime() : null;
  var pre = [];
  var post = [];
  commits.forEach(function (commit) {
    var t = new Date(commit.date).getTime();
    if (releaseTime !== null && t >= releaseTime) {
      post.push(commit);
    } else {
      pre.push(commit);
    }
  });
  return { preCommits: pre, postCommits: post };
}

function countContributors(commits) {
  var seen = {};
  commits.forEach(function (commit) { seen[commit.author] = true; });
  return Object.keys(seen).length;
}

function buildTeamStats(commits, releaseIso) {
  var split = splitCommitsByRelease(commits, releaseIso);
  var lastCommitTime = commits.reduce(function (latest, commit) {
    var t = new Date(commit.date).getTime();
    return t > latest ? t : latest;
  }, 0);
  return {
    totalCommits: commits.length,
    preRelease: split.preCommits.length,
    postRelease: split.postCommits.length,
    contributorCount: countContributors(commits),
    lastCommitTime: commits.length ? new Date(lastCommitTime).toISOString() : null
  };
}

/* ─── GAS GLUE: submission sheet + doPost ─── */

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSubmissionsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SUBMISSIONS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SUBMISSIONS_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'Team', 'Members', 'RepoURL']);
  }
  return sheet;
}

function getSubmissionsRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SUBMISSIONS_SHEET_NAME);
  if (!sheet) return [];
  return sheet.getDataRange().getValues().slice(1);
}

function doPost(e) {
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput({ status: 'error', message: 'invalid JSON body' });
  }
  if (data && data.action === 'release') {
    return handleReleaseAction(data);
  }
  var existingTeamNames = getSubmissionsRows().map(function (row) { return row[1]; });
  var validation = validateSubmission(data, existingTeamNames);
  if (!validation.ok) {
    return jsonOutput({ status: 'error', message: validation.error });
  }
  var sheet = getOrCreateSubmissionsSheet();
  sheet.appendRow([new Date(), data.team, data.members, data.repoUrl]);
  return jsonOutput({ status: 'success', message: 'submission recorded' });
}

/* ─── GAS GLUE: config + GitHub fetch + doGet ─── */

function getOrCreateConfigSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG_SHEET_NAME);
  }
  return sheet;
}

function setReleaseTimestampIso(iso) {
  getOrCreateConfigSheet().getRange('B1').setValue(iso);
}

// Dashboard-secret-gated: stamps Config!B1 with the current time so every
// commit from this moment on counts as post-release ("current") instead of
// pre-release ("past"). See splitCommitsByRelease.
function handleReleaseAction(data) {
  var secret = PropertiesService.getScriptProperties().getProperty('DASHBOARD_SECRET');
  if (!secret || data.secret !== secret) {
    return jsonOutput({ status: 'error', message: 'unauthorized' });
  }
  var iso = new Date().toISOString();
  setReleaseTimestampIso(iso);
  return jsonOutput({ status: 'success', releaseTimestamp: iso });
}

function getReleaseTimestampIso() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) return null;
  var val = sheet.getRange('B1').getValue();
  if (!val) return null;
  return (val instanceof Date) ? val.toISOString() : new Date(val).toISOString();
}

function fetchAllCommits(owner, repo, token) {
  var perPage = 100;
  var maxPages = 5; // caps at 500 commits per repo, far beyond a hackathon build window
  var all = [];
  for (var page = 1; page <= maxPages; page++) {
    var url = 'https://api.github.com/repos/' + owner + '/' + repo + '/commits?per_page=' + perPage + '&page=' + page;
    var response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'token ' + token, 'User-Agent': 'ascendant2026-repo-tracker' },
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code !== 200) {
      throw new Error('GitHub API error ' + code + ' for ' + owner + '/' + repo);
    }
    var batch = JSON.parse(response.getContentText());
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < perPage) break;
  }
  return all;
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.action !== 'dashboard') {
    return jsonOutput({ status: 'ok', message: 'repo-tracker backend alive' });
  }
  var secret = PropertiesService.getScriptProperties().getProperty('DASHBOARD_SECRET');
  if (!secret || params.secret !== secret) {
    return jsonOutput({ status: 'error', message: 'unauthorized' });
  }
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  var releaseIso = getReleaseTimestampIso();
  var rows = getSubmissionsRows();
  var teams = rows.map(function (row) {
    var team = row[1], members = row[2], repoUrl = row[3];
    var parsed = parseRepoUrl(repoUrl);
    if (!parsed) {
      return { team: team, members: members, repoUrl: repoUrl, status: 'error', message: 'invalid repo URL' };
    }
    try {
      var commits = fetchAllCommits(parsed.owner, parsed.repo, token).map(normalizeGithubCommit);
      var stats = buildTeamStats(commits, releaseIso);
      // commits arrive newest-first from GitHub; ship them so the dashboard can
      // list per-commit detail when an admin expands a team.
      return Object.assign({ team: team, members: members, repoUrl: repoUrl, status: 'ok', commits: commits }, stats);
    } catch (err) {
      return { team: team, members: members, repoUrl: repoUrl, status: 'error', message: err.message };
    }
  });
  teams.sort(function (a, b) { return (b.totalCommits || 0) - (a.totalCommits || 0); });
  return jsonOutput({ status: 'success', releaseTimestamp: releaseIso, teams: teams });
}
