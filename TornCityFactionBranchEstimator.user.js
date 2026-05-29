// ==UserScript==
// @name         TORN CITY Faction Unlock Branch Estimator
// @namespace    sanxion.tc.factionbranchestimator
// @version      1.0.21
// @description  Estimates how long your faction will take to bank enough respect to unlock the next special branch. Respect costs are read from the canonical Torn v2 factiontree endpoint (which carries name + cost for every upgrade); faction.upgrades is used as a name-only fallback for any entry the v2 tree doesn't cover.
// @author       Sanxion [2987640]
// @match        https://www.torn.com/factions.php?step=your&type=7#/tab=upgrades
// @match        https://www.torn.com/factions.php*
// @updateURL    https://github.com/Quantarallax/Torn-City-Faction-Branch-Estimator/raw/refs/heads/main/TornCityFactionBranchEstimator.user.js
// @downloadURL  https://github.com/Quantarallax/Torn-City-Faction-Branch-Estimator/raw/refs/heads/main/TornCityFactionBranchEstimator.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      c.statcounter.com
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ---------- constants ----------
    var LOG_TAG = '[FactionBranchEstimator]';
    var SCRIPT_NAME = 'TORN CITY Faction Unlock Branch Estimator';
    var SCRIPT_VERSION = '1.0.17';
    var AUTHOR_NAME = 'Sanxion';
    var AUTHOR_ID = '2987640';

    var STORAGE_API_KEY = 'fbe_api_key';
    var STORAGE_HISTORY = 'fbe_respect_history';
    var STORAGE_PANEL_OPEN = 'fbe_panel_open';
    var STORAGE_TARGET_NEEDED = 'fbe_target_specialists_needed';
    var STORAGE_SHOW_CALC = 'fbe_show_calculation';
    var STORAGE_HISTORY_WINDOW = 'fbe_history_window_days';
    var STORAGE_SHOW_HISTORY = 'fbe_show_history';

    var HISTORY_CAP = 500;

    // Canonical branch names (used to map object-key context to a clean label).
    var BRANCH_KEY_MAP = {
        core: 'Core',
        toleration: 'Toleration',
        steadfast: 'Steadfast',
        criminality: 'Criminality',
        fortitude: 'Fortitude',
        aggression: 'Aggression',
        suppression: 'Suppression',
        suppresion: 'Suppression',
        voracity: 'Voracity',
        excursion: 'Excursion'
    };

    function canonicalBranchFromKey(key) {
        if (!key) {
            return null;
        }
        return BRANCH_KEY_MAP[String(key).toLowerCase()] || null;
    }

    // ---------- statcounter pixel ----------
    function fireStatcounter() {
        try {
            var img = document.createElement('img');
            img.className = 'statcounter';
            img.src = 'https://c.statcounter.com/13245537/0/18e5f60c/1/';
            img.alt = 'Web Analytics';
            img.referrerPolicy = 'no-referrer-when-downgrade';
            img.style.position = 'absolute';
            img.style.left = '-9999px';
            img.style.top = '-9999px';
            img.style.width = '1px';
            img.style.height = '1px';
            img.setAttribute('aria-hidden', 'true');
            (document.body || document.documentElement).appendChild(img);
        } catch (err) {
            console.error(LOG_TAG, 'statcounter error', err);
        }
    }

    if (document.readyState === 'complete') {
        fireStatcounter();
    } else {
        window.addEventListener('load', fireStatcounter, { once: true });
    }

    // ---------- hash guard ----------
    function isOnUpgradesTab() {
        var hash = window.location.hash || '';
        return hash.indexOf('tab=upgrades') !== -1;
    }

    // ---------- storage helpers ----------
    function storageGet(key, fallback) {
        try {
            var raw = (typeof GM_getValue !== 'undefined')
                ? GM_getValue(key, null)
                : window.localStorage.getItem(key);
            if (raw === null || typeof raw === 'undefined') {
                return fallback;
            }
            try {
                return JSON.parse(raw);
            } catch (parseErr) {
                return raw;
            }
        } catch (err) {
            console.error(LOG_TAG, 'storageGet error for', key, err);
            return fallback;
        }
    }

    function storageSet(key, value) {
        try {
            var v = (typeof value === 'string') ? value : JSON.stringify(value);
            if (typeof GM_setValue !== 'undefined') {
                GM_setValue(key, v);
            } else {
                window.localStorage.setItem(key, v);
            }
        } catch (err) {
            console.error(LOG_TAG, 'storageSet error for', key, err);
        }
    }

    // ---------- formatting ----------
    function formatNumber(n) {
        if (n === null || typeof n === 'undefined' || isNaN(n)) {
            return '—';
        }
        return Math.round(n).toLocaleString('en-GB');
    }

    function formatDuration(seconds) {
        if (!isFinite(seconds) || seconds <= 0) {
            return '—';
        }
        var days = Math.floor(seconds / 86400);
        var hours = Math.floor((seconds % 86400) / 3600);
        var mins = Math.floor((seconds % 3600) / 60);
        if (days >= 1) {
            return days + 'd ' + hours + 'h';
        }
        if (hours >= 1) {
            return hours + 'h ' + mins + 'm';
        }
        return mins + 'm';
    }

    function formatDateDMY(timestampSec) {
        if (!timestampSec) {
            return '—';
        }
        var d = new Date(timestampSec * 1000);
        var dd = String(d.getUTCDate()).padStart(2, '0');
        var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        var yyyy = d.getUTCFullYear();
        return dd + '-' + mm + '-' + yyyy;
    }

    function formatTimeAgo(timestampSec) {
        if (!timestampSec) {
            return '—';
        }
        var now = Math.floor(Date.now() / 1000);
        var diff = now - timestampSec;
        if (diff < 0) {
            return 'in the future';
        }
        var days = Math.floor(diff / 86400);
        if (days === 1) {
            return '1 day ago';
        }
        return days + ' days ago';
    }

    function maskKey(key) {
        if (!key) {
            return '';
        }
        if (key.length <= 4) {
            return '••••';
        }
        return key.substring(0, 2) + '•••••••••••' + key.substring(key.length - 2);
    }

    function escapeHtml(s) {
        if (s === null || typeof s === 'undefined') {
            return '';
        }
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function extractCost(u) {
        if (!u) {
            return 0;
        }
        if (typeof u.cost === 'number' && isFinite(u.cost)) {
            return u.cost;
        }
        if (typeof u.basecost === 'number' && isFinite(u.basecost)) {
            return u.basecost;
        }
        if (typeof u.respect === 'number' && isFinite(u.respect)) {
            return u.respect;
        }
        if (typeof u.cost === 'string') {
            var nc = parseInt(u.cost.replace(/,/g, ''), 10);
            if (!isNaN(nc)) {
                return nc;
            }
        }
        if (typeof u.basecost === 'string') {
            var nb = parseInt(u.basecost.replace(/,/g, ''), 10);
            if (!isNaN(nb)) {
                return nb;
            }
        }
        return 0;
    }

    function inferBranchMultiplier(branch, factionUpgrades) {
        var found = 1;
        Object.keys(factionUpgrades || {}).some(function (id) {
            var u = factionUpgrades[id];
            if (u && u.branch === branch && typeof u.branchmultiplier === 'number' && u.branchmultiplier > 0) {
                found = u.branchmultiplier;
                return true;
            }
            return false;
        });
        return found;
    }

    // ---------- roman numeral / sub-tree parsing ----------
    var ROMAN_MAP = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15 };

    function parseUpgradeName(name) {
        if (!name) {
            return { subTree: 'Other', levelText: '', level: 0 };
        }
        var m = name.match(/^(.+?)\s+(XV|XIV|XIII|XII|XI|IX|IV|V?I{0,3}|VI{0,3}|X)$/);
        if (m && ROMAN_MAP[m[2]]) {
            return {
                subTree: m[1].trim(),
                levelText: m[2],
                level: ROMAN_MAP[m[2]]
            };
        }
        return { subTree: name, levelText: '', level: 0 };
    }

    function romanFromLevel(level) {
        var keys = Object.keys(ROMAN_MAP);
        for (var i = 0; i < keys.length; i++) {
            if (ROMAN_MAP[keys[i]] === level) {
                return keys[i];
            }
        }
        return String(level);
    }

    // ---------- api ----------
    function apiCall(endpoint, selections, key, callback) {
        var url = 'https://api.torn.com/' + endpoint + '/?selections=' + selections + '&key=' + encodeURIComponent(key);
        function handle(text) {
            try {
                var data = JSON.parse(text);
                if (data && data.error) {
                    callback(data.error, null);
                } else {
                    callback(null, data);
                }
            } catch (err) {
                console.error(LOG_TAG, 'apiCall parse error', err);
                callback({ error: 'Parse error' }, null);
            }
        }
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                onload: function (resp) { handle(resp.responseText); },
                onerror: function (e) {
                    console.error(LOG_TAG, 'apiCall network error', e);
                    callback({ error: 'Network error' }, null);
                }
            });
        } else {
            fetch(url)
                .then(function (r) { return r.text(); })
                .then(handle)
                .catch(function (e) {
                    console.error(LOG_TAG, 'apiCall fetch error', e);
                    callback({ error: 'Network error' }, null);
                });
        }
    }

    function apiV2Call(path, key, callback) {
        var separator = path.indexOf('?') >= 0 ? '&' : '?';
        var url = 'https://api.torn.com/v2/' + path + separator + 'key=' + encodeURIComponent(key);
        function handle(text) {
            try {
                var data = JSON.parse(text);
                if (data && data.error) {
                    callback(data.error, null);
                } else {
                    callback(null, data);
                }
            } catch (err) {
                console.error(LOG_TAG, 'apiV2Call parse error', err);
                callback({ error: 'Parse error' }, null);
            }
        }
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                onload: function (resp) { handle(resp.responseText); },
                onerror: function (e) {
                    console.error(LOG_TAG, 'apiV2Call network error', e);
                    callback({ error: 'Network error' }, null);
                }
            });
        } else {
            fetch(url)
                .then(function (r) { return r.text(); })
                .then(handle)
                .catch(function (e) {
                    console.error(LOG_TAG, 'apiV2Call fetch error', e);
                    callback({ error: 'Network error' }, null);
                });
        }
    }

    // ---------- respect history ----------
    function recordRespectSnapshot(respect) {
        var history = storageGet(STORAGE_HISTORY, []);
        if (!Array.isArray(history)) {
            history = [];
        }
        var now = Math.floor(Date.now() / 1000);
        var last = history.length ? history[history.length - 1] : null;
        if (last && (now - last.t) < 300 && last.r === respect) {
            return history;
        }
        history.push({ t: now, r: respect });
        history.sort(function (a, b) { return a.t - b.t; });
        while (history.length > HISTORY_CAP) {
            history.shift();
        }
        storageSet(STORAGE_HISTORY, history);
        return history;
    }

    function calculateRespectRate(history, factionAgeDays, currentRespect, windowDays) {
        if (Array.isArray(history) && history.length >= 2) {
            var filtered = history;
            var windowApplied = false;
            if (windowDays && windowDays > 0) {
                var nowSec = Math.floor(Date.now() / 1000);
                var cutoff = nowSec - (windowDays * 86400);
                var inWindow = history.filter(function (s) { return s.t >= cutoff; });
                if (inWindow.length >= 2) {
                    filtered = inWindow;
                    windowApplied = true;
                }
            }
            var oldest = filtered[0];
            var newest = filtered[filtered.length - 1];
            var dt = newest.t - oldest.t;
            var dr = newest.r - oldest.r;
            if (dt > 0 && dr > 0) {
                return {
                    rate: dr / dt,
                    source: 'snapshots',
                    span: dt,
                    oldest: oldest,
                    newest: newest,
                    windowDays: windowDays || 0,
                    windowApplied: windowApplied,
                    snapshotsUsed: filtered.length,
                    snapshotsTotal: history.length
                };
            }
        }
        if (factionAgeDays && factionAgeDays > 0 && currentRespect > 0) {
            return { rate: currentRespect / (factionAgeDays * 86400), source: 'lifetime', span: factionAgeDays * 86400 };
        }
        return { rate: 0, source: 'none', span: 0 };
    }

    // ---------- TSV history parsing ----------
    function parseHistoricalTSV(text) {
        var lines = text.split(/\r?\n/);
        var snapshots = [];
        var skipped = 0;
        var parsedRows = 0;
        for (var i = 0; i < lines.length; i++) {
            if (i === 0) {
                continue;
            }
            var line = lines[i];
            if (!line || !line.trim()) {
                continue;
            }
            var parts = line.split('\t');
            if (parts.length < 4) {
                skipped += 1;
                continue;
            }
            var dateStr = (parts[1] || '').trim();
            var respectEndStr = (parts[3] || '').trim();
            if (!dateStr || !respectEndStr) {
                skipped += 1;
                continue;
            }
            var dm = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
            if (!dm) {
                skipped += 1;
                continue;
            }
            var dd = parseInt(dm[1], 10);
            var mm = parseInt(dm[2], 10);
            var yyyy = parseInt(dm[3], 10);
            var respect = parseInt(respectEndStr.replace(/,/g, ''), 10);
            if (isNaN(dd) || isNaN(mm) || isNaN(yyyy) || isNaN(respect)) {
                skipped += 1;
                continue;
            }
            var ts = Math.floor(Date.UTC(yyyy, mm - 1, dd, 23, 59, 59) / 1000);
            snapshots.push({ t: ts, r: respect });
            parsedRows += 1;
        }
        return { snapshots: snapshots, skipped: skipped, parsedRows: parsedRows };
    }

    function mergeSnapshots(existing, incoming) {
        var byTs = {};
        (existing || []).forEach(function (s) {
            if (s && typeof s.t === 'number') {
                byTs[s.t] = s;
            }
        });
        (incoming || []).forEach(function (s) {
            if (s && typeof s.t === 'number') {
                byTs[s.t] = s;
            }
        });
        var merged = Object.keys(byTs).map(function (k) { return byTs[k]; });
        merged.sort(function (a, b) { return a.t - b.t; });
        while (merged.length > HISTORY_CAP) {
            merged.shift();
        }
        return merged;
    }

    // ---------- factiontree parsing ----------
    // Handles every layout the v2 endpoint may use:
    //   * Nested sub-trees:   { id, name, upgrades: [ {name, level, cost, ...} ] }
    //   * Branch-keyed dict:  { "core": [...], "Steadfast": [...] }
    //   * Flat array:         [ {id, name, upgrades:[]}, ... ]
    //   * v1 hierarchy:       arbitrary nesting with name + basecost/cost on leaves
    // Branch is inferred from (in priority order) the leaf's own `branch`, the
    // sub-tree's `branch`/`branch_name`, the surrounding object key, and finally
    // the inherited branch from a parent walk. Branch-less leaves still get
    // captured — the cost resolver has a name-only fallback for that case.
    function flattenFactionTree(tree) {
        var entries = [];
        var seen = {};
        if (!tree || typeof tree !== 'object') {
            return entries;
        }

        function isLeaf(node) {
            return node && typeof node === 'object' &&
                typeof node.name === 'string' && node.name.length > 0 &&
                (typeof node.cost === 'number' || typeof node.basecost === 'number') &&
                !Array.isArray(node.upgrades);
        }

        function recordLeaf(leaf, branchContext) {
            if (!leaf || typeof leaf !== 'object' || typeof leaf.name !== 'string' || !leaf.name) {
                return;
            }
            var cost = extractCost(leaf);
            var branch = leaf.branch || branchContext || 'Unknown';
            var canonical = canonicalBranchFromKey(branch) || branch;
            var key = canonical + '|' + leaf.name;
            if (seen[key]) {
                return;
            }
            seen[key] = true;
            entries.push({
                name: leaf.name,
                branch: canonical,
                basecost: cost,
                level: (typeof leaf.level === 'number') ? leaf.level : 0,
                ability: leaf.ability || '',
                challenge: leaf.challenge || ''
            });
        }

        function walk(node, inheritedBranch, keyContext) {
            if (!node || typeof node !== 'object') {
                return;
            }

            var currentBranch = node.branch || node.branch_name ||
                                canonicalBranchFromKey(keyContext) ||
                                inheritedBranch;

            // v2 sub-tree shape: a node with an `upgrades` array of leaves.
            if (Array.isArray(node.upgrades)) {
                node.upgrades.forEach(function (leaf) {
                    if (isLeaf(leaf)) {
                        recordLeaf(leaf, currentBranch);
                    } else if (leaf && typeof leaf === 'object') {
                        // Defensive: in case nested upgrades arrays appear.
                        walk(leaf, currentBranch, null);
                    }
                });
            }

            // A node that's itself a leaf (and has no upgrades children).
            if (isLeaf(node)) {
                recordLeaf(node, currentBranch);
                return;
            }

            // Otherwise recurse into all child properties.
            Object.keys(node).forEach(function (k) {
                if (k === 'upgrades') {
                    return;
                }
                var child = node[k];
                if (child && typeof child === 'object') {
                    var nextKeyContext = Array.isArray(node) ? keyContext : k;
                    walk(child, currentBranch, nextKeyContext);
                }
            });
        }

        walk(tree, null, null);
        return entries;
    }

    // ---------- branch analysis ----------
    function isCoreBranch(name) {
        return name && String(name).toLowerCase() === 'core';
    }

    // Cost-resolution priority:
    //   v2 tree (branch+name) -> v2 tree (name only) ->
    //   faction.upgrades (branch+name) -> faction.upgrades (name only) ->
    //   unknown.
    // The name-only fallbacks guarantee a lookup succeeds even when the v2
    // response doesn't carry a branch field for an entry (e.g. Organized Crimes
    // arriving as a branch-less sub-tree).
    function buildCostResolver(factionUpgrades, treeEntries) {
        var apiCostByKey = {};
        var apiCostByName = {};
        Object.keys(factionUpgrades || {}).forEach(function (id) {
            var u = factionUpgrades[id];
            if (!u || !u.name) {
                return;
            }
            var c = extractCost(u);
            if (c > 0) {
                apiCostByName[u.name] = c;
                if (u.branch) {
                    apiCostByKey[u.branch + '|' + u.name] = c;
                }
            }
        });

        var treeCostByKey = {};
        var treeCostByName = {};
        (treeEntries || []).forEach(function (e) {
            if (!e || !e.name) {
                return;
            }
            if (e.basecost > 0) {
                treeCostByName[e.name] = e.basecost;
                if (e.branch && e.branch !== 'Unknown') {
                    treeCostByKey[e.branch + '|' + e.name] = e.basecost;
                }
            }
        });

        return function (branch, subTree, level, name) {
            var key = branch + '|' + name;
            if (treeCostByKey[key] > 0) {
                return { value: treeCostByKey[key], source: 'tree' };
            }
            if (treeCostByName[name] > 0) {
                return { value: treeCostByName[name], source: 'tree' };
            }
            if (apiCostByKey[key] > 0) {
                return { value: apiCostByKey[key], source: 'api' };
            }
            if (apiCostByName[name] > 0) {
                return { value: apiCostByName[name], source: 'api' };
            }
            return { value: 0, source: 'unknown' };
        };
    }

    function summariseBranchesFromTree(treeEntries, factionUpgrades, targetNeeded) {
        var treeBySubTree = {};
        var treeBySubTreeByName = {};
        treeEntries.forEach(function (e) {
            var parsed = parseUpgradeName(e.name);
            var entry = {
                name: e.name,
                branch: e.branch,
                subTree: parsed.subTree,
                level: (e.level > 0 ? e.level : parsed.level) || 0,
                levelText: parsed.levelText || (e.level > 0 ? romanFromLevel(e.level) : ''),
                basecost: e.basecost
            };
            var key = e.branch + '|' + parsed.subTree;
            if (!treeBySubTree[key]) {
                treeBySubTree[key] = [];
            }
            treeBySubTree[key].push(entry);
            // Branch-less mirror so we can still find sub-tree entries when
            // the v2 tree didn't tag them with a branch.
            var nameKey = parsed.subTree;
            if (!treeBySubTreeByName[nameKey]) {
                treeBySubTreeByName[nameKey] = [];
            }
            treeBySubTreeByName[nameKey].push(entry);
        });
        Object.keys(treeBySubTree).forEach(function (key) {
            treeBySubTree[key].sort(function (a, b) { return (a.level || 0) - (b.level || 0); });
        });
        Object.keys(treeBySubTreeByName).forEach(function (key) {
            treeBySubTreeByName[key].sort(function (a, b) { return (a.level || 0) - (b.level || 0); });
        });

        var highestLevelBySubTree = {};
        var unlockedBranches = {};
        var nonLeveledUnlocks = [];
        var branchMultipliers = {};

        Object.keys(factionUpgrades || {}).forEach(function (id) {
            var u = factionUpgrades[id];
            if (!u || !u.branch || !u.name) {
                return;
            }
            unlockedBranches[u.branch] = true;
            var parsed = parseUpgradeName(u.name);
            if (parsed.level > 0) {
                var stKey = u.branch + '|' + parsed.subTree;
                if (!highestLevelBySubTree[stKey] || parsed.level > highestLevelBySubTree[stKey]) {
                    highestLevelBySubTree[stKey] = parsed.level;
                }
            } else {
                nonLeveledUnlocks.push({
                    branch: u.branch,
                    subTree: parsed.subTree,
                    name: u.name,
                    basecost: extractCost(u)
                });
            }
        });

        Object.keys(unlockedBranches).forEach(function (b) {
            branchMultipliers[b] = inferBranchMultiplier(b, factionUpgrades);
        });

        var resolveCost = buildCostResolver(factionUpgrades, treeEntries);
        var byBranch = {};

        function getTreeEntriesForSubTree(branch, subTree) {
            var byKey = treeBySubTree[branch + '|' + subTree];
            if (byKey && byKey.length > 0) {
                return byKey;
            }
            return treeBySubTreeByName[subTree] || [];
        }

        Object.keys(highestLevelBySubTree).forEach(function (key) {
            var parts = key.split('|');
            var branch = parts[0];
            var subTree = parts[1];
            var highest = highestLevelBySubTree[key];

            if (!byBranch[branch]) {
                byBranch[branch] = { unlocked: [], locked: [] };
            }

            var treeList = getTreeEntriesForSubTree(branch, subTree);
            if (treeList.length === 0) {
                for (var lvl = 1; lvl <= highest; lvl++) {
                    var levelText = romanFromLevel(lvl);
                    var synthName = subTree + ' ' + levelText;
                    var resolved = resolveCost(branch, subTree, lvl, synthName);
                    byBranch[branch].unlocked.push({
                        name: synthName,
                        branch: branch,
                        subTree: subTree,
                        level: lvl,
                        levelText: levelText,
                        basecost: resolved.value,
                        costSource: resolved.source
                    });
                }
                return;
            }
            treeList.forEach(function (t) {
                if (!t.level || t.level < 1) {
                    return;
                }
                var resolved = resolveCost(branch, subTree, t.level, t.name);
                var item = {
                    name: t.name,
                    branch: branch,
                    subTree: subTree,
                    level: t.level,
                    levelText: t.levelText,
                    basecost: resolved.value,
                    costSource: resolved.source
                };
                if (t.level <= highest) {
                    byBranch[branch].unlocked.push(item);
                } else {
                    byBranch[branch].locked.push(item);
                }
            });
        });

        nonLeveledUnlocks.forEach(function (u) {
            if (!byBranch[u.branch]) {
                byBranch[u.branch] = { unlocked: [], locked: [] };
            }
            var resolved = resolveCost(u.branch, u.subTree, 0, u.name);
            var cost = resolved.value > 0 ? resolved.value : (u.basecost || 0);
            var src = resolved.value > 0 ? resolved.source : (u.basecost > 0 ? 'api' : 'unknown');
            byBranch[u.branch].unlocked.push({
                name: u.name,
                branch: u.branch,
                subTree: u.subTree,
                level: 0,
                levelText: '',
                basecost: cost,
                costSource: src
            });
        });

        var rows = [];
        Object.keys(byBranch).forEach(function (b) {
            var bucket = byBranch[b];
            var lockedWithCost = bucket.locked.filter(function (u) {
                return typeof u.basecost === 'number' && u.basecost > 0;
            });
            var lockedSorted = lockedWithCost.slice().sort(function (a, c) { return a.basecost - c.basecost; });
            var picked = lockedSorted.slice(0, targetNeeded);
            var pickedCost = picked.reduce(function (s, u) { return s + u.basecost; }, 0);
            var spentSoFar = bucket.unlocked.reduce(function (s, u) { return s + (u.basecost || 0); }, 0);
            var unknownLevels = bucket.unlocked.filter(function (u) { return !u.basecost; }).length;

            rows.push({
                branch: b,
                isCore: isCoreBranch(b),
                unlockedCount: bucket.unlocked.length,
                lockedCount: bucket.locked.length,
                lockedWithCostCount: lockedWithCost.length,
                totalCount: bucket.unlocked.length + bucket.locked.length,
                unlockedList: bucket.unlocked,
                lockedList: bucket.locked,
                lockedSorted: lockedSorted,
                cheapestPicked: picked,
                cheapestPickedCost: pickedCost,
                spentSoFar: spentSoFar,
                unknownLevels: unknownLevels,
                branchMultiplier: branchMultipliers[b] || 1
            });
        });

        rows.sort(function (a, b) {
            if (b.unlockedCount !== a.unlockedCount) {
                return b.unlockedCount - a.unlockedCount;
            }
            return a.cheapestPickedCost - b.cheapestPickedCost;
        });
        return rows;
    }

    function summariseBranchesFromUnlockedOnly(factionUpgrades) {
        var byBranch = {};
        var branchMultipliers = {};
        var unlockedBranches = {};
        Object.keys(factionUpgrades || {}).forEach(function (id) {
            var u = factionUpgrades[id];
            if (!u || !u.branch) {
                return;
            }
            unlockedBranches[u.branch] = true;
        });
        Object.keys(unlockedBranches).forEach(function (b) {
            branchMultipliers[b] = inferBranchMultiplier(b, factionUpgrades);
        });

        var resolveCost = buildCostResolver(factionUpgrades, []);

        var highestLevelBySubTree = {};
        var nonLeveled = [];
        Object.keys(factionUpgrades || {}).forEach(function (id) {
            var u = factionUpgrades[id];
            if (!u || !u.branch || !u.name) {
                return;
            }
            var parsed = parseUpgradeName(u.name);
            if (parsed.level > 0) {
                var stKey = u.branch + '|' + parsed.subTree;
                if (!highestLevelBySubTree[stKey] || parsed.level > highestLevelBySubTree[stKey]) {
                    highestLevelBySubTree[stKey] = parsed.level;
                }
            } else {
                nonLeveled.push({ branch: u.branch, subTree: parsed.subTree, name: u.name });
            }
        });

        Object.keys(highestLevelBySubTree).forEach(function (key) {
            var parts = key.split('|');
            var branch = parts[0];
            var subTree = parts[1];
            var highest = highestLevelBySubTree[key];
            if (!byBranch[branch]) {
                byBranch[branch] = { unlocked: [] };
            }
            for (var lvl = 1; lvl <= highest; lvl++) {
                var roman = romanFromLevel(lvl);
                var fullName = subTree + ' ' + roman;
                var resolved = resolveCost(branch, subTree, lvl, fullName);
                byBranch[branch].unlocked.push({
                    name: fullName,
                    branch: branch,
                    subTree: subTree,
                    level: lvl,
                    levelText: roman,
                    basecost: resolved.value,
                    costSource: resolved.source
                });
            }
        });

        nonLeveled.forEach(function (u) {
            if (!byBranch[u.branch]) {
                byBranch[u.branch] = { unlocked: [] };
            }
            var resolved = resolveCost(u.branch, u.subTree, 0, u.name);
            byBranch[u.branch].unlocked.push({
                name: u.name,
                branch: u.branch,
                subTree: u.subTree,
                level: 0,
                levelText: '',
                basecost: resolved.value,
                costSource: resolved.source
            });
        });

        var rows = [];
        Object.keys(byBranch).forEach(function (b) {
            var bucket = byBranch[b];
            var spentSoFar = bucket.unlocked.reduce(function (s, u) { return s + (u.basecost || 0); }, 0);
            var unknownLevels = bucket.unlocked.filter(function (u) { return !u.basecost; }).length;
            rows.push({
                branch: b,
                isCore: isCoreBranch(b),
                unlockedCount: bucket.unlocked.length,
                lockedCount: null,
                lockedWithCostCount: 0,
                totalCount: null,
                unlockedList: bucket.unlocked,
                lockedList: [],
                lockedSorted: [],
                cheapestPicked: [],
                cheapestPickedCost: 0,
                spentSoFar: spentSoFar,
                unknownLevels: unknownLevels,
                fallback: true,
                branchMultiplier: branchMultipliers[b] || 1
            });
        });
        rows.sort(function (a, b) { return b.unlockedCount - a.unlockedCount; });
        return rows;
    }

    // ---------- UI ----------
    var panelEl = null;
    var cogEl = null;
    var statusEl = null;

    function buildHistoryViewer(history) {
        if (!Array.isArray(history) || history.length === 0) {
            return '<div class="fbe-sub" style="padding:8px 0">No snapshots stored yet. Load a TSV or run the estimate periodically to build history.</div>';
        }

        // Group snapshots by UTC calendar date; keep the latest snapshot's
        // respect value as that day's end-of-day total.
        var byDate = {};
        history.forEach(function (s) {
            if (!s || typeof s.t !== 'number') {
                return;
            }
            var d = new Date(s.t * 1000);
            var dateKey = d.getUTCFullYear() + '-' +
                          String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
                          String(d.getUTCDate()).padStart(2, '0');
            if (!byDate[dateKey] || byDate[dateKey].t < s.t) {
                byDate[dateKey] = {
                    t: s.t,
                    r: s.r,
                    dateKey: dateKey,
                    year: d.getUTCFullYear(),
                    month: d.getUTCMonth(),
                    day: d.getUTCDate()
                };
            }
        });

        // Ascending order to compute each day's gain against the previous day,
        // then reverse for display (newest first).
        var sortedAsc = Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
        sortedAsc.forEach(function (entry, idx) {
            entry.gain = (idx === 0) ? null : (entry.r - sortedAsc[idx - 1].r);
        });
        var sortedDesc = sortedAsc.slice().reverse();

        var totalDays = sortedDesc.length;
        var totalGain = (sortedAsc.length >= 2) ? (sortedAsc[sortedAsc.length - 1].r - sortedAsc[0].r) : 0;

        var html = ['<div class="fbe-sub" style="margin-top:6px">' +
            'Showing ' + totalDays + ' day(s), newest first. ' +
            'Aggregated total gain across all days: ' + formatNumber(totalGain) + ' respect.' +
            '</div>'];
        html.push('<div class="fbe-tbl-wrap"><table class="fbe-tbl">');
        html.push('<thead><tr><th>Date (UTC)</th><th>When</th><th class="num">Respect (end of day)</th><th class="num">Gain that day</th></tr></thead><tbody>');
        sortedDesc.forEach(function (entry) {
            var dateStr = String(entry.day).padStart(2, '0') + '-' +
                          String(entry.month + 1).padStart(2, '0') + '-' +
                          entry.year;
            var when = formatTimeAgo(entry.t);
            var gainCell = '—';
            if (entry.gain !== null) {
                gainCell = (entry.gain >= 0 ? '+' : '') + formatNumber(entry.gain);
            }
            html.push('<tr>' +
                '<td>' + dateStr + '</td>' +
                '<td>' + when + '</td>' +
                '<td class="num">' + formatNumber(entry.r) + '</td>' +
                '<td class="num">' + gainCell + '</td>' +
                '</tr>');
        });
        html.push('</tbody></table></div>');
        return html.join('');
    }

    function refreshHistoryViewer(panel) {
        if (!panel) {
            return;
        }
        var viewer = panel.querySelector('#fbe-history-viewer');
        if (!viewer) {
            return;
        }
        var history = storageGet(STORAGE_HISTORY, []);
        viewer.innerHTML = buildHistoryViewer(Array.isArray(history) ? history : []);
    }

    function injectStyles() {
        if (document.getElementById('fbe-styles')) {
            return;
        }
        var style = document.createElement('style');
        style.id = 'fbe-styles';
        style.textContent = [
            '#fbe-cog-wrap { display: inline-flex; align-items: center; gap: 8px; margin: 4px 10px; font-family: Arial, sans-serif; vertical-align: middle; color: #eee; line-height: 1; }',
            '#fbe-cog-wrap .fbe-cog { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 16px; color: #ccc; user-select: none; transition: transform .2s, color .2s; line-height: 1; height: 18px; }',
            '#fbe-cog-wrap .fbe-cog:hover { color: #fff; transform: rotate(35deg); }',
            '#fbe-cog-wrap .fbe-status { display: inline-flex; align-items: center; font-size: 11px; color: #eee; line-height: 1; height: 18px; }',
            '#fbe-cog-wrap .fbe-status.ok { color: #8f8; }',
            '#fbe-cog-wrap .fbe-status.warn { color: #f99; }',

            '#fbe-panel { background: #1c1c1c; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 14px 16px; margin: 6px 0 14px 0; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.5; box-shadow: 0 2px 10px rgba(0,0,0,.6); max-width: 1000px; }',
            '#fbe-panel h3 { margin: 0 0 4px 0; font-size: 14px; color: #fff; line-height: 1.3; }',
            '#fbe-panel h4 { margin: 22px 0 8px 0; padding-top: 8px; font-size: 12px; color: #fc6; text-transform: uppercase; letter-spacing: .5px; line-height: 1.3; clear: both; display: block; border-top: 1px solid #333; }',
            '#fbe-panel h4:first-of-type { border-top: none; padding-top: 0; margin-top: 14px; }',
            '#fbe-panel .fbe-sub { color: #ddd; font-size: 11px; margin-bottom: 8px; line-height: 1.5; display: block; }',
            '#fbe-panel .fbe-line { display: block; padding: 2px 0; color: #eee; line-height: 1.5; }',
            '#fbe-panel a { color: #6cf; text-decoration: none; }',
            '#fbe-panel a:hover { text-decoration: underline; }',
            '#fbe-panel input[type=password], #fbe-panel input[type=text], #fbe-panel input[type=number] { padding: 6px 8px; background: #111; border: 1px solid #555; color: #fff; border-radius: 3px; box-sizing: border-box; font-family: monospace; font-size: 12px; }',
            '#fbe-panel input[type=password], #fbe-panel input[type=text] { width: 100%; }',
            '#fbe-panel input[type=number] { width: 90px; }',
            '#fbe-panel button { padding: 6px 12px; background: #2a2a2a; border: 1px solid #666; color: #fff; border-radius: 3px; cursor: pointer; margin-right: 6px; font-size: 12px; }',
            '#fbe-panel button:hover { background: #3a3a3a; border-color: #888; }',
            '#fbe-panel button:disabled { opacity: .55; cursor: default; }',
            '#fbe-panel .fbe-row { display: block; margin: 0 0 10px 0; }',
            '#fbe-panel .fbe-msg { padding: 6px 10px; border-radius: 3px; margin-top: 8px; font-size: 11px; line-height: 1.5; display: block; }',
            '#fbe-panel .fbe-msg.ok { background: #143; color: #dfd; border: 1px solid #275; }',
            '#fbe-panel .fbe-msg.warn { background: #432; color: #fed; border: 1px solid #864; }',
            '#fbe-panel .fbe-msg.err { background: #422; color: #fdd; border: 1px solid #744; }',

            '#fbe-panel .fbe-tbl-wrap { overflow-x: auto; margin: 8px 0 6px 0; -webkit-overflow-scrolling: touch; }',
            '#fbe-panel .fbe-tbl { width: auto; min-width: 100%; border-collapse: collapse; table-layout: auto; color: #eee; }',
            '#fbe-panel .fbe-tbl th, #fbe-panel .fbe-tbl td { padding: 6px 14px; border-bottom: 1px solid #333; text-align: left; font-size: 11px; line-height: 1.4; white-space: nowrap; vertical-align: top; color: #eee; }',
            '#fbe-panel .fbe-tbl th { color: #fc6; font-weight: normal; background: #222; border-bottom: 1px solid #555; }',
            '#fbe-panel .fbe-tbl td.num, #fbe-panel .fbe-tbl th.num { text-align: right; font-family: Consolas, "Courier New", monospace; font-variant-numeric: tabular-nums; }',
            '#fbe-panel .fbe-tbl tr:hover td { background: #232323; }',
            '#fbe-panel .fbe-tbl tr.fbe-top td { background: #1f2a1f; }',
            '#fbe-panel .fbe-tbl tr.fbe-row-picked td { background: #2a261a; }',
            '#fbe-panel .fbe-tbl tr.fbe-row-unlocked td { background: #18221a; }',
            '#fbe-panel .fbe-tbl tr.fbe-row-totals td { background: #1a1f2a; border-top: 2px solid #666; font-weight: bold; }',
            '#fbe-panel .fbe-tbl td.fbe-source-tree { color: #cfc; }',
            '#fbe-panel .fbe-tbl td.fbe-source-unknown { color: #f99; }',

            '#fbe-panel .fbe-credit { margin-top: 14px; padding-top: 10px; border-top: 1px solid #333; font-size: 11px; color: #ddd; }',
            '#fbe-panel .fbe-current-key { font-family: monospace; color: #fff; font-size: 11px; margin-top: 4px; display: block; }',
            '#fbe-panel code { background: #111; padding: 1px 5px; border-radius: 3px; color: #fff; font-family: Consolas, "Courier New", monospace; }',

            '#fbe-panel #fbe-calc-breakdown { background: #111; border: 1px solid #333; border-radius: 4px; padding: 10px 12px; margin-top: 8px; color: #eee; }',
            '#fbe-panel #fbe-calc-breakdown h5 { margin: 14px 0 4px 0; font-size: 12px; color: #fc6; text-transform: uppercase; letter-spacing: .5px; }',
            '#fbe-panel #fbe-calc-breakdown h5:first-child { margin-top: 0; }',
            '#fbe-panel #fbe-calc-breakdown h6 { margin: 10px 0 4px 0; font-size: 11px; color: #8cf; font-weight: normal; text-transform: none; letter-spacing: 0; }',
            '#fbe-panel #fbe-calc-breakdown .fbe-subtree-summary { color: #aaa; font-size: 11px; margin-left: 6px; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    function buildPanel() {
        var wrap = document.createElement('div');
        wrap.id = 'fbe-panel';
        var startOpen = storageGet(STORAGE_PANEL_OPEN, false) === true;
        wrap.style.display = startOpen ? 'block' : 'none';

        var savedKey = storageGet(STORAGE_API_KEY, '');
        var targetNeeded = storageGet(STORAGE_TARGET_NEEDED, 7);
        var windowDays = storageGet(STORAGE_HISTORY_WINDOW, 0);
        var history = storageGet(STORAGE_HISTORY, []);
        var historyCount = Array.isArray(history) ? history.length : 0;

        wrap.innerHTML = [
            '<h3>' + SCRIPT_NAME + '</h3>',
            '<div class="fbe-sub">Version ' + SCRIPT_VERSION + '</div>',

            '<h4>Estimator</h4>',
            '<div class="fbe-sub">For every special branch your faction has opened, the script reads the highest level reached per sub-tree from <code>faction.upgrades</code>, expands it to levels I..N using the canonical <code>v2/torn/factiontree</code> endpoint, and sums every level\'s respect cost. The v2 endpoint carries <code>name</code> + <code>cost</code> for every upgrade in the game and is treated as authoritative; <code>faction.upgrades.basecost</code> is the only fallback. The estimator then picks the N cheapest <i>locked</i> upgrades across all sub-trees and divides their total cost by your respect-per-day rate. Cost sources are colour-coded in the breakdown: green = v2 tree, red = unknown.</div>',
            '<div class="fbe-row">',
            '  <label class="fbe-sub" style="display:inline-block; margin-right:8px">Specialist upgrades still needed to open the next branch:</label>',
            '  <input type="number" id="fbe-target-needed" min="1" max="100" value="' + targetNeeded + '" />',
            '</div>',
            '<div class="fbe-row">',
            '  <label class="fbe-sub" style="display:inline-block; margin-right:8px">Days of history to use for the respect rate (0 = use everything):</label>',
            '  <input type="number" id="fbe-history-window" min="0" max="3650" value="' + windowDays + '" />',
            '</div>',
            '<div class="fbe-row">',
            '  <button id="fbe-run">Run estimate</button>',
            '  <button id="fbe-load-history">Load historical data file</button>',
            '  <button id="fbe-clear-history">Reset respect history</button>',
            '  <input type="file" id="fbe-history-file" accept=".tsv,.csv,.txt" style="display:none" />',
            '</div>',
            '<div class="fbe-sub" id="fbe-history-status">Snapshots stored: ' + historyCount + '. Use Load historical data file for a tab-separated file with columns: Day, Date (DD-MM-YYYY), Respect Start, Respect End, Daily Accrued, Running Total, Comment.</div>',
            '<div id="fbe-results"></div>',

            '<h4>Historical respect snapshots</h4>',
            '<div class="fbe-sub">All stored snapshots, aggregated by UTC date (end-of-day respect) and shown newest first. The "When" column says how long ago that date was.</div>',
            '<div class="fbe-row">',
            '  <button id="fbe-toggle-history">' + (storageGet(STORAGE_SHOW_HISTORY, false) === true ? 'Hide history' : 'Show history') + '</button>',
            '</div>',
            '<div id="fbe-history-viewer" style="display:' + (storageGet(STORAGE_SHOW_HISTORY, false) === true ? 'block' : 'none') + '"></div>',

            '<h4>API key</h4>',
            '<div class="fbe-sub">Requires a Torn API key with at minimum <b>Limited Access</b> permissions (a Public key is not sufficient — faction data is gated). The key is stored locally in your browser via the Tampermonkey storage for this script only. It is never sent anywhere except <code>api.torn.com</code> and is not shared with the script author or any third party. The key is used to (1) verify the key is valid by reading your User basic info, (2) read your faction\'s current respect and age, (3) read the canonical respect cost ladder via <code>v2/torn/factiontree</code>, (4) read your faction\'s currently unlocked upgrades, and (5) record periodic respect snapshots locally so a real rate (rather than a lifetime average) can be calculated.</div>',
            '<div class="fbe-current-key" id="fbe-current-key">' + (savedKey ? 'Stored key: ' + maskKey(savedKey) : 'No key stored.') + '</div>',
            '<div class="fbe-row" style="margin-top:6px">',
            '  <input type="password" id="fbe-api-input" placeholder="Paste a new API key to replace any existing one" autocomplete="off" />',
            '</div>',
            '<div class="fbe-row">',
            '  <button id="fbe-save-api">Save key</button>',
            '  <button id="fbe-test-api">Test API</button>',
            '</div>',
            '<div id="fbe-api-msg"></div>',

            '<div class="fbe-credit">Written by <a href="https://www.torn.com/profiles.php?XID=' + AUTHOR_ID + '" target="_blank" rel="noopener">' + AUTHOR_NAME + ' [' + AUTHOR_ID + ']</a></div>'
        ].join('');

        return wrap;
    }

    function refreshHistoryStatus(panel) {
        var el = panel.querySelector('#fbe-history-status');
        if (!el) {
            return;
        }
        var history = storageGet(STORAGE_HISTORY, []);
        var n = Array.isArray(history) ? history.length : 0;
        var extra = '';
        if (n >= 1) {
            var first = history[0];
            var last = history[history.length - 1];
            extra = ' Range: ' + formatDateDMY(first.t) + ' to ' + formatDateDMY(last.t) + '.';
        }
        el.textContent = 'Snapshots stored: ' + n + '.' + extra + ' Use Load historical data file for a tab-separated file with columns: Day, Date (DD-MM-YYYY), Respect Start, Respect End, Daily Accrued, Running Total, Comment.';
    }

    function bindPanel(panel) {
        var runBtn = panel.querySelector('#fbe-run');
        var loadHistBtn = panel.querySelector('#fbe-load-history');
        var clearBtn = panel.querySelector('#fbe-clear-history');
        var historyFile = panel.querySelector('#fbe-history-file');
        var saveBtn = panel.querySelector('#fbe-save-api');
        var testBtn = panel.querySelector('#fbe-test-api');
        var apiInput = panel.querySelector('#fbe-api-input');
        var apiMsg = panel.querySelector('#fbe-api-msg');
        var currentKeyEl = panel.querySelector('#fbe-current-key');
        var results = panel.querySelector('#fbe-results');
        var targetInput = panel.querySelector('#fbe-target-needed');
        var historyWindowInput = panel.querySelector('#fbe-history-window');
        var toggleHistoryBtn = panel.querySelector('#fbe-toggle-history');
        var historyViewer = panel.querySelector('#fbe-history-viewer');

        function showApiMsg(text, cls) {
            apiMsg.innerHTML = '<div class="fbe-msg ' + (cls || 'ok') + '">' + text + '</div>';
        }
        function showResultsMsg(text, cls) {
            results.innerHTML = '<div class="fbe-msg ' + (cls || 'ok') + '">' + text + '</div>';
        }

        targetInput.addEventListener('change', function () {
            var v = parseInt(targetInput.value, 10);
            if (isNaN(v) || v < 1) {
                v = 1;
            }
            storageSet(STORAGE_TARGET_NEEDED, v);
        });

        historyWindowInput.addEventListener('change', function () {
            var v = parseInt(historyWindowInput.value, 10);
            if (isNaN(v) || v < 0) {
                v = 0;
            }
            storageSet(STORAGE_HISTORY_WINDOW, v);
            // Re-render the estimate so the rate updates with the new window.
            if (storageGet(STORAGE_API_KEY, '')) {
                runEstimate(results, panel);
            }
        });

        toggleHistoryBtn.addEventListener('click', function () {
            var visible = historyViewer.style.display !== 'none';
            if (visible) {
                historyViewer.style.display = 'none';
                toggleHistoryBtn.textContent = 'Show history';
                storageSet(STORAGE_SHOW_HISTORY, false);
            } else {
                refreshHistoryViewer(panel);
                historyViewer.style.display = 'block';
                toggleHistoryBtn.textContent = 'Hide history';
                storageSet(STORAGE_SHOW_HISTORY, true);
            }
        });

        // Populate viewer if it starts open.
        if (storageGet(STORAGE_SHOW_HISTORY, false) === true) {
            refreshHistoryViewer(panel);
        }

        saveBtn.addEventListener('click', function () {
            var key = (apiInput.value || '').trim();
            if (!key) {
                showApiMsg('No key entered.', 'err');
                return;
            }
            storageSet(STORAGE_API_KEY, key);
            apiInput.value = '';
            currentKeyEl.textContent = 'Stored key: ' + maskKey(key);
            showApiMsg('API key saved. Any previous key was replaced.', 'ok');
            updateHeaderStatus();
        });

        testBtn.addEventListener('click', function () {
            var stored = storageGet(STORAGE_API_KEY, '');
            var key = (apiInput.value || '').trim() || stored;
            if (!key) {
                showApiMsg('No API key to test. Enter one and click Save first.', 'err');
                return;
            }
            showApiMsg('Testing…', 'ok');
            apiCall('user', 'basic', key, function (err, data) {
                if (err) {
                    showApiMsg('Failed: ' + (err.error || 'Unknown error'), 'err');
                    return;
                }
                var name = (data && data.name) ? data.name : '?';
                var pid = (data && data.player_id) ? data.player_id : '?';
                showApiMsg('Connected OK. Authenticated as ' + escapeHtml(name) + ' [' + escapeHtml(String(pid)) + '].', 'ok');
            });
        });

        clearBtn.addEventListener('click', function () {
            storageSet(STORAGE_HISTORY, []);
            refreshHistoryStatus(panel);
            refreshHistoryViewer(panel);
            showResultsMsg('Respect history cleared. The next run will start a fresh rate baseline.', 'ok');
        });

        loadHistBtn.addEventListener('click', function () {
            historyFile.click();
        });

        historyFile.addEventListener('change', function () {
            var f = historyFile.files && historyFile.files[0];
            if (!f) {
                return;
            }
            var reader = new FileReader();
            reader.onload = function () {
                try {
                    var parsed = parseHistoricalTSV(reader.result);
                    if (parsed.snapshots.length === 0) {
                        showResultsMsg('No usable rows found in the file. Check the format: tab-separated, second column DD-MM-YYYY, fourth column Respect End.', 'err');
                        historyFile.value = '';
                        return;
                    }
                    var existing = storageGet(STORAGE_HISTORY, []);
                    if (!Array.isArray(existing)) {
                        existing = [];
                    }
                    var merged = mergeSnapshots(existing, parsed.snapshots);
                    storageSet(STORAGE_HISTORY, merged);
                    refreshHistoryStatus(panel);
                    refreshHistoryViewer(panel);
                    var firstNew = parsed.snapshots[0];
                    var lastNew = parsed.snapshots[parsed.snapshots.length - 1];
                    showResultsMsg(
                        'Loaded ' + parsed.snapshots.length + ' snapshot(s) from file ' +
                        '(' + formatDateDMY(firstNew.t) + ' to ' + formatDateDMY(lastNew.t) + '), ' +
                        parsed.skipped + ' row(s) skipped. ' +
                        'Total snapshots stored: ' + merged.length + '. Click Run estimate to use them.',
                        'ok'
                    );
                } catch (err) {
                    console.error(LOG_TAG, 'TSV load error', err);
                    showResultsMsg('Failed to parse historical file: ' + escapeHtml(err.message || String(err)), 'err');
                }
                historyFile.value = '';
            };
            reader.onerror = function () {
                console.error(LOG_TAG, 'File read error', reader.error);
                showResultsMsg('Failed to read the file (see console).', 'err');
                historyFile.value = '';
            };
            reader.readAsText(f);
        });

        runBtn.addEventListener('click', function () {
            runEstimate(results, panel);
        });
    }

    function fetchFactionTree(key, callback) {
        // Prefer v2; fall back to v1 automatically. Always returns
        // { source: 'v2'|'v1'|'none', tree, err } so callers can attribute.
        apiV2Call('torn/factiontree', key, function (errV2, dataV2) {
            if (!errV2 && dataV2) {
                var tree2 = (dataV2 && dataV2.factiontree) ? dataV2.factiontree : dataV2;
                callback(null, { source: 'v2', tree: tree2 });
                return;
            }
            apiCall('torn', 'factiontree', key, function (errV1, dataV1) {
                if (errV1) {
                    callback({ error: (errV2 && errV2.error) || errV1.error || 'Unknown' }, { source: 'none', tree: null });
                    return;
                }
                var tree1 = (dataV1 && dataV1.factiontree) ? dataV1.factiontree : dataV1;
                callback(null, { source: 'v1', tree: tree1 });
            });
        });
    }

    function runEstimate(resultsEl, panel) {
        var key = storageGet(STORAGE_API_KEY, '');
        if (!key) {
            resultsEl.innerHTML = '<div class="fbe-msg err">An API key is required. Add one below and try again.</div>';
            return;
        }
        resultsEl.innerHTML = '<div class="fbe-msg ok">Fetching faction data and the v2 cost ladder…</div>';

        var factionData = null;
        var treeRaw = null;
        var treeSource = 'none';
        var factionErr = null;
        var treeErr = null;
        var completed = 0;

        function check() {
            completed += 1;
            if (completed < 2) {
                return;
            }
            if (!factionData) {
                resultsEl.innerHTML = '<div class="fbe-msg err">Faction API call failed: ' + escapeHtml((factionErr && factionErr.error) || 'Unknown') + '</div>';
                return;
            }
            try {
                renderEstimate(resultsEl, factionData, treeRaw, treeSource, treeErr);
                if (panel) {
                    refreshHistoryStatus(panel);
                    refreshHistoryViewer(panel);
                }
            } catch (e) {
                console.error(LOG_TAG, 'renderEstimate failed', e);
                resultsEl.innerHTML = '<div class="fbe-msg err">Failed to render estimate (see console).</div>';
            }
        }

        apiCall('faction', 'basic,upgrades', key, function (err, data) {
            if (err) {
                factionErr = err;
            } else {
                factionData = data;
            }
            check();
        });

        fetchFactionTree(key, function (err, info) {
            if (err) {
                treeErr = err;
                treeSource = (info && info.source) || 'none';
            } else {
                treeRaw = info.tree;
                treeSource = info.source;
            }
            check();
        });
    }

    // ---------- Core summary ----------
    function renderCoreSummary(coreRow) {
        var html = [];
        html.push('<h4>Core summary</h4>');
        if (!coreRow || coreRow.unlockedCount === 0) {
            html.push('<div class="fbe-sub">Nothing unlocked in Core yet.</div>');
            return html.join('');
        }
        html.push('<div class="fbe-sub">Core upgrades are individual progressions (Member Capacity, Armoury, Branches, Territories, Chaining, Organized Crimes, etc.) and aren\'t gated behind a branch tier, so the cheapest-N-to-next-tier estimate doesn\'t apply here.</div>');

        var bySubTree = {};
        coreRow.unlockedList.forEach(function (u) {
            var key = u.subTree || u.name || 'Other';
            if (!bySubTree[key]) {
                bySubTree[key] = [];
            }
            bySubTree[key].push(u);
        });

        var keys = Object.keys(bySubTree);
        keys.sort(function (a, b) {
            var aSpent = bySubTree[a].reduce(function (s, u) { return s + (u.basecost || 0); }, 0);
            var bSpent = bySubTree[b].reduce(function (s, u) { return s + (u.basecost || 0); }, 0);
            if (aSpent !== bSpent) {
                return bSpent - aSpent;
            }
            return a.localeCompare(b);
        });

        html.push('<div class="fbe-tbl-wrap"><table class="fbe-tbl">');
        html.push('<thead><tr><th>Sub-tree</th><th>Highest level</th><th class="num">Levels unlocked</th><th class="num">Spent on this sub-tree</th></tr></thead><tbody>');
        var totalSpent = 0;
        var totalUnlocked = 0;
        keys.forEach(function (k) {
            var items = bySubTree[k];
            var top = items.slice().sort(function (a, b) { return (b.level || 0) - (a.level || 0); })[0];
            var highestLabel = (top && top.levelText) ? top.levelText : '—';
            var spent = items.reduce(function (s, u) { return s + (u.basecost || 0); }, 0);
            var unknownCount = items.filter(function (u) { return !u.basecost; }).length;
            totalSpent += spent;
            totalUnlocked += items.length;
            var spentCell = formatNumber(spent);
            if (unknownCount > 0) {
                spentCell += ' <span style="color:#f99">(' + unknownCount + ' lvl cost unknown)</span>';
            }
            html.push('<tr>' +
                '<td>' + escapeHtml(k) + '</td>' +
                '<td>' + escapeHtml(highestLabel) + '</td>' +
                '<td class="num">' + items.length + '</td>' +
                '<td class="num">' + spentCell + '</td>' +
                '</tr>');
        });
        html.push('<tr class="fbe-row-totals">' +
            '<td>Total</td>' +
            '<td></td>' +
            '<td class="num">' + totalUnlocked + '</td>' +
            '<td class="num">' + formatNumber(totalSpent) + '</td>' +
            '</tr>');
        html.push('</tbody></table></div>');
        if (coreRow.unknownLevels > 0) {
            html.push('<div class="fbe-sub" style="color:#f99">Note: ' + coreRow.unknownLevels + ' Core level(s) have no cost data — the v2 tree didn\'t return a value for them.</div>');
        }
        return html.join('');
    }

    // ---------- calculation breakdown ----------
    function sourceLabel(s) {
        if (s === 'tree') {
            return 'v2 tree';
        }
        if (s === 'api') {
            return 'API';
        }
        return 'unknown';
    }

    function sourceCellClass(s) {
        if (s === 'tree') {
            return ' fbe-source-tree';
        }
        if (s === 'unknown' || !s) {
            return ' fbe-source-unknown';
        }
        return '';
    }

    function renderUnlockedSubTreeTable(items) {
        items.sort(function (a, b) {
            if (a.level && b.level && a.level !== b.level) {
                return a.level - b.level;
            }
            return (a.name || '').localeCompare(b.name || '');
        });
        var html = ['<div class="fbe-tbl-wrap"><table class="fbe-tbl">'];
        html.push('<thead><tr><th>Level</th><th>Name</th><th class="num">Base cost</th><th>Source</th></tr></thead><tbody>');
        items.forEach(function (u) {
            html.push('<tr class="fbe-row-unlocked">' +
                '<td>' + escapeHtml(u.levelText || '—') + '</td>' +
                '<td>' + escapeHtml(u.name || '?') + '</td>' +
                '<td class="num' + sourceCellClass(u.costSource) + '">' + formatNumber(u.basecost || 0) + '</td>' +
                '<td>' + sourceLabel(u.costSource) + '</td>' +
                '</tr>');
        });
        html.push('</tbody></table></div>');
        return html.join('');
    }

    function renderBranchUnlockedSubTrees(b) {
        var items = b.unlockedList.slice();
        if (items.length === 0) {
            return '<div class="fbe-line"><i>Nothing unlocked in this branch yet.</i></div>';
        }

        var bySubTree = {};
        items.forEach(function (u) {
            var key = u.subTree || 'Other';
            if (!bySubTree[key]) {
                bySubTree[key] = [];
            }
            bySubTree[key].push(u);
        });

        var subTreeKeys = Object.keys(bySubTree);
        subTreeKeys.sort(function (a, b2) {
            if (bySubTree[a].length !== bySubTree[b2].length) {
                return bySubTree[b2].length - bySubTree[a].length;
            }
            return a.localeCompare(b2);
        });

        var html = [];
        subTreeKeys.forEach(function (st) {
            var subItems = bySubTree[st];
            var spent = subItems.reduce(function (s, u) { return s + (u.basecost || 0); }, 0);
            var top = subItems.slice().sort(function (a, b3) { return (b3.level || 0) - (a.level || 0); })[0];
            var highest = (top && top.levelText) ? top.levelText : '—';
            html.push('<h6>' + escapeHtml(st) + ' <span class="fbe-subtree-summary">— ' + subItems.length + ' unlocked (highest: ' + escapeHtml(highest) + ', ' + formatNumber(spent) + ' respect spent — sum of levels I..' + escapeHtml(highest) + ')</span></h6>');
            html.push(renderUnlockedSubTreeTable(subItems));
        });
        return html.join('');
    }

    function renderCheapestNTable(picked) {
        var html = ['<div class="fbe-tbl-wrap"><table class="fbe-tbl">'];
        html.push('<thead><tr><th>#</th><th>Sub-tree</th><th>Upgrade</th><th class="num">Base cost</th><th class="num">Running total</th><th>Source</th></tr></thead><tbody>');
        var running = 0;
        picked.forEach(function (u, idx) {
            running += (u.basecost || 0);
            html.push('<tr class="fbe-row-picked">' +
                '<td class="num">' + (idx + 1) + '</td>' +
                '<td>' + escapeHtml(u.subTree || '—') + '</td>' +
                '<td>' + escapeHtml(u.name || '?') + '</td>' +
                '<td class="num' + sourceCellClass(u.costSource) + '">' + formatNumber(u.basecost) + '</td>' +
                '<td class="num">' + formatNumber(running) + '</td>' +
                '<td>' + sourceLabel(u.costSource) + '</td>' +
                '</tr>');
        });
        html.push('</tbody></table></div>');
        return html.join('');
    }

    function buildCalcBreakdown(history, rateInfo, branchRows, targetNeeded, usedTree, treeSource) {
        var parts = [];

        parts.push('<h5>Respect rate</h5>');
        if (rateInfo.source === 'snapshots' && history.length >= 2) {
            var first = history[0];
            var last = history[history.length - 1];
            parts.push('<div class="fbe-line">Source: ' + history.length + ' stored snapshot(s) (combined from any uploaded TSV plus live API recordings).</div>');
            parts.push('<div class="fbe-line">Earliest snapshot: ' + formatDateDMY(first.t) + ' → ' + formatNumber(first.r) + ' respect.</div>');
            parts.push('<div class="fbe-line">Latest snapshot: ' + formatDateDMY(last.t) + ' → ' + formatNumber(last.r) + ' respect.</div>');
            parts.push('<div class="fbe-line">Gained ' + formatNumber(last.r - first.r) + ' respect over ' + formatDuration(last.t - first.t) + '.</div>');
            parts.push('<div class="fbe-line">Rate = ' + formatNumber(last.r - first.r) + ' ÷ ' + formatNumber((last.t - first.t) / 86400) + ' days = <b>' + formatNumber(rateInfo.rate * 86400) + ' respect / day</b>.</div>');
        } else if (rateInfo.source === 'lifetime') {
            var totalResp = rateInfo.rate * rateInfo.span;
            var ageDays = rateInfo.span / 86400;
            parts.push('<div class="fbe-line">Source: lifetime average (fewer than 2 snapshots stored — upload a TSV or re-run later to get a tighter rolling rate).</div>');
            parts.push('<div class="fbe-line">Rate = total respect ÷ faction age = ' + formatNumber(totalResp) + ' ÷ ' + formatNumber(ageDays) + ' days = <b>' + formatNumber(rateInfo.rate * 86400) + ' respect / day</b>.</div>');
        } else {
            parts.push('<div class="fbe-line">No data available to calculate a rate yet.</div>');
        }

        if (usedTree) {
            parts.push('<h5>Cost ladder source</h5>');
            if (treeSource === 'v2') {
                parts.push('<div class="fbe-line">Costs loaded from the canonical v2 endpoint <code>https://api.torn.com/v2/torn/factiontree</code>.</div>');
            } else if (treeSource === 'v1') {
                parts.push('<div class="fbe-line">v2 endpoint unavailable — falling back to the v1 endpoint. v1 doesn\'t carry cost data, so figures come from faction.upgrades only.</div>');
            }
        }

        branchRows.forEach(function (b) {
            var heading = b.isCore
                ? (escapeHtml(b.branch) + ' branch (individual progressions, no tier gate)')
                : (escapeHtml(b.branch) + ' branch (multiplier: ' + b.branchMultiplier + 'x)');
            parts.push('<h5>' + heading + '</h5>');

            if (b.unlockedCount === 0) {
                parts.push('<div class="fbe-line"><i>Nothing unlocked in this branch yet.</i></div>');
                return;
            }

            parts.push('<div class="fbe-line"><b>' + b.unlockedCount + ' individual level(s) unlocked</b> in this branch. Cumulative respect spent: <b>' + formatNumber(b.spentSoFar) + '</b>.</div>');
            if (b.unknownLevels > 0) {
                parts.push('<div class="fbe-line" style="color:#f99">' + b.unknownLevels + ' level(s) have no cost data available — the total is a lower bound.</div>');
            }

            parts.push(renderBranchUnlockedSubTrees(b));

            if (b.isCore) {
                parts.push('<div class="fbe-line"><i>The cheapest-N-to-next-tier calculation is skipped for Core because Core has no branch-tier gate.</i></div>');
                return;
            }

            if (b.lockedWithCostCount === 0) {
                parts.push('<div class="fbe-line" style="color:#f99">No locked upgrades with known costs in this branch — cheapest-N estimate not available.</div>');
                return;
            }
            var picked = b.cheapestPicked;
            var showN = Math.min(picked.length, targetNeeded);
            parts.push('<h6>Cheapest ' + showN + ' locked upgrade(s) across all sub-trees — the path the estimate uses</h6>');
            parts.push(renderCheapestNTable(picked));
            parts.push('<div class="fbe-line">Sum of cheapest ' + showN + ' = <b>' + formatNumber(b.cheapestPickedCost) + ' respect</b>.</div>');
            if (rateInfo.rate > 0) {
                var dailyRate = rateInfo.rate * 86400;
                parts.push('<div class="fbe-line">At ' + formatNumber(dailyRate) + ' respect / day: ' + formatNumber(b.cheapestPickedCost) + ' ÷ ' + formatNumber(dailyRate) + ' = <b>' + formatDuration(b.cheapestPickedCost / rateInfo.rate) + '</b>.</div>');
            } else {
                parts.push('<div class="fbe-line">Can\'t convert to time — no usable respect rate yet.</div>');
            }
            if (picked.length < targetNeeded) {
                parts.push('<div class="fbe-line"><i>Note: only ' + picked.length + ' locked upgrades with a known cost are available in this branch (you asked for ' + targetNeeded + ').</i></div>');
            }
        });

        return parts.join('');
    }

    function renderEstimate(resultsEl, factionData, treeRaw, treeSource, treeErr) {
        var respect = (factionData && typeof factionData.respect !== 'undefined') ? factionData.respect : 0;
        var ageDays = (factionData && typeof factionData.age !== 'undefined') ? factionData.age : 0;
        var name = (factionData && factionData.name) ? factionData.name : '?';
        var upgrades = (factionData && factionData.upgrades) ? factionData.upgrades : {};

        var history = recordRespectSnapshot(respect);
        var windowDays = parseInt(storageGet(STORAGE_HISTORY_WINDOW, 0), 10);
        if (isNaN(windowDays) || windowDays < 0) {
            windowDays = 0;
        }
        var rateInfo = calculateRespectRate(history, ageDays, respect, windowDays);
        var ratePerDay = rateInfo.rate * 86400;

        var targetNeeded = parseInt(storageGet(STORAGE_TARGET_NEEDED, 7), 10);
        if (isNaN(targetNeeded) || targetNeeded < 1) {
            targetNeeded = 7;
        }

        var treeEntries = treeRaw ? flattenFactionTree(treeRaw) : [];
        var usedTree = treeEntries.length > 0;
        var branchRows;
        if (usedTree) {
            branchRows = summariseBranchesFromTree(treeEntries, upgrades, targetNeeded);
        } else {
            branchRows = summariseBranchesFromUnlockedOnly(upgrades);
        }

        var coreRow = null;
        var specialRows = [];
        branchRows.forEach(function (b) {
            if (b.isCore) {
                coreRow = b;
            } else {
                specialRows.push(b);
            }
        });

        var rateNote;
        if (rateInfo.source === 'snapshots') {
            var snapshotsNote = ' from ' + (rateInfo.snapshotsUsed || history.length) + ' snapshot(s)';
            if (rateInfo.windowApplied) {
                snapshotsNote += ' within the last ' + rateInfo.windowDays + ' day(s) of ' + (rateInfo.snapshotsTotal || history.length) + ' stored';
            }
            rateNote = ' (rolling, ' + formatDuration(rateInfo.span) + snapshotsNote + ')';
        } else if (rateInfo.source === 'lifetime') {
            rateNote = ' (lifetime average — upload a TSV or re-run later for a tighter rolling rate)';
        } else {
            rateNote = ' (no usable data yet)';
        }

        var html = [];

        if (!usedTree) {
            var treeReason = treeErr ? ('error: ' + escapeHtml((treeErr && treeErr.error) || 'Unknown')) : 'no entries parsed';
            html.push('<div class="fbe-msg warn">Couldn\'t load the faction tree (' + treeReason + '). Working from unlocked entries only — locked-side picks won\'t be available.</div>');
        } else if (treeSource === 'v1') {
            html.push('<div class="fbe-msg warn">v2 factiontree endpoint unavailable — fell back to v1, which doesn\'t carry cost data. Costs will come from faction.upgrades only.</div>');
        }

        html.push('<h4>Faction</h4>');
        html.push('<div class="fbe-line">' + escapeHtml(name) + '</div>');
        html.push('<div class="fbe-line">Current respect: ' + formatNumber(respect) + '</div>');
        html.push('<div class="fbe-line">Faction age: ' + formatNumber(ageDays) + ' days</div>');
        html.push('<div class="fbe-line">Estimated respect/day: ' + formatNumber(ratePerDay) + rateNote + '</div>');
        if (usedTree) {
            html.push('<div class="fbe-line">Cost ladder: ' + (treeSource === 'v2' ? '<b style="color:#cfc">v2 factiontree (canonical)</b>' : 'v1 factiontree (no costs — faction.upgrades only)') + ', ' + treeEntries.length + ' tree entries loaded.</div>');
        }

        // Headline: best (shortest) time to open the next branch, across all
        // special branches the faction has opened.
        var bestRow = null;
        specialRows.forEach(function (b) {
            if (b.cheapestPickedCost > 0 && b.cheapestPicked.length > 0) {
                if (!bestRow || b.cheapestPickedCost < bestRow.cheapestPickedCost) {
                    bestRow = b;
                }
            }
        });
        if (bestRow && rateInfo.rate > 0) {
            var bestDuration = formatDuration(bestRow.cheapestPickedCost / rateInfo.rate);
            var bestDays = bestRow.cheapestPickedCost / (rateInfo.rate * 86400);
            html.push('<div class="fbe-line" style="margin-top:8px; padding:8px 12px; background:#1f2a1f; border:1px solid #275; border-radius:4px; color:#cfc; font-size:13px">' +
                '<b>Next branch unlocks in ' + bestDuration + '</b> ' +
                '(' + formatNumber(Math.ceil(bestDays)) + ' days at the current rate — cheapest ' + targetNeeded + ' upgrades in ' + escapeHtml(bestRow.branch) + ', costing ' + formatNumber(bestRow.cheapestPickedCost) + ' respect).' +
                '</div>');
        } else if (specialRows.length > 0 && rateInfo.rate <= 0) {
            html.push('<div class="fbe-line" style="margin-top:8px; padding:8px 12px; background:#432; border:1px solid #864; border-radius:4px; color:#fed; font-size:12px">' +
                'Need a respect rate before an unlock time can be shown. Load a TSV history file or re-run the estimate after some time passes.' +
                '</div>');
        }

        html.push(renderCoreSummary(coreRow));

        html.push('<h4>Special branches your faction has opened</h4>');
        if (specialRows.length === 0) {
            html.push('<div class="fbe-sub">No special branches opened yet — focus on Core upgrades until you can buy into one.</div>');
        } else {
            html.push('<div class="fbe-tbl-wrap"><table class="fbe-tbl">');
            if (usedTree) {
                html.push('<thead><tr>' +
                    '<th>Branch</th>' +
                    '<th class="num">Unlocked / Total</th>' +
                    '<th class="num">Locked</th>' +
                    '<th class="num">Spent so far</th>' +
                    '<th class="num">Cost of cheapest ' + targetNeeded + '</th>' +
                    '<th class="num">Est. time at current rate</th>' +
                    '</tr></thead>');
            } else {
                html.push('<thead><tr>' +
                    '<th>Branch</th>' +
                    '<th class="num">Unlocked</th>' +
                    '<th class="num">Spent so far</th>' +
                    '</tr></thead>');
            }
            html.push('<tbody>');
            specialRows.forEach(function (b, idx) {
                var rowClass = (idx === 0) ? ' class="fbe-top"' : '';
                if (usedTree) {
                    var costStr;
                    if (b.cheapestPicked.length === 0) {
                        costStr = '<span style="color:#f99">no cost data</span>';
                    } else {
                        costStr = formatNumber(b.cheapestPickedCost);
                        if (b.cheapestPicked.length < targetNeeded) {
                            costStr += ' (only ' + b.cheapestPicked.length + ' priced)';
                        }
                    }
                    var timeStr = (rateInfo.rate > 0 && b.cheapestPickedCost > 0) ? formatDuration(b.cheapestPickedCost / rateInfo.rate) : '—';
                    var spentStr = formatNumber(b.spentSoFar);
                    if (b.unknownLevels > 0) {
                        spentStr += ' <span style="color:#f99">(+' + b.unknownLevels + ' unknown)</span>';
                    }
                    html.push('<tr' + rowClass + '>' +
                        '<td>' + escapeHtml(b.branch) + '</td>' +
                        '<td class="num">' + b.unlockedCount + ' / ' + b.totalCount + '</td>' +
                        '<td class="num">' + b.lockedCount + '</td>' +
                        '<td class="num">' + spentStr + '</td>' +
                        '<td class="num">' + costStr + '</td>' +
                        '<td class="num">' + timeStr + '</td>' +
                        '</tr>');
                } else {
                    html.push('<tr' + rowClass + '>' +
                        '<td>' + escapeHtml(b.branch) + '</td>' +
                        '<td class="num">' + b.unlockedCount + '</td>' +
                        '<td class="num">' + formatNumber(b.spentSoFar) + '</td>' +
                        '</tr>');
                }
            });
            html.push('</tbody></table></div>');
        }

        html.push('<div class="fbe-sub" style="margin-top:8px">');
        if (usedTree) {
            html.push('Only special branches with at least one upgrade your faction has unlocked are shown. ');
            html.push('<b>Unlocked / Total</b>: reconstructed level count vs total levels in the branch (e.g. Speed Training V means I..V all unlocked → counted as 5). ');
            html.push('<b>Spent so far</b>: sum of every reconstructed unlocked level\'s base cost, resolved against the v2 tree first, then faction.upgrades. ');
            html.push('<b>Cost of cheapest ' + targetNeeded + '</b>: sum of the ' + targetNeeded + ' cheapest locked upgrades with a known cost across all sub-trees. ');
            html.push('Open <i>Show calculation</i> for the full level-by-level breakdown with cost sources marked.');
        } else {
            html.push('Fallback mode (faction tree call failed): showing only what unlocked-entry data can produce.');
        }
        html.push('</div>');

        var showCalc = storageGet(STORAGE_SHOW_CALC, false) === true;
        html.push('<div class="fbe-row" style="margin-top:12px">');
        html.push('<button id="fbe-toggle-calc">' + (showCalc ? 'Hide calculation' : 'Show calculation') + '</button>');
        html.push('</div>');
        html.push('<div id="fbe-calc-breakdown" style="display:' + (showCalc ? 'block' : 'none') + '">');
        html.push(buildCalcBreakdown(history, rateInfo, branchRows, targetNeeded, usedTree, treeSource));
        html.push('</div>');

        resultsEl.innerHTML = html.join('');

        var toggleBtn = resultsEl.querySelector('#fbe-toggle-calc');
        var breakdown = resultsEl.querySelector('#fbe-calc-breakdown');
        if (toggleBtn && breakdown) {
            toggleBtn.addEventListener('click', function () {
                var visible = breakdown.style.display !== 'none';
                breakdown.style.display = visible ? 'none' : 'block';
                toggleBtn.textContent = visible ? 'Show calculation' : 'Hide calculation';
                storageSet(STORAGE_SHOW_CALC, !visible);
            });
        }
    }

    function updateHeaderStatus() {
        if (!statusEl) {
            return;
        }
        var key = storageGet(STORAGE_API_KEY, '');
        if (key) {
            statusEl.textContent = 'API key entered.';
            statusEl.className = 'fbe-status ok';
        } else {
            statusEl.textContent = 'API key required.';
            statusEl.className = 'fbe-status warn';
        }
    }

    // ---------- mounting ----------
    function findWarElement() {
        var candidates = document.querySelectorAll('a, span, div, li, button, p');
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var text = (el.textContent || '').trim();
            if (text.toUpperCase() !== 'WAR') {
                continue;
            }
            if (el.children && el.children.length > 0) {
                continue;
            }
            var rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.width < 240 && rect.height > 0 && rect.height < 80) {
                return el;
            }
        }
        return null;
    }

    function findPanelHost(warEl) {
        var node = warEl.parentNode;
        while (node && node !== document.body) {
            var rect = node.getBoundingClientRect();
            if (rect.width >= 400) {
                return node;
            }
            node = node.parentNode;
        }
        return document.body;
    }

    function removeUI() {
        var existingCog = document.getElementById('fbe-cog-wrap');
        if (existingCog && existingCog.parentNode) {
            existingCog.parentNode.removeChild(existingCog);
        }
        var existingPanel = document.getElementById('fbe-panel');
        if (existingPanel && existingPanel.parentNode) {
            existingPanel.parentNode.removeChild(existingPanel);
        }
        cogEl = null;
        statusEl = null;
        panelEl = null;
    }

    function mountUI() {
        if (!isOnUpgradesTab()) {
            removeUI();
            return true;
        }
        if (document.getElementById('fbe-cog-wrap')) {
            updateHeaderStatus();
            return true;
        }
        var war = findWarElement();
        if (!war) {
            return false;
        }
        injectStyles();

        var cogWrap = document.createElement('span');
        cogWrap.id = 'fbe-cog-wrap';
        cogWrap.innerHTML = '<span class="fbe-cog" title="' + SCRIPT_NAME + ' settings">⚙</span>' +
                            '<span class="fbe-status">…</span>';
        cogEl = cogWrap.querySelector('.fbe-cog');
        statusEl = cogWrap.querySelector('.fbe-status');

        var parent = war.parentNode;
        if (parent) {
            if (war.nextSibling) {
                parent.insertBefore(cogWrap, war.nextSibling);
            } else {
                parent.appendChild(cogWrap);
            }
        }

        panelEl = buildPanel();
        var host = findPanelHost(war);
        host.appendChild(panelEl);
        bindPanel(panelEl);

        cogEl.addEventListener('click', function () {
            var visible = panelEl.style.display !== 'none';
            if (visible) {
                panelEl.style.display = 'none';
                storageSet(STORAGE_PANEL_OPEN, false);
            } else {
                panelEl.style.display = 'block';
                storageSet(STORAGE_PANEL_OPEN, true);
                // Show current values immediately on open (spec: "Show current
                // values on main page"). Only auto-run when a key is stored.
                if (storageGet(STORAGE_API_KEY, '')) {
                    var resultsEl = panelEl.querySelector('#fbe-results');
                    if (resultsEl) {
                        runEstimate(resultsEl, panelEl);
                    }
                }
            }
        });

        updateHeaderStatus();

        // If the panel persisted as open across a page reload, render current
        // values immediately rather than waiting for the user to click cog.
        if (panelEl.style.display !== 'none' && storageGet(STORAGE_API_KEY, '')) {
            var initResults = panelEl.querySelector('#fbe-results');
            if (initResults) {
                runEstimate(initResults, panelEl);
            }
        }

        return true;
    }

    var attempts = 0;
    var pollInterval = setInterval(function () {
        attempts += 1;
        if (mountUI() || attempts > 60) {
            clearInterval(pollInterval);
        }
    }, 500);

    try {
        var observer = new MutationObserver(function () {
            if (isOnUpgradesTab() && !document.getElementById('fbe-cog-wrap')) {
                mountUI();
            } else if (!isOnUpgradesTab() && document.getElementById('fbe-cog-wrap')) {
                removeUI();
            }
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) {
        console.error(LOG_TAG, 'MutationObserver setup failed', e);
    }

    window.addEventListener('hashchange', function () {
        if (isOnUpgradesTab()) {
            mountUI();
        } else {
            removeUI();
        }
    });
})();
