const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadBackend(globals) {
  const code = fs.readFileSync(path.join(__dirname, 'repo-tracker-backend.gs'), 'utf8');
  const context = Object.assign({}, globals || {});
  vm.createContext(context);
  new vm.Script(code, { filename: 'repo-tracker-backend.gs' }).runInContext(context);
  return context;
}

// vm.createContext runs the backend in a separate V8 realm, so objects it
// returns have a different Object prototype than plain literals in this
// file — assert.deepEqual (deepStrictEqual under node:assert/strict) treats
// that as unequal even when every property matches. Round-tripping through
// JSON strips the foreign realm's prototype before comparing.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---- parseRepoUrl ----

test('parseRepoUrl accepts a plain github.com URL', () => {
  const ctx = loadBackend();
  assert.deepEqual(plain(ctx.parseRepoUrl('https://github.com/octocat/Hello-World')), {
    owner: 'octocat',
    repo: 'Hello-World'
  });
});

test('parseRepoUrl accepts trailing slash and .git suffix', () => {
  const ctx = loadBackend();
  assert.deepEqual(plain(ctx.parseRepoUrl('https://github.com/octocat/Hello-World.git')), {
    owner: 'octocat',
    repo: 'Hello-World'
  });
  assert.deepEqual(plain(ctx.parseRepoUrl('https://github.com/octocat/Hello-World/')), {
    owner: 'octocat',
    repo: 'Hello-World'
  });
});

test('parseRepoUrl rejects non-github URLs and garbage', () => {
  const ctx = loadBackend();
  assert.equal(ctx.parseRepoUrl('https://gitlab.com/octocat/Hello-World'), null);
  assert.equal(ctx.parseRepoUrl('not a url'), null);
  assert.equal(ctx.parseRepoUrl(''), null);
  assert.equal(ctx.parseRepoUrl(null), null);
});

// ---- validateSubmission ----

test('validateSubmission accepts a well-formed submission', () => {
  const ctx = loadBackend();
  const result = ctx.validateSubmission(
    { team: 'Icarus', members: 'Ann, Ben', repoUrl: 'https://github.com/team/repo' },
    []
  );
  assert.deepEqual(plain(result), { ok: true });
});

test('validateSubmission rejects missing fields', () => {
  const ctx = loadBackend();
  assert.equal(ctx.validateSubmission({ members: 'Ann', repoUrl: 'https://github.com/a/b' }, []).ok, false);
  assert.equal(ctx.validateSubmission({ team: 'A', repoUrl: 'https://github.com/a/b' }, []).ok, false);
  assert.equal(ctx.validateSubmission({ team: 'A', members: 'Ann' }, []).ok, false);
});

test('validateSubmission rejects a malformed repo URL', () => {
  const ctx = loadBackend();
  const result = ctx.validateSubmission({ team: 'A', members: 'Ann', repoUrl: 'ftp://nope' }, []);
  assert.equal(result.ok, false);
  assert.match(result.error, /github\.com\/owner\/repo/);
});

test('validateSubmission rejects a case-insensitive duplicate team name', () => {
  const ctx = loadBackend();
  const result = ctx.validateSubmission(
    { team: 'icarus', members: 'Ann', repoUrl: 'https://github.com/a/b' },
    ['Icarus', 'Daedalus']
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /already submitted/);
});

// ---- normalizeGithubCommit ----

test('normalizeGithubCommit prefers the github login over commit author fields', () => {
  const ctx = loadBackend();
  const normalized = ctx.normalizeGithubCommit({
    sha: 'abc123',
    commit: { author: { name: 'Ann Dev', email: 'ann@example.com', date: '2026-07-10T10:00:00Z' } },
    author: { login: 'ann-dev' }
  });
  assert.deepEqual(plain(normalized), { sha: 'abc123', date: '2026-07-10T10:00:00Z', author: 'ann-dev' });
});

test('normalizeGithubCommit falls back to email then name when login is missing', () => {
  const ctx = loadBackend();
  const withEmail = ctx.normalizeGithubCommit({
    sha: 's1',
    commit: { author: { name: 'Ann Dev', email: 'ann@example.com', date: '2026-07-10T10:00:00Z' } },
    author: null
  });
  assert.equal(withEmail.author, 'ann@example.com');

  const withNameOnly = ctx.normalizeGithubCommit({
    sha: 's2',
    commit: { author: { name: 'Ann Dev', date: '2026-07-10T10:00:00Z' } },
    author: null
  });
  assert.equal(withNameOnly.author, 'Ann Dev');
});

// ---- splitCommitsByRelease ----

test('splitCommitsByRelease splits commits at the release timestamp (inclusive of post)', () => {
  const ctx = loadBackend();
  const commits = [
    { sha: '1', date: '2026-07-10T09:00:00Z', author: 'a' },
    { sha: '2', date: '2026-07-10T10:00:00Z', author: 'a' },
    { sha: '3', date: '2026-07-10T11:00:00Z', author: 'b' }
  ];
  const result = ctx.splitCommitsByRelease(commits, '2026-07-10T10:00:00Z');
  assert.equal(result.preCommits.length, 1);
  assert.equal(result.postCommits.length, 2);
});

test('splitCommitsByRelease treats every commit as pre-release when no timestamp is set', () => {
  const ctx = loadBackend();
  const commits = [{ sha: '1', date: '2026-07-10T09:00:00Z', author: 'a' }];
  const result = ctx.splitCommitsByRelease(commits, null);
  assert.equal(result.preCommits.length, 1);
  assert.equal(result.postCommits.length, 0);
});

// ---- countContributors ----

test('countContributors counts unique authors only', () => {
  const ctx = loadBackend();
  const commits = [
    { sha: '1', date: '2026-07-10T09:00:00Z', author: 'a' },
    { sha: '2', date: '2026-07-10T10:00:00Z', author: 'a' },
    { sha: '3', date: '2026-07-10T11:00:00Z', author: 'b' }
  ];
  assert.equal(ctx.countContributors(commits), 2);
});

// ---- buildTeamStats ----

test('buildTeamStats combines split, contributor count, and last commit time', () => {
  const ctx = loadBackend();
  const commits = [
    { sha: '1', date: '2026-07-10T09:00:00Z', author: 'a' },
    { sha: '2', date: '2026-07-10T12:00:00Z', author: 'b' }
  ];
  const stats = ctx.buildTeamStats(commits, '2026-07-10T10:00:00Z');
  assert.deepEqual(plain(stats), {
    totalCommits: 2,
    preRelease: 1,
    postRelease: 1,
    contributorCount: 2,
    lastCommitTime: '2026-07-10T12:00:00.000Z'
  });
});

test('buildTeamStats handles an empty commit list', () => {
  const ctx = loadBackend();
  const stats = ctx.buildTeamStats([], null);
  assert.deepEqual(plain(stats), {
    totalCommits: 0,
    preRelease: 0,
    postRelease: 0,
    contributorCount: 0,
    lastCommitTime: null
  });
});

// ---- mock GAS globals for doPost/doGet tests ----

function createMockSheet(initialRows) {
  var rows = initialRows || [];
  var cells = {};
  return {
    appendRow: function (row) { rows.push(row); },
    getDataRange: function () {
      return { getValues: function () { return rows; } };
    },
    getRange: function (a1) {
      return {
        getValue: function () { return cells[a1]; },
        setValue: function (v) { cells[a1] = v; }
      };
    },
    _rows: rows,
    _setCell: function (a1, v) { cells[a1] = v; }
  };
}

function createMockSpreadsheetApp(sheets) {
  var store = sheets || {};
  return {
    getActiveSpreadsheet: function () {
      return {
        getSheetByName: function (name) { return store[name] || null; },
        insertSheet: function (name) {
          var sheet = createMockSheet([]);
          store[name] = sheet;
          return sheet;
        }
      };
    }
  };
}

var mockContentService = {
  createTextOutput: function (str) {
    var parsed = JSON.parse(str);
    return {
      _json: parsed,
      setMimeType: function () { return this; }
    };
  },
  MimeType: { JSON: 'JSON' }
};

// ---- doPost ----

test('doPost rejects invalid JSON body', () => {
  const sheets = {};
  const ctx = loadBackend({
    SpreadsheetApp: createMockSpreadsheetApp(sheets),
    ContentService: mockContentService
  });
  const result = ctx.doPost({ postData: { contents: 'not json' } });
  assert.equal(result._json.status, 'error');
});

test('doPost appends a valid submission and returns success', () => {
  const sheets = {};
  const ctx = loadBackend({
    SpreadsheetApp: createMockSpreadsheetApp(sheets),
    ContentService: mockContentService
  });
  const result = ctx.doPost({
    postData: { contents: JSON.stringify({ team: 'Icarus', members: 'Ann, Ben', repoUrl: 'https://github.com/team/repo' }) }
  });
  assert.equal(result._json.status, 'success');
  assert.equal(sheets['Submissions']._rows.length, 2); // header + 1 data row
  assert.equal(sheets['Submissions']._rows[1][1], 'Icarus');
});

test('doPost rejects a duplicate team name across two calls', () => {
  const sheets = {};
  const ctx = loadBackend({
    SpreadsheetApp: createMockSpreadsheetApp(sheets),
    ContentService: mockContentService
  });
  ctx.doPost({
    postData: { contents: JSON.stringify({ team: 'Icarus', members: 'Ann', repoUrl: 'https://github.com/team/repo' }) }
  });
  const second = ctx.doPost({
    postData: { contents: JSON.stringify({ team: 'icarus', members: 'Ben', repoUrl: 'https://github.com/team/other' }) }
  });
  assert.equal(second._json.status, 'error');
  assert.match(second._json.message, /already submitted/);
  assert.equal(sheets['Submissions']._rows.length, 2); // still just header + first submission
});

// ---- doGet ----

function createMockPropertiesService(props) {
  return {
    getScriptProperties: function () {
      return { getProperty: function (key) { return props[key] || null; } };
    }
  };
}

function createMockUrlFetchApp(pagesByRepo) {
  return {
    fetch: function (url) {
      var match = url.match(/repos\/([^/]+)\/([^/]+)\/commits\?per_page=100&page=(\d+)/);
      var key = match[1] + '/' + match[2];
      var page = parseInt(match[3], 10);
      var pages = pagesByRepo[key] || [];
      var body = pages[page - 1] || [];
      return {
        getResponseCode: function () { return 200; },
        getContentText: function () { return JSON.stringify(body); }
      };
    }
  };
}

function githubCommit(sha, iso, login) {
  return { sha: sha, commit: { author: { date: iso, name: login, email: login + '@x.com' } }, author: { login: login } };
}

test('doGet rejects a missing or wrong dashboard secret', () => {
  const ctx = loadBackend({
    PropertiesService: createMockPropertiesService({ DASHBOARD_SECRET: 'right' }),
    ContentService: mockContentService
  });
  const result = ctx.doGet({ parameter: { action: 'dashboard', secret: 'wrong' } });
  assert.equal(result._json.status, 'error');
  assert.equal(result._json.message, 'unauthorized');
});

test('doGet returns per-team stats sorted by total commits descending', () => {
  const sheets = {
    Submissions: createMockSheet([
      ['Timestamp', 'Team', 'Members', 'RepoURL'],
      [new Date(), 'Icarus', 'Ann', 'https://github.com/team/icarus-repo'],
      [new Date(), 'Daedalus', 'Ben', 'https://github.com/team/daedalus-repo']
    ]),
    Config: createMockSheet([])
  };
  sheets.Config._setCell('B1', '2026-07-10T10:00:00Z');

  const pagesByRepo = {
    'team/icarus-repo': [[
      githubCommit('i1', '2026-07-10T09:00:00Z', 'ann'),
      githubCommit('i2', '2026-07-10T11:00:00Z', 'ann')
    ]],
    'team/daedalus-repo': [[
      githubCommit('d1', '2026-07-10T09:00:00Z', 'ben'),
      githubCommit('d2', '2026-07-10T11:00:00Z', 'ben'),
      githubCommit('d3', '2026-07-10T12:00:00Z', 'cara')
    ]]
  };

  const ctx = loadBackend({
    SpreadsheetApp: createMockSpreadsheetApp(sheets),
    PropertiesService: createMockPropertiesService({ DASHBOARD_SECRET: 'right', GITHUB_TOKEN: 'tok' }),
    ContentService: mockContentService,
    UrlFetchApp: createMockUrlFetchApp(pagesByRepo)
  });

  const result = ctx.doGet({ parameter: { action: 'dashboard', secret: 'right' } });
  assert.equal(result._json.status, 'success');
  assert.equal(result._json.teams.length, 2);
  assert.equal(result._json.teams[0].team, 'Daedalus');
  assert.equal(result._json.teams[0].totalCommits, 3);
  assert.equal(result._json.teams[0].postRelease, 2);
  assert.equal(result._json.teams[0].contributorCount, 2);
  assert.equal(result._json.teams[1].team, 'Icarus');
  assert.equal(result._json.teams[1].totalCommits, 2);
});

test('doGet marks a team with an unparseable repo URL as an error without failing the batch', () => {
  const sheets = {
    Submissions: createMockSheet([
      ['Timestamp', 'Team', 'Members', 'RepoURL'],
      [new Date(), 'BadTeam', 'Zed', 'not-a-url']
    ]),
    Config: createMockSheet([])
  };

  const ctx = loadBackend({
    SpreadsheetApp: createMockSpreadsheetApp(sheets),
    PropertiesService: createMockPropertiesService({ DASHBOARD_SECRET: 'right', GITHUB_TOKEN: 'tok' }),
    ContentService: mockContentService,
    UrlFetchApp: createMockUrlFetchApp({})
  });

  const result = ctx.doGet({ parameter: { action: 'dashboard', secret: 'right' } });
  assert.equal(result._json.teams[0].status, 'error');
  assert.match(result._json.teams[0].message, /invalid repo URL/);
});
