if(!window.__bbnTest){window.__bbnTest=1;
// Benchmark Buddy for CT: Challenge Tracker overlay (read-only)
// 1) Personal Record Breakers: class time in the UOM column, PRs-by-class panel
// 2) Input Results > Class Roster: each member's current PR for the challenge of the day and
//    the speed they need to beat it, on their card and in a class sheet panel
// Only GET requests are ever made. Nothing is written back to Challenge Tracker.
(() => {
  if (window.__bbnClassTime) return;
  window.__bbnClassTime = true;

  const API = 'https://api.orangetheory.co';
  const S = {
    // PR Breakers
    pageRows: [], allRows: null, allKey: null, loadingKey: null, filter: null, collapsed: false,
    // Roster
    auth: {},              // headers the page itself uses, kept per API family (proxy, occi, ...)
    challenges: [],        // today's challenges for the studio
    roster: [],            // current class roster
    rosterClass: null,     // class info (time, coach)
    bench: new Map(),      // memberId -> { at, recs }
    benchLoading: new Set(),
    rosterCollapsed: true,
    brkSchedKey: null,     // studio|date of the schedule we last tried to pull for PR Breakers
    brkSched: null,        // classes for the PR Breakers date: [{ t, name, count, coach }]
    lead: { mode: 'tm', key: '', sid: '', cid: '', date: '', pw: null },  // Today's Challenge Leaders: treadmill (CT's own) or Power Walker
    day: null,             // Day Sheet on the Select Class Time screen (see DAY SHEET below)  // roster panel starts as a slim bar so it doesn't cover cards
  };

  // ---------- small helpers ----------
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function fmtTime(iso) {
    const m = /T(\d{2}):(\d{2})/.exec(iso || '');
    if (!m) return '';
    let h = +m[1];
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m[2]} ${ap}`;
  }
  const sortKey = (iso) => (/T(\d{2}:\d{2})/.exec(iso || '') || [])[1] || '99:99';
  const shortName = (first, last) => `${first || ''} ${(last || '').charAt(0)}.`.trim();
  const rowKey = (name, pr) => norm(name) + '|' + norm(pr);

  // "01:30" -> 90, "00:28.50" -> 28.5. Null for distance results like "4931".
  function toSecs(t) {
    const m = /^(\d+):(\d{2}(?:\.\d+)?)$/.exec(String(t || '').trim());
    return m ? +m[1] * 60 + +m[2] : null;
  }
  function fmtSplit(sec) {
    const m = Math.floor(sec / 60);
    return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
  }
  // Drop the leading zero on minutes for display: "01:49" -> "1:49"
  const fmtPR = (t) => String(t || '').replace(/^0(\d:)/, '$1');
  function distMiles(name) {
    const n = String(name || '');
    let m;
    if ((m = /([\d.]+)\s*MILE/i.exec(n))) return +m[1];
    if ((m = /([\d.]+)\s*(KM|KILOMETER)/i.exec(n))) return +m[1] * 0.621371;
    if ((m = /([\d.]+)\s*METER/i.exec(n))) return +m[1] / 1609.344;
    return null;
  }
  // ---------- benchmark targets ----------
  // Three kinds of benchmark get a "what to hold to beat it" target:
  //   'time' : treadmill/PW for a distance (0.25 MILE, 1 MILE). Target = mph, rounded UP to the next 0.1
  //            the tread can be set to. Power Walkers go half the distance (0.25 -> 0.13, 1 -> 0.5).
  //   'dist' : treadmill/PW for a time (12 MIN). Target = mph to cover MORE distance in that time,
  //            next 0.1 up. Challenge Tracker stores these in km (1.15 mi is saved as 1.8507456),
  //            so results are converted back to miles first, the same way CT's own screens do.
  //   'row'  : rower for a distance (200/500/1000/2000 METER). Target = the 500m split to hold, in whole
  //            seconds (the monitors don't show tenths on the split): the slowest one that still beats the time.
  // Each result is turned into a whole number first (seconds, thousandths of a mile, hundredths of a
  // second) and the targets are worked out with whole-number math, so the phone page gets the exact same
  // answer from the same numbers.
  const KM_PER_MI = 1.609344;
  const DRITRI_TEMPLATE = 2; // DriTri (see DRITRI_TYPES below): never gets a speed target
  function walkerMiles(miles) { return Math.round((miles / 2) * 100) / 100; }
  const titleMinutes = (t) => { const m = /(\d+(?:\.\d+)?)\s*MIN/i.exec(String(t || '')); return m ? +m[1] : null; };
  const titleMeters = (t) => { const m = /(\d+)\s*METER/i.exec(String(t || '')); return m ? +m[1] : null; };
  // Which kind of target a challenge gets on a given machine (eqId 2 tread, 7 PW, 4 rower)
  function benchKind(ch, eqId) {
    if (!ch || ch.templateId === DRITRI_TEMPLATE) return null;
    const isDist = /distance/i.test(ch.entryType || '');
    if ((eqId === 2 || eqId === 7) && !isDist && distMiles(ch.title)) return 'time';
    if ((eqId === 2 || eqId === 7) && isDist && titleMinutes(ch.title)) return 'dist';
    if (eqId === 4 && !isDist && titleMeters(ch.title)) return 'row';
    return null;
  }
  // Raw CT result -> whole number for that kind (null if it can't be read)
  function encodeResult(kind, raw) {
    if (kind === 'time') { const s = toSecs(raw); return s ? Math.round(s) : null; }
    if (kind === 'row') { const s = toSecs(raw); return s ? Math.round(s * 100) : null; }
    if (kind === 'dist') { const km = parseFloat(raw); return km > 0 ? Math.round((km / KM_PER_MI) * 1000) : null; }
    return null;
  }
  // Whole number -> target text. Same math lives in the phone page (v/index.html).
  function targetFor(kind, val, ch, eqId) {
    if (!val) return '';
    if (kind === 'time') {
      let miles = distMiles(ch.title);
      if (eqId === 7) miles = walkerMiles(miles);
      const mph = (miles * 3600) / val;
      return (Math.floor(mph * 10 + 1e-9) / 10 + 0.1).toFixed(1) + ' mph';
    }
    if (kind === 'dist') {
      const min = titleMinutes(ch.title);
      // mph x 10 = (thousandths / 1000) x (60 / min) x 10 = 3 x thousandths / (5 x min); next tenth up
      const tenths = Math.floor((3 * val) / (5 * min)) + 1;
      return (tenths / 10).toFixed(1) + ' mph';
    }
    if (kind === 'row') {
      const m = titleMeters(ch.title);
      // Our rower monitors show the 500m split in whole seconds, so the target is whole seconds too.
      // split in secs = hundredths x 500 / meters / 100 = 5 x hundredths / meters.
      // Slowest whole second that is still strictly faster: round up, then take off one second.
      const secs = Math.floor((5 * val + m - 1) / m) - 1;
      return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} /500m`;
    }
    return '';
  }
  // How a PR reads on screen
  function fmtValue(kind, val, raw) {
    if (kind === 'dist') return (val % 10 ? (val / 1000).toFixed(3) : (val / 1000).toFixed(2)) + ' mi';
    return fmtPR(raw);
  }
  const unitWord = (kind) => (kind === 'row' ? 'split' : 'mph');
  const stripUnit = (t) => String(t || '').replace(/ (mph|\/500m)$/, '');
  // Equipment we split PRs by on the roster. Bike and Strider show the PR and previous PR only:
  // no speed or pace target for those two, on purpose.
  const ROSTER_EQ = [
    { id: 2, name: 'Treadmill', short: 'TREAD' },
    { id: 7, name: 'Power Walker', short: 'PW' },
    { id: 4, name: 'Rower', short: 'ROW' },
    { id: 5, name: 'Bike', short: 'BIKE' },
    { id: 3, name: 'Strider', short: 'STRIDER' },
  ];
  const NO_TARGET_EQ = new Set([5, 3]);
  // DriTri is saved under challenge template 2 ("3.1 MILE"), but it's a row + floor + 5K all in one time,
  // so it never gets a speed target. CT tells the versions apart with ChallengeTemplateTypeId
  // (blank = the full DriTri). Relay (4) and Team (975) times are left out on purpose.
  const DRITRI_TYPES = [
    { id: null, name: 'DriTri Full', short: 'FULL' },
    { id: 3, name: 'DriTri Sprint', short: 'SPRINT' },
    { id: 18, name: 'DriTri Strength 10 lb', short: 'STRENGTH 10 LB' },
    { id: 19, name: 'DriTri Strength 12 lb', short: 'STRENGTH 12 LB' },
    { id: 20, name: 'DriTri Strength 15 lb', short: 'STRENGTH 15 LB' },
    { id: 21, name: 'DriTri Strength 20 lb', short: 'STRENGTH 20 LB' },
    { id: 22, name: 'DriTri Strength 25 lb', short: 'STRENGTH 25 LB' },
    { id: 23, name: 'DriTri Strength 30 lb', short: 'STRENGTH 30 LB' },
  ];
  const isDriTri = (ch) => !!ch && ch.templateId === DRITRI_TEMPLATE;
  // The PR groups shown for a challenge: one per machine, or for DriTri one per version per machine
  function rosterGroups(ch) {
    if (!isDriTri(ch)) return ROSTER_EQ.map((e) => ({ key: e.name, name: e.name, short: e.short, eqId: e.id }));
    const g = [];
    DRITRI_TYPES.forEach((t) => ROSTER_EQ.filter((e) => e.id !== 4).forEach((e) => g.push({
      key: `${t.name}|${e.name}`, name: `${t.name} · ${e.name}`, short: `${e.short} ${t.short}`, eqId: e.id, typeId: t.id,
    })));
    return g;
  }

  // ---------- capture what the page already loads ----------
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  const XH = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__bbn = { method: String(method).toUpperCase(), url: String(url), headers: {} };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__bbn && this.__bbn.headers) this.__bbn.headers[k] = v;
    return XH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const meta = this.__bbn;
    if (meta && !meta.skip && meta.method === 'GET' && meta.url.indexOf(API) === 0) {
      if (Object.keys(meta.headers).length) { const f = apiFamily(meta.url); S.auth[f] = { ...(S.auth[f] || {}), ...meta.headers }; }
      meta.withCredentials = this.withCredentials;
      this.addEventListener('load', () => {
        if (this.status !== 200) return;
        let j;
        try { j = JSON.parse(this.responseText); } catch (e) { return; }
        route(meta, j);
      });
    }
    return XS.apply(this, arguments);
  };

  function route(meta, j) {
    const u = meta.url;
    if (/\/personal\/breakers/i.test(u)) onBreakers(j, meta);
    else if (/\/occi\/mbo\/schedules\/\d+\/roster/i.test(u)) onRoster(j);
    else if (/\/challenges\/studio\//i.test(u) && Array.isArray(j)) { S.challenges = j; schedulePaint(); }
    else if (/\/challenge-leader\/today\/studio\/\d+\/challenge\/\d+/i.test(u)) onLeaders(u);
    else if (/\/occi\/mbo\/schedules\?/i.test(u) && j && Array.isArray(j.classes)) { saveSchedule(u, j.classes); onDaySchedule(u, j.classes); }
  }

  // ---------- class schedule (headcount + coach per class) ----------
  // Saved per studio + date so PR Breakers can show "12 of 28 PR'd". Only class times, names,
  // headcounts and coach names are kept (no logins, no member data), and only the last 14 dates.
  const SCHED_KEY = 'otfPrRadar.schedules';
  function readSchedules() { try { return JSON.parse(localStorage.getItem(SCHED_KEY)) || {}; } catch (e) { return {}; } }
  function saveSchedule(url, classes) {
    const q = new URL(url, location.href).searchParams;
    const date = q.get('ClassStartDateTime'); // YYYY/MM/DD
    const studio = q.get('studioId');
    if (!date || !studio || date !== q.get('ClassEndDateTime')) return;
    const list = classes.map((c) => ({
      t: (/T(\d{2}:\d{2})/.exec(c.classStartDateTime || '') || [])[1] || '',
      name: c.className || '',
      count: c.rosterCount || 0,
      coach: [c.coachFirstname, (c.coachLastname || '').charAt(0)].filter(Boolean).join(' ') + (c.coachLastname ? '.' : ''),
    })).filter((c) => c.t);
    const all = readSchedules();
    all[studio + '|' + date] = { at: Date.now(), list };
    const keep = Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(0, 14);
    const trimmed = {};
    keep.forEach((k) => (trimmed[k] = all[k]));
    try { localStorage.setItem(SCHED_KEY, JSON.stringify(trimmed)); } catch (e) { /* storage full or blocked */ }
    if (S.brkSchedKey === studio + '|' + date) { S.brkSched = list; schedulePaint(); }
  }
  // The MindBody studio id lives in the app's own saved state
  function mboStudioId() {
    try {
      const a = JSON.parse(localStorage.getItem('state')).auth_users;
      return (a.selectedStudio || a.currentStudio || {}).MboStudioId || null;
    } catch (e) { return null; }
  }
  // Breakers dates are MM/DD/YYYY, schedule dates are YYYY/MM/DD
  function toSchedDate(mdY) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdY || '');
    return m ? `${m[3]}/${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}` : null;
  }
  function loadBreakersSchedule(breakersUrl) {
    const q = new URL(breakersUrl, location.href).searchParams;
    const studio = q.get('studioId');
    const date = toSchedDate(q.get('date'));
    if (!studio || !date) return;
    const key = studio + '|' + date;
    if (S.brkSchedKey === key) return;
    S.brkSchedKey = key;
    const saved = readSchedules()[key];
    S.brkSched = saved ? saved.list : null;
    // Refresh from MindBody if the schedule login is available in this session (it shows up once Input Results is opened)
    const mbo = mboStudioId();
    const url = `${API}/occi/mbo/schedules?ClassStartDateTime=${date}&mboStudioId=${mbo}&ClassEndDateTime=${date}&OrderBy=EndTime&HideCanceledClasses=false&studioId=${studio}`;
    if (mbo && authFor(url)) {
      apiGet(url).then((j) => { if (j && Array.isArray(j.classes)) saveSchedule(url, j.classes); }).catch(() => {});
    }
    schedulePaint();
  }
  // Headcount for a class time. If two classes start together (e.g. Strength 50 + Tread 50),
  // add them up but leave out Strength and Open Studio unless they're the only class at that time.
  function classAt(label) {
    if (!S.brkSched) return null;
    const at = S.brkSched.filter((c) => fmtTime('T' + c.t) === label && c.count > 0 && !/open studio/i.test(c.name));
    if (!at.length) return null;
    const main = at.filter((c) => !/strength/i.test(c.name));
    const use = main.length ? main : at;
    return {
      count: use.reduce((n, c) => n + c.count, 0),
      coach: [...new Set(use.map((c) => c.coach).filter(Boolean))].join(' / '),
    };
  }

  // "/proxy/..." and "/occi/..." use different login headers, so keep them apart
  function apiFamily(url) {
    const m = /^https:\/\/api\.orangetheory\.co\/([^/?]+)/.exec(url);
    return m ? m[1] : '';
  }
  const authFor = (url) => S.auth[apiFamily(url)] || null;

  // Read-only GET using the same login headers the page uses for that part of the API
  function apiGet(url, meta) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      XO.call(x, 'GET', url);
      x.__bbn = { skip: true, headers: {} };
      x.withCredentials = !!(meta && meta.withCredentials);
      Object.entries((meta && meta.headers) || authFor(url) || {}).forEach(([k, v]) => XH.call(x, k, v));
      x.onload = () => {
        if (x.status !== 200) return reject(new Error('HTTP ' + x.status));
        try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); }
      };
      x.onerror = () => reject(new Error('network'));
      XS.call(x);
    });
  }

  // =====================================================================
  // 1) PERSONAL RECORD BREAKERS
  // =====================================================================
  function dayKey(url) {
    const u = new URL(url, location.href);
    return ['studioId', 'date', 'challengeId', 'fullTextSearch'].map((k) => u.searchParams.get(k)).join('|');
  }
  function onBreakers(json, meta) {
    S.pageRows = (json && json.Results) || [];
    loadBreakersSchedule(meta.url);
    const key = dayKey(meta.url);
    if (key !== S.allKey) {
      S.allRows = null;
      S.allKey = key;
      S.filter = null;
      loadAllBreakers(meta, key);
    }
    schedulePaint();
  }
  function loadAllBreakers(meta, key) {
    if (S.loadingKey === key) return;
    S.loadingKey = key;
    const u = new URL(meta.url, location.href);
    u.searchParams.set('pageSize', '500');
    u.searchParams.set('pageIndex', '1');
    apiGet(u.toString(), meta)
      .then((j) => { if (S.allKey === key) { S.allRows = (j && j.Results) || []; schedulePaint(); } })
      .catch(() => {})
      .finally(() => { S.loadingKey = null; });
  }
  const brkName = (r) => shortName(r.FirstName, r.LastName);
  // The PR Breakers feed keeps treadmill/PW/bike distances in km ("01.851") while CT's own table shows
  // miles ("01.150"). Convert so our panel matches the table. Times and rower meters pass through.
  function brkRec(v, r) {
    const str = String(v || '').trim();
    if (!str) return '';
    if (/:/.test(str)) return fmtPR(str);
    if (r && r.EquipmentId === 4) return str.replace(/^0+(?=\d)/, '');
    const km = parseFloat(str);
    return isNaN(km) ? str : (km / KM_PER_MI).toFixed(3);
  }
  // The exact text CT shows in its New PR column, used to line our rows up with the table's rows
  function brkUiRec(r) {
    const str = String(r.NewRecord || '').trim();
    if (!str || /:/.test(str) || r.EquipmentId === 4) return str;
    const km = parseFloat(str);
    return isNaN(km) ? str : (km / KM_PER_MI).toFixed(3).padStart(6, '0');
  }

  const onPRPage = () => /today-personal-records/i.test(location.hash);
  function headerIndex(labels) {
    const ths = [...document.querySelectorAll('.react-bs-container-header th')];
    return ths.findIndex((th) => labels.includes(th.textContent.trim().toUpperCase()));
  }

  function paintBreakersTable() {
    const ths = [...document.querySelectorAll('.react-bs-container-header th')];
    let uomIdx = ths.findIndex((th) => th.dataset.otfCol === '1');
    if (uomIdx < 0) uomIdx = ths.findIndex((th) => /^UOM$/i.test(th.textContent.trim()));
    if (uomIdx >= 0) ths[uomIdx].dataset.otfCol = '1';
    const nameIdx = headerIndex(['NAME']);
    const newIdx = headerIndex(["NEW PR'S", 'NEW PRS', 'NEW PR']);
    if (uomIdx < 0 || nameIdx < 0) return;

    const th = ths[uomIdx];
    let hs = th.querySelector('.bbn-time');
    if (!hs) {
      th.classList.add('bbn-ct');
      hs = document.createElement('span');
      hs.className = 'bbn-time';
      hs.textContent = 'CLASS TIME';
      th.appendChild(hs);
    }
    matchFont(ths[uomIdx - 1] || ths[uomIdx + 1], hs);

    const source = (S.allRows && S.allRows.length ? S.allRows : []).concat(S.pageRows);
    const lookup = new Map();
    source.forEach((r) => lookup.set(rowKey(brkName(r), brkUiRec(r)), r));

    const trs = [...document.querySelectorAll('.react-bs-container-body tbody tr')];
    trs.forEach((tr, i) => {
      const tds = tr.children;
      const td = tds[uomIdx];
      if (!td) return;
      const nameCell = tds[nameIdx];
      const name = nameCell ? (nameCell.querySelector('.member-name') || nameCell).textContent : '';
      const newTd = newIdx >= 0 ? tds[newIdx] : null;
      const pr = newTd
        ? [...newTd.childNodes].filter((n) => !(n.classList && n.classList.contains('bbn-beat'))).map((n) => n.textContent).join('')
        : '';
      let r = lookup.get(rowKey(name, pr));
      if (!r && trs.length === S.pageRows.length) r = S.pageRows[i];

      const label = r ? fmtTime(r.StartTime) : '';
      td.classList.add('bbn-ct');
      let s = td.querySelector('.bbn-time');
      if (!s) { s = document.createElement('span'); s.className = 'bbn-time'; td.appendChild(s); }
      const shown = label || '-';
      if (s.textContent !== shown) s.textContent = shown;
      matchFont(tds[uomIdx - 1] || tds[uomIdx + 1], s);
      tr.classList.toggle('bbn-hide', !!S.filter && label !== S.filter);
      // clean up the old "beat @" line from earlier versions if it's still there
      const oldBeat = newTd && newTd.querySelector('.bbn-beat');
      if (oldBeat) oldBeat.remove();
    });
  }

  // Make our text look native: copy font/size/weight/colour from the cell next to it
  const FONT_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textTransform', 'color', 'lineHeight'];
  function matchFont(from, to) {
    if (!from || !to) return;
    const cs = getComputedStyle(from);
    FONT_PROPS.forEach((k) => { if (to.style[k] !== cs[k]) to.style[k] = cs[k]; });
  }

  function groups(rows) {
    const g = new Map();
    rows.slice()
      .sort((a, b) => sortKey(a.StartTime).localeCompare(sortKey(b.StartTime)) || (a.Rank || 0) - (b.Rank || 0))
      .forEach((r) => {
        const t = fmtTime(r.StartTime) || 'Unknown';
        if (!g.has(t)) g.set(t, []);
        g.get(t).push(r);
      });
    return g;
  }

  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

  function paintBreakersPanel(p) {
    const rows = S.allRows || S.pageRows;
    const g = groups(rows);

    // Every class to show: ones with PRs, plus scheduled classes nobody PR'd in (skip Open Studio,
    // empty classes, and classes later today that haven't happened yet)
    const order = new Map(); // label -> "HH:MM" for sorting
    rows.forEach((r) => order.set(fmtTime(r.StartTime) || 'Unknown', sortKey(r.StartTime)));
    if (S.brkSched) {
      const date = (S.brkSchedKey || '').split('|')[1] || '';
      const now = new Date();
      const today = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
      const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      S.brkSched.forEach((c) => {
        if (!c.count || /open studio/i.test(c.name)) return;
        if (date === today && c.t > nowHM) return;
        const label = fmtTime('T' + c.t);
        if (!order.has(label)) order.set(label, c.t);
      });
    }
    const labels = [...order.keys()].sort((x, y) => order.get(x).localeCompare(order.get(y)));
    const info = labels.map((label) => ({ label, prs: g.get(label) || [], cls: classAt(label) }));
    const sized = info.filter((x) => x.cls);
    const totalIn = sized.reduce((n, x) => n + x.cls.count, 0);
    const totalPrSized = sized.reduce((n, x) => n + x.prs.length, 0);

    const sig = 'brk' + JSON.stringify([rows.length, S.filter, S.collapsed, !!S.allRows, info.map((x) => [x.label, x.prs.length, x.cls])]);
    if (p.dataset.sig === sig) return;
    p.dataset.sig = sig;
    p.textContent = '';

    const title = totalIn
      ? `PRs BY CLASS · ${rows.length} of ${totalIn} PR'd (${pct(totalPrSized, totalIn)}%)`
      : `PRs BY CLASS · ${rows.length}`;
    p.appendChild(panelHead(title, S.allRows ? 'all pages' : 'this page only', S.collapsed,
      () => { S.collapsed = !S.collapsed; schedulePaint(); }));
    if (S.collapsed) return;

    const body = el('div', 'bbn-body');
    if (!S.brkSched) body.appendChild(el('div', 'bbn-note', 'Open Input Results for this day once to add class sizes and coaches.'));

    const chips = el('div', 'bbn-chips');
    const chip = (text, val) => {
      const b = el('button', 'bbn-chip' + (S.filter === val ? ' on' : ''), text);
      b.onclick = () => { S.filter = val; schedulePaint(); };
      chips.appendChild(b);
    };
    chip(`All (${rows.length})`, null);
    info.forEach((x) => chip(x.cls ? `${x.label} · ${x.prs.length}/${x.cls.count}` : `${x.label} (${x.prs.length})`, x.label));
    body.appendChild(chips);

    const rateText = (x) => (x.cls
      ? `${x.prs.length} of ${x.cls.count} PR'd (${pct(x.prs.length, x.cls.count)}%)`
      : `${x.prs.length} PR${x.prs.length === 1 ? '' : 's'}`);

    const brkSheet = () => {
      const [y, m, d] = ((S.brkSchedKey || '').split('|')[1] || '').split('/');
      const challenge = ((rows[0] && rows[0].ChallengeName) || '').toUpperCase();
      const shown = info.filter((x) => !S.filter || x.label === S.filter);
      const shownSized = shown.filter((x) => x.cls);
      const n = shown.reduce((k, x) => k + x.prs.length, 0);
      const inClass = shownSized.reduce((k, x) => k + x.cls.count, 0);
      const prSized = shownSized.reduce((k, x) => k + x.prs.length, 0);
      return {
        v: 1,
        t: `${S.filter ? S.filter + ' · ' : ''}${challenge || 'PR'} PRs`,
        s: [y ? dateLabel(y, m, d) : '', studioName(), inClass ? `${n} of ${inClass} PR'd (${pct(prSized, inClass)}%)` : `${n} PRs`].filter(Boolean).join(' · '),
        g: shown.map((x) => {
          const g = { h: x.label + (x.cls && x.cls.coach ? ' · ' + x.cls.coach : ''), r: rateText(x) };
          if (x.prs.length) {
            g.c = ['Member', 'Old', 'New', 'Diff'];
            g.rows = x.prs.map((r) => [brkName(r), brkRec(r.PreviousRecord, r) || '-', brkRec(r.NewRecord, r) || '-', brkRec(r.DiffRecord, r) || '-']);
          } else g.empty = 'No PRs';
          return g;
        }),
      };
    };

    body.appendChild(btnRow(copyBtn(() => {
      const lines = [];
      info.forEach((x) => {
        if (S.filter && x.label !== S.filter) return;
        lines.push(`${x.label} class · ${rateText(x)}${x.cls && x.cls.coach ? ' · Coach ' + x.cls.coach : ''}`);
        x.prs.forEach((r) => {
          lines.push(`  ${brkName(r)}  ${brkRec(r.PreviousRecord, r)} -> ${brkRec(r.NewRecord, r)}  (${brkRec(r.DiffRecord, r)} better)  ${r.EquipmentName || ''}`.trimEnd());
        });
      });
      return lines.join('\n');
    }), phoneBtn(brkSheet)));

    info.forEach((x) => {
      if (S.filter && x.label !== S.filter) return;
      const box = el('div', 'bbn-group');
      const gh = el('div', 'bbn-gh');
      const left = el('span', null, x.label);
      if (x.cls && x.cls.coach) left.appendChild(el('span', 'bbn-coach', ' · ' + x.cls.coach));
      gh.appendChild(left);
      gh.appendChild(el('span', 'bbn-rate', rateText(x)));
      box.appendChild(gh);
      if (x.prs.length) {
        box.appendChild(brkRow('Member', 'Old PR', 'New PR', 'Diff', true));
        x.prs.forEach((r) => box.appendChild(brkRow(brkName(r), brkRec(r.PreviousRecord, r) || '-', brkRec(r.NewRecord, r) || '-', brkRec(r.DiffRecord, r) || '-')));
      } else {
        box.appendChild(el('div', 'bbn-names bbn-muted', 'No PRs'));
      }
      body.appendChild(box);
    });
    p.appendChild(body);
  }

  // =====================================================================
  // 2) CLASS ROSTER (Input Results)
  // =====================================================================
  const onRosterPage = () => /input-screen\/class-roster/i.test(location.hash);

  function onRoster(j) {
    S.roster = ((j && j.roster) || []).filter((m) => !m.lateCancelled);
    S.rosterClass = (j && j.classSchedule) || null;
    loadBenchmarks(true);
    schedulePaint();
  }

  // Which challenge is picked in the "Challenge of the day" dropdown
  function selectedChallenge() {
    const list = S.challenges || [];
    if (!list.length) return null;
    const label = (document.querySelector('.challenge-dropdown [class*="singleValue"], .challenge-dropdown [class*="single-value"]') || {}).textContent || '';
    const L = label.trim().toUpperCase();
    let pick = null;
    if (L) {
      // longest title that the dropdown label starts with ("0.25 MILE" in "0.25 MILE TREADMILL")
      list.forEach((c) => {
        const t = String((c.MetricEntry && c.MetricEntry.Title) || '').toUpperCase();
        if (t && L.indexOf(t) === 0 && (!pick || t.length > pick.MetricEntry.Title.length)) pick = c;
      });
    }
    pick = pick || list[0];
    return {
      templateId: pick.ChallengeTemplateId,
      title: (pick.MetricEntry && pick.MetricEntry.Title) || '',
      entryType: (pick.MetricEntry && pick.MetricEntry.EntryType) || '',
      equipmentId: pick.MetricEntry && pick.MetricEntry.EquipmentId,
      label: pick.ChallengeTemplateId === DRITRI_TEMPLATE ? 'DRITRI' : (L || ((pick.MetricEntry && pick.MetricEntry.Title) || '')),
    };
  }

  // Pull each member's full benchmark history (6 at a time). Cached for 2 minutes;
  // hitting the roster's refresh button forces a fresh pull.
  function queueBench(memberIds, force) {
    if (!authFor(`${API}/proxy/`)) return;
    const now = Date.now();
    const queue = [...new Set(memberIds)]
      .filter((id) => id > 0 && !S.benchLoading.has(id))
      .filter((id) => force || !S.bench.has(id) || now - S.bench.get(id).at > 120000);
    let i = 0;
    const next = () => {
      if (i >= queue.length) return;
      const id = queue[i++];
      S.benchLoading.add(id);
      apiGet(`${API}/proxy/api/v3/personal/benchmarks/member/${id}?pageSize=500&pageIndex=1`)
        .then((j) => { S.bench.set(id, { at: Date.now(), hist: (j && j.Dto && j.Dto.BenchmarkHistories) || [] }); })
        .catch(() => { S.bench.set(id, { at: Date.now(), hist: null }); })
        .finally(() => { S.benchLoading.delete(id); schedulePaint(); next(); });
    };
    for (let k = 0; k < 6; k++) next();
  }
  function loadBenchmarks(force) { queueBench(S.roster.map((m) => m.memberId), force); }

  // Walk a member's results in date order and track each new best.
  // All-time PR = the last best. Previous PR = the best before that one was set.
  function prProgression(results, entryType) {
    const isTime = !/distance/i.test(entryType || '');
    const val = (r) => (isTime ? toSecs(r.Result) : parseFloat(r.Result));
    const better = (a, b) => (isTime ? a < b : a > b);
    const sorted = results
      .filter((r) => { const v = val(r); return v != null && !isNaN(v) && v > 0; })
      .sort((a, b) => String(a.ClassTime || a.DateCreated).localeCompare(String(b.ClassTime || b.DateCreated)));
    const prs = [];
    sorted.forEach((r) => { if (!prs.length || better(val(r), val(prs[prs.length - 1]))) prs.push(r); });
    return {
      best: prs.length ? prs[prs.length - 1] : null,
      prev: prs.length > 1 ? prs[prs.length - 2] : null,
      attempts: sorted.length,
      isTime,
    };
  }
  const fmtResult = (r, isTime) => {
    if (!r) return '';
    return isTime ? fmtPR(r.Result).replace(/\.00$/, '') : String(r.Result || '').replace(/^0+(?=\d)/, '').replace(/(\.\d{2})\d+$/, '$1');
  };

  // Everything we show for one roster member: one entry per equipment they've done this benchmark on
  function memberInfo(m, ch) {
    const name = shortName(m.firstName, m.lastName);
    if (!(m.memberId > 0)) return { name, state: 'noid', eqs: [] };
    const b = S.bench.get(m.memberId);
    if (!b) return { name, state: 'loading', eqs: [] };
    if (!b.hist) return { name, state: 'error', eqs: [] };
    if (!ch) return { name, state: 'loading', eqs: [] };
    const mine = b.hist.filter((r) => r.ChallengeTemplateId === ch.templateId);
    const eqs = [];
    rosterGroups(ch).forEach((grp) => {
      const e = { id: grp.eqId };
      const rs = mine.filter((r) => r.EquipmentId === grp.eqId &&
        (grp.typeId === undefined || (r.ChallengeTemplateTypeId == null ? null : r.ChallengeTemplateTypeId) === grp.typeId));
      const p = prProgression(rs, ch.entryType);
      if (!p.best) return;
      const kind = benchKind(ch, e.id);
      // Bike/Strider: same number format as the tread version of this benchmark, but never a target
      const vk = kind || (NO_TARGET_EQ.has(e.id) ? benchKind(ch, 2) : null);
      const bestVal = vk ? encodeResult(vk, p.best.Result) : null;
      const prevVal = vk && p.prev ? encodeResult(vk, p.prev.Result) : null;
      eqs.push({
        eq: grp.key,
        id: e.id,
        short: grp.short,
        kind,
        bestVal,
        prevVal,
        best: vk ? fmtValue(vk, bestVal, p.best.Result) : fmtResult(p.best, p.isTime),
        prev: p.prev ? (vk ? fmtValue(vk, prevVal, p.prev.Result) : fmtResult(p.prev, p.isTime)) : '',
        target: kind ? targetFor(kind, bestVal, ch, e.id) : '',
        prevTarget: kind && p.prev ? targetFor(kind, prevVal, ch, e.id) : '',
      });
    });
    return { name, state: eqs.length ? 'pr' : 'first', eqs };
  }

  // Match a roster card on screen ("Alex S." + masked email) to a roster entry
  function findMember(card) {
    const nameEl = card.querySelector('.attendance-name');
    if (!nameEl) return null;
    const nm = norm(nameEl.textContent);
    const cands = S.roster.filter((m) => norm(shortName(m.firstName, m.lastName)) === nm);
    if (cands.length <= 1) return cands[0] || null;
    const mask = ((card.querySelector('.email') || {}).textContent || '').trim().toLowerCase();
    const [a, b] = mask.split('**');
    return cands.find((m) => {
      const e = String(m.email || '').toLowerCase();
      return a != null && b != null && e.startsWith(a) && e.endsWith(b);
    }) || cands[0];
  }

  // Each line is a list of parts so the all-time and previous targets can be styled differently:
  //   TREAD  PR 1:49 → 8.3 mph  ·  Prev 1:52 → 8.1 mph
  const seg = (time, target) => time + (target ? ' → ' + target : '');
  function cardLines(info) {
    if (info.state === 'pr') {
      return info.eqs.map((e) => {
        const parts = [
          { cls: 'bbn-eq', text: e.short },
          { cls: 'bbn-best', text: 'PR ' + seg(e.best, e.target) },
        ];
        if (e.prev) parts.push({ cls: 'bbn-prev', text: 'Prev ' + seg(e.prev, e.prevTarget) });
        return { cls: '', parts };
      });
    }
    if (info.state === 'first') return [{ cls: 'bbn-pr-first', parts: [{ cls: '', text: 'First attempt' }] }];
    if (info.state === 'loading') return [{ cls: 'bbn-pr-muted', parts: [{ cls: '', text: 'Loading PR…' }] }];
    if (info.state === 'error') return [{ cls: 'bbn-pr-muted', parts: [{ cls: '', text: 'PR unavailable' }] }];
    return [];
  }

  function paintRosterCards(ch) {
    document.querySelectorAll('.attendance-button').forEach((card) => {
      const host = card.querySelector('.attendance-content');
      if (!host) return;
      const m = findMember(card);
      let tag = host.querySelector('.bbn-pr-wrap');
      const lines = m ? cardLines(memberInfo(m, ch)) : [];
      if (!lines.length) { if (tag) tag.remove(); return; }
      const sig = JSON.stringify(lines);
      if (!tag) { tag = el('span', 'bbn-pr-wrap'); host.appendChild(tag); }
      if (tag.dataset.sig === sig) return;
      tag.dataset.sig = sig;
      tag.textContent = '';
      lines.forEach((l) => {
        const line = el('span', 'bbn-pr ' + l.cls);
        l.parts.forEach((pt) => line.appendChild(el('span', pt.cls, pt.text)));
        tag.appendChild(line);
      });
    });
  }

  function paintRosterPanel(p, ch) {
    const infos = S.roster.map((m) => memberInfo(m, ch));
    const loaded = infos.filter((x) => x.state !== 'loading').length;
    const cls = S.rosterClass;
    const when = cls ? fmtTime(cls.classStartDateTime) : '';
    const sig = 'ros' + JSON.stringify([S.rosterCollapsed, ch && ch.templateId, infos]);
    if (p.dataset.sig === sig) return;
    p.dataset.sig = sig;
    p.textContent = '';

    const sub = loaded < infos.length ? `loading ${loaded}/${infos.length}` : `${infos.length} in class`;
    p.appendChild(panelHead(`${when ? when + ' · ' : ''}${ch ? ch.label : 'CLASS'} PRs`, sub, S.rosterCollapsed,
      () => { S.rosterCollapsed = !S.rosterCollapsed; schedulePaint(); }));
    if (S.rosterCollapsed) return;

    const byName = (a, b) => a.name.localeCompare(b.name);
    const sections = rosterGroups(ch).map((g) => ({
      e: { name: g.name, id: g.eqId },
      rows: infos.filter((x) => x.state === 'pr').map((x) => ({ name: x.name, r: x.eqs.find((q) => q.eq === g.key) }))
        .filter((x) => x.r).sort(byName),
    }));
    const first = infos.filter((x) => x.state === 'first').sort(byName);
    const other = infos.filter((x) => !['pr', 'first'].includes(x.state));

    const body = el('div', 'bbn-body');
    const rosterSheet = () => {
      const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec((cls && cls.classStartDateTime) || '');
      const sub = [dm ? dateLabel(dm[1], dm[2], dm[3]) : '', studioName(), `${infos.length} in class`].filter(Boolean).join(' · ');
      const title = `${when ? when + ' · ' : ''}${ch ? ch.label : 'Class'}`;
      const head = compactHead(ch);
      if (head) {
        const coach = cls && [cls.coachFirstname, (cls.coachLastname || '').charAt(0)].filter(Boolean).join(' ') + (cls.coachLastname ? '.' : '');
        return Object.assign(head, { t: title, s: sub, g: [classGroupV2(S.roster, ch, (when || 'Class') + (coach ? ' · ' + coach : ''), `${infos.length} in class`)] });
      }
      const g = [];
      sections.forEach(({ e, rows }) => {
        if (!rows.length) return;
        const [ca, cb] = colLabels(ch, e.id);
        g.push({ h: e.name, r: `${rows.length}`, c: ['Member', ca, cb],
          rows: rows.map(({ name, r }) => [name, seg(r.best, stripUnit(r.target)), r.prev ? seg(r.prev, stripUnit(r.prevTarget)) : '-']) });
      });
      if (first.length) g.push({ h: 'First attempt', r: `${first.length}`, names: first.map((x) => x.name) });
      return { v: 1, t: title, s: sub, g };
    };
    body.appendChild(btnRow(copyBtn(() => {
      const lines = [`${when} class · ${ch ? ch.label : ''}`];
      sections.forEach(({ e, rows }) => {
        if (!rows.length) return;
        lines.push(`${e.name}:`);
        rows.forEach(({ name, r }) => lines.push(`  ${name}  PR ${seg(r.best, r.target)}${r.prev ? '  |  Prev ' + seg(r.prev, r.prevTarget) : ''}`));
      });
      if (first.length) lines.push(`First attempt: ${first.map((x) => x.name).join(', ')}`);
      return lines.join('\n');
    }), phoneBtn(rosterSheet)));

    sections.forEach(({ e, rows }) => {
      if (!rows.length) return;
      const box = el('div', 'bbn-group');
      const gh = el('div', 'bbn-gh');
      gh.appendChild(el('span', null, e.name));
      gh.appendChild(el('span', null, `${rows.length}`));
      box.appendChild(gh);
      const [ca, cb] = colLabels(ch, e.id);
      box.appendChild(row3('Member', ca, cb, 'bbn-cols'));
      rows.forEach(({ name, r }) => box.appendChild(row3(name,
        cellPair(r.best, stripUnit(r.target)),
        r.prev ? cellPair(r.prev, stripUnit(r.prevTarget)) : '-')));
      body.appendChild(box);
    });

    if (first.length) {
      const fb = el('div', 'bbn-group');
      const fh = el('div', 'bbn-gh');
      fh.appendChild(el('span', null, 'First attempt'));
      fh.appendChild(el('span', null, `${first.length}`));
      fb.appendChild(fh);
      fb.appendChild(el('div', 'bbn-names', first.map((x) => x.name).join(', ')));
      body.appendChild(fb);
    }
    if (other.length && loaded === infos.length) {
      body.appendChild(el('div', 'bbn-names bbn-muted', `No PR data: ${other.map((x) => x.name).join(', ')}`));
    }
    p.appendChild(body);
  }

  // =====================================================================
  // 3) DAY SHEET (Input Results > Select Class Time)
  // Pick one or more classes for the day and send everyone's PRs and target speeds to a phone.
  // =====================================================================
  const onDayPage = () => /#\/studio\/input-screen\/?(\?|$)/i.test(location.hash);
  const fromSchedDate = (ymd) => { const [y, m, d] = (ymd || '').split('/'); return y ? `${m}/${d}/${y}` : ''; };

  function onDaySchedule(url, classes) {
    const q = new URL(url, location.href).searchParams;
    const date = q.get('ClassStartDateTime');
    const studio = q.get('studioId');
    const mbo = q.get('mboStudioId');
    if (!date || date !== q.get('ClassEndDateTime')) return;
    const key = studio + '|' + date;
    if (S.day && S.day.key === key) return;
    S.day = {
      key, date, studio, mbo,
      classes: classes
        .filter((c) => c.mboClassId && !/open studio/i.test(c.className || ''))
        .map((c) => ({
          id: c.mboClassId,
          t: (/T(\d{2}:\d{2})/.exec(c.classStartDateTime || '') || [])[1] || '',
          name: c.className || '',
          count: c.rosterCount || 0,
          coach: [c.coachFirstname, (c.coachLastname || '').charAt(0)].filter(Boolean).join(' ') + (c.coachLastname ? '.' : ''),
        }))
        .sort((a, b) => a.t.localeCompare(b.t)),
      challenges: null, chIdx: 0, chTried: false,
      selected: new Set(), rosters: new Map(),
      collapsed: S.day ? S.day.collapsed : true,
    };
    loadDayChallenges();
    schedulePaint();
  }

  // The benchmark(s) set up for that date
  function loadDayChallenges() {
    const D = S.day;
    if (!D || D.challenges || D.chLoading) return;
    const url = `${API}/proxy/api/v3/challenges/studio/${D.studio}?date=${fromSchedDate(D.date)}`;
    if (!authFor(url)) return; // tries again on the next paint once the login shows up
    D.chLoading = true;
    apiGet(url)
      .then((j) => {
        D.challenges = (Array.isArray(j) ? j : []).filter((c) => c.MetricEntry);
        const def = D.challenges.findIndex((c) => c.IsDefault);
        D.chIdx = def >= 0 ? def : 0;
      })
      .catch(() => { D.challenges = []; })
      .finally(() => { D.chLoading = false; schedulePaint(); });
  }
  function dayChallenge() {
    const D = S.day;
    const c = D && D.challenges && D.challenges[D.chIdx];
    if (!c) return null;
    const eqName = { 2: 'TREADMILL', 3: 'STRIDER', 4: 'ROWER', 5: 'BIKE', 7: 'POWER WALKER' }[c.MetricEntry.EquipmentId] || '';
    return {
      templateId: c.ChallengeTemplateId,
      title: c.MetricEntry.Title || '',
      entryType: c.MetricEntry.EntryType || '',
      equipmentId: c.MetricEntry.EquipmentId,
      label: c.ChallengeTemplateId === DRITRI_TEMPLATE ? 'DRITRI' : `${c.MetricEntry.Title || ''} ${eqName}`.trim().toUpperCase(),
    };
  }

  // Roster for one class, then every member's history
  function ensureDayRoster(id, retry) {
    const D = S.day;
    if (!D || (D.rosters.has(id) && !retry)) return;
    D.rosters.set(id, 'loading');
    const url = `${API}/occi/mbo/schedules/${id}/roster?MboStudioId=${D.mbo}&MboClassId=${id}`;
    apiGet(url)
      .catch(() => new Promise((r) => setTimeout(r, 1200)).then(() => apiGet(url))) // one automatic retry
      .then((j) => {
        const members = ((j && j.roster) || []).filter((m) => !m.lateCancelled);
        D.rosters.set(id, members);
        queueBench(members.map((m) => m.memberId), false);
      })
      .catch(() => D.rosters.set(id, 'error'))
      .finally(schedulePaint);
  }
  function dayClassStatus(c) {
    const r = S.day.rosters.get(c.id);
    if (r == null) return 'idle';
    if (r === 'loading') return 'loading';
    if (r === 'error') return 'error';
    const pending = r.filter((m) => m.memberId > 0 && !S.bench.has(m.memberId)).length;
    return pending ? 'loading' : 'ready';
  }

  // Compact phone-sheet section for one class. Each row is [name, 0=TREAD/1=PW, all-time PR secs, prev PR secs or 0].
  // The phone page works out the speeds itself (same formula), which keeps the QR code small.
  // Row values depend on the sheet kind: seconds (time), thousandths of a mile (k:'d'), hundredths of a sec (k:'r').
  // Machine flag: 0 tread, 1 PW, 2 rower, 3 bike, 4 strider (bike and strider never get a target).
  function classGroupV2(members, ch, header, right) {
    const infos = members.map((m) => memberInfo(m, ch)).sort((a, b) => a.name.localeCompare(b.name));
    const p = [];
    infos.filter((x) => x.state === 'pr').forEach((x) => x.eqs.forEach((e) => {
      if (!e.bestVal) return;
      p.push([x.name.replace(/\.$/, ''), { 7: 1, 4: 2, 5: 3, 3: 4 }[e.id] || 0, e.bestVal, e.prevVal || 0]);
    }));
    const g = { h: header, r: right, p };
    const first = infos.filter((x) => x.state === 'first').map((x) => x.name.replace(/\.$/, ''));
    if (first.length) g.f = first;
    return g;
  }
  // Compact sheets work for every benchmark that has a target. Returns the sheet header the phone page needs
  // to redo the math: mi (time), k:'d' + min (12 MIN), k:'r' + m (rows). Null = plain text sheet.
  function compactHead(ch) {
    if (!ch) return null;
    const kind = benchKind(ch, ch.equipmentId === 4 ? 4 : 2);
    if (kind === 'time') return { v: 2, mi: distMiles(ch.title) };
    if (kind === 'dist') return { v: 2, k: 'd', min: titleMinutes(ch.title) };
    if (kind === 'row') return { v: 2, k: 'r', m: titleMeters(ch.title) };
    return null;
  }
  const compactOK = (ch) => !!compactHead(ch);
  // Panel column titles for one machine section
  function colLabels(ch, eqId) {
    const kind = benchKind(ch, eqId);
    return kind ? [`All-time PR → ${unitWord(kind)}`, `Prev PR → ${unitWord(kind)}`] : ['All-time PR', 'Prev PR'];
  }
  function dayClassGroup(c, ch) {
    const members = S.day.rosters.get(c.id) || [];
    const header = fmtTime('T' + c.t) + (c.coach ? ' · ' + c.coach : '');
    if (compactOK(ch)) return classGroupV2(members, ch, header, `${members.length} booked`);
    // other benchmarks: plain text rows, PR only
    const infos = members.map((m) => memberInfo(m, ch)).sort((a, b) => a.name.localeCompare(b.name));
    const rows = [];
    infos.filter((x) => x.state === 'pr').forEach((x) => x.eqs.forEach((e) => rows.push([x.name, e.short, e.best, e.prev || '-'])));
    const g = { h: header, r: `${members.length} booked`, c: ['Member', '', 'All-time', 'Prev'], rows };
    const first = infos.filter((x) => x.state === 'first').map((x) => x.name);
    if (first.length) g.f = first;
    return g;
  }

  // Pack the chosen classes into as few QR codes as will scan comfortably off a screen
  const MAX_QR_MODULES = 129; // ~QR version 28: still scans easily off a laptop screen at 420px
  async function dayParts() {
    const D = S.day;
    const ch = dayChallenge();
    const chosen = D.classes.filter((c) => D.selected.has(c.id));
    const [y, m, d] = D.date.split('/');
    const sheetFor = (list) => {
      const t1 = fmtTime('T' + list[0].c.t), t2 = fmtTime('T' + list[list.length - 1].c.t);
      return Object.assign(compactHead(ch) || { v: 1 }, {
        t: `${ch ? ch.label : 'PRs'} · ${t1 === t2 ? t1 : t1 + ' to ' + t2}`,
        s: [dateLabel(y, m, d), studioName(), `${list.length} class${list.length === 1 ? '' : 'es'}`].join(' · '),
        g: list.map((x) => x.g),
      });
    };
    const fits = async (list) => { const q = makeQR(await sheetLink(sheetFor(list))); return !!q && q.getModuleCount() <= MAX_QR_MODULES; };
    const parts = [];
    let cur = [];
    for (const c of chosen) {
      const item = { c, g: dayClassGroup(c, ch) };
      if (cur.length && !(await fits(cur.concat(item)))) { parts.push(cur); cur = []; }
      cur.push(item);
    }
    if (cur.length) parts.push(cur);
    return parts.map(sheetFor);
  }

  function paintDayPanel(p) {
    const D = S.day;
    if (!D.challenges && !D.chLoading) loadDayChallenges();
    const ch = dayChallenge();
    const [y, m, d] = D.date.split('/');
    const chosen = D.classes.filter((c) => D.selected.has(c.id));
    const statuses = D.classes.map((c) => dayClassStatus(c));
    const readyN = chosen.filter((c) => dayClassStatus(c) === 'ready').length;
    const sig = 'day' + JSON.stringify([D.key, D.collapsed, D.chIdx, !!D.challenges, [...D.selected], statuses]);
    if (p.dataset.sig === sig) return;
    p.dataset.sig = sig;
    p.textContent = '';

    p.appendChild(panelHead(`DAY SHEET · ${dateLabel(y, m, d)}`, chosen.length ? `${chosen.length} selected` : 'pick classes', D.collapsed,
      () => { D.collapsed = !D.collapsed; schedulePaint(); }));
    if (D.collapsed) return;
    const body = el('div', 'bbn-body');

    // Benchmark for the day (and a picker if there's more than one)
    if (!D.challenges) {
      body.appendChild(el('div', 'bbn-note', D.chLoading ? 'Loading the benchmark…' : 'Open any class once to load the benchmark for this day.'));
    } else if (!D.challenges.length) {
      body.appendChild(el('div', 'bbn-note', 'No benchmark is set up for this day.'));
    } else if (D.challenges.length === 1) {
      body.appendChild(el('div', 'bbn-daych', ch.label));
    } else {
      const sel = el('select', 'bbn-daysel');
      D.challenges.forEach((c, i) => {
        const o = el('option', null, `${c.MetricEntry.Title}${c.IsDefault ? ' (challenge of the day)' : ''}`);
        o.value = String(i);
        if (i === D.chIdx) o.selected = true;
        sel.appendChild(o);
      });
      sel.onclick = (e) => e.stopPropagation();
      sel.onchange = (e) => { D.chIdx = +e.target.value; schedulePaint(); };
      body.appendChild(sel);
    }

    const pick = (ids, on) => { ids.forEach((id) => { if (on) { D.selected.add(id); ensureDayRoster(id); } else D.selected.delete(id); }); schedulePaint(); };
    const quick = el('div', 'bbn-btns');
    const all = el('button', 'bbn-btn', 'All'); all.onclick = (e) => { e.stopPropagation(); pick(D.classes.map((c) => c.id), true); };
    const none = el('button', 'bbn-btn', 'Clear'); none.onclick = (e) => { e.stopPropagation(); pick([...D.selected], false); };
    quick.appendChild(all); quick.appendChild(none);
    body.appendChild(quick);

    const list = el('div', 'bbn-daylist');
    D.classes.forEach((c, i) => {
      const row = el('label', 'bbn-dayrow' + (D.selected.has(c.id) ? ' on' : ''));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = D.selected.has(c.id);
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = (e) => pick([c.id], e.target.checked);
      row.appendChild(cb);
      const txt = el('span', 'bbn-daytxt');
      txt.appendChild(el('b', null, fmtTime('T' + c.t)));
      txt.appendChild(el('span', 'bbn-dayname', ' ' + c.name));
      txt.appendChild(el('span', 'bbn-daymeta', `${c.count} booked${c.coach ? ' · ' + c.coach : ''}`));
      row.appendChild(txt);
      const st = statuses[i];
      if (D.selected.has(c.id)) {
        const mark = el('span', 'bbn-daystat ' + st, st === 'ready' ? '✓' : st === 'error' ? '↻' : '…');
        if (st === 'error') { mark.title = 'Couldn\'t load this class. Click to try again.'; mark.onclick = (e) => { e.preventDefault(); e.stopPropagation(); ensureDayRoster(c.id, true); }; }
        row.appendChild(mark);
      }
      list.appendChild(row);
    });
    body.appendChild(list);

    const allReady = chosen.length && readyN === chosen.length && ch;
    const send = el('button', 'bbn-btn bbn-btn-phone bbn-btn-wide',
      !chosen.length ? 'Pick classes to send' : !ch ? 'Waiting for the benchmark…' : allReady ? `Send ${chosen.length} class${chosen.length === 1 ? '' : 'es'} to phone` : `Loading PRs… ${readyN} of ${chosen.length} classes`);
    send.disabled = !allReady;
    send.onclick = (e) => { e.stopPropagation(); if (allReady) showPhoneQRParts(dayParts()); };
    body.appendChild(send);
    p.appendChild(body);
  }

  // =====================================================================
  // SEND TO PHONE (QR code)
  // The sheet is packed into the link after "#", which browsers never send to the server.
  // The phone opens a plain viewer page that unpacks and shows it. Nothing is uploaded or saved.
  // =====================================================================
  const VIEWER_URL = 'https://banksj11.github.io/benchmark-buddy/v/';

  function toB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function sheetLink(sheet) {
    const raw = new TextEncoder().encode(JSON.stringify(sheet));
    if (typeof CompressionStream !== 'undefined') {
      const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const packed = new Uint8Array(await new Response(stream).arrayBuffer());
      return `${VIEWER_URL}#z=${toB64url(packed)}`;
    }
    return `${VIEWER_URL}#j=${toB64url(raw)}`;
  }
  function makeQR(text) {
    const QR = window.__prRadarQR;
    if (!QR) return null;
    for (const level of ['L']) {
      try { const q = QR(0, level); q.addData(text); q.make(); return q; } catch (e) { /* too long for this level */ }
    }
    return null;
  }
  const dateLabel = (y, m, d) => new Date(+y, +m - 1, +d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  function studioName() {
    try {
      const a = JSON.parse(localStorage.getItem('state')).auth_users;
      const st = a.selectedStudio || a.currentStudio || {};
      return st.StudioName || st.Name || '';
    } catch (e) { return ''; }
  }

  // sheetsOrPromise: a sheet, an array of sheets, or a promise of either. More than one = flip through codes
  async function showPhoneQRParts(sheetsOrPromise) {
    closePhoneQR();
    const wrap = el('div');
    wrap.id = 'bbn-qr';
    const card = el('div', 'bbn-qr-card');
    card.appendChild(el('div', 'bbn-qr-brand', 'BENCHMARK BUDDY · SEND TO PHONE'));
    const title = el('div', 'bbn-qr-title', 'Building…');
    card.appendChild(title);
    const box = el('div', 'bbn-qr-box', 'Building…');
    card.appendChild(box);
    const nav = el('div', 'bbn-qr-nav');
    card.appendChild(nav);
    card.appendChild(el('div', 'bbn-qr-help', 'Point your phone camera at the code and tap the link.'));
    const close = el('button', 'bbn-qr-close', 'Close');
    close.onclick = closePhoneQR;
    card.appendChild(close);
    wrap.appendChild(card);
    wrap.onclick = (e) => { if (e.target === wrap) closePhoneQR(); };
    document.body.appendChild(wrap);
    try {
      let sheets = await sheetsOrPromise;
      if (!Array.isArray(sheets)) sheets = [sheets];
      const codes = [];
      for (const sh of sheets) codes.push({ t: sh.t, q: makeQR(await sheetLink(sh)) });
      let idx = 0;
      const show = () => {
        const c = codes[idx];
        title.textContent = c.t || '';
        box.textContent = '';
        if (!c.q) box.appendChild(el('div', 'bbn-qr-err', 'Too much to fit in one code. Pick fewer classes and try again.'));
        else box.innerHTML = c.q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
        nav.textContent = '';
        if (codes.length > 1) {
          const prev = el('button', 'bbn-qr-step', '‹ Prev');
          const next = el('button', 'bbn-qr-step', 'Next ›');
          prev.disabled = idx === 0;
          next.disabled = idx === codes.length - 1;
          prev.onclick = () => { idx--; show(); };
          next.onclick = () => { idx++; show(); };
          nav.appendChild(prev);
          nav.appendChild(el('span', 'bbn-qr-count', `Code ${idx + 1} of ${codes.length}`));
          nav.appendChild(next);
        }
      };
      show();
    } catch (e) {
      title.textContent = '';
      box.textContent = 'Couldn\'t build the code. Try again.';
    }
  }
  const showPhoneQR = (sheet) => showPhoneQRParts(sheet);
  function closePhoneQR() { const w = document.getElementById('bbn-qr'); if (w) w.remove(); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePhoneQR(); });

  function phoneBtn(getSheet) {
    const b = el('button', 'bbn-btn bbn-btn-phone', 'Send to phone');
    b.onclick = (e) => { e.stopPropagation(); showPhoneQR(getSheet()); };
    return b;
  }
  function btnRow(...btns) {
    const r = el('div', 'bbn-btns');
    btns.forEach((b) => r.appendChild(b));
    return r;
  }

  // =====================================================================
  // 4) TODAY'S CHALLENGE LEADERS: Power Walker board
  // CT's own board only ranks treadmill results. The Interactive Leaderboard feed has the Power Walker
  // results with each member's gender and age group, so the same board can be built for Power Walkers.
  // =====================================================================
  const onLeadPage = () => /leader-board\/today-challenge-leader/i.test(location.hash);
  const AGE_GROUPS = [[1, '29 AND UNDER'], [2, '30 - 39'], [3, '40 - 49'], [4, '50 - 59'], [5, '60 - 69'], [6, '70 AND OVER']];
  const LEAD_GENDERS = [[1, 'MEN'], [2, 'WOMEN']];
  const LEAD_TOP = 3;
  function onLeaders(url) {
    const m = /\/studio\/(\d+)\/challenge\/(\d+)/i.exec(url);
    const date = new URL(url, location.href).searchParams.get('date') || '';
    const key = [m[1], m[2], date].join('|');
    const L = S.lead;
    if (key !== L.key) { L.key = key; L.sid = m[1]; L.cid = m[2]; L.date = date; L.pw = null; }
    else if (L.pw && L.pw.state !== 'loading') L.pw = null;  // CT refreshed its board, so refresh ours too
    schedulePaint();
  }
  const leadChallenge = () => (S.challenges || []).find((c) => String(c.ChallengeId) === String(S.lead.cid)) || null;
  // Power Walker boards only make sense for treadmill benchmarks. DriTri mixes versions in one feed, so it's left out.
  const leadCanPW = (c) => !!c && c.MetricEntry && c.MetricEntry.EquipmentId === 2 && c.ChallengeTemplateId !== DRITRI_TEMPLATE;
  function loadLeadPW() {
    const L = S.lead, c = leadChallenge();
    if (!leadCanPW(c) || !authFor(`${API}/proxy/`)) return;
    const key = L.key;
    const pw = (L.pw = { state: 'loading', rows: [] });
    const page = (i, acc) => apiGet(`${API}/proxy/api/v3/challenge-leader/interactive?pageSize=200&pageIndex=${i}&fullTextSearch=true&equipmentId=7` +
      `&entryType=${encodeURIComponent(c.MetricEntry.EntryType)}&challengeTemplateId=${c.ChallengeTemplateId}&date=${encodeURIComponent(L.date)}` +
      `&division=Studio&studioId=${L.sid}&isOriginal=true`).then((j) => {
      const all = acc.concat((j && j.Results) || []);
      return j && i < (j.TotalNumberOfPages || 1) && i < 5 ? page(i + 1, all) : all;
    });
    page(1, []).then((rows) => { if (S.lead.key === key && S.lead.pw === pw) { pw.rows = rows; pw.state = 'ok'; } })
      .catch(() => { if (S.lead.pw === pw) pw.state = 'error'; })
      .finally(schedulePaint);
  }
  function leadResult(r, c) {
    if (/distance/i.test((c && c.MetricEntry && c.MetricEntry.EntryType) || '')) {
      const km = parseFloat(r.Result);
      return isFinite(km) ? (km / KM_PER_MI).toFixed(3) + ' mi' : String(r.Result || '');
    }
    return fmtPR(r.Result).replace(/\.00$/, '');
  }
  function paintLeaders() {
    const L = S.lead;
    const title = document.querySelector('.today-challenge .title-today-challenge-leader');
    const native = document.querySelector('.today-challenge .leader-age-challenge');
    let bar = document.getElementById('bbn-lead-toggle');
    let board = document.getElementById('bbn-lead-board');
    const c = leadChallenge();
    if (!title || !native || !leadCanPW(c)) {
      if (bar) bar.remove();
      if (board) board.remove();
      if (native && native.classList.contains('bbn-lead-hide')) native.classList.remove('bbn-lead-hide');
      return;
    }
    if (!bar || bar.previousElementSibling !== title) {
      if (bar) bar.remove();
      bar = el('div'); bar.id = 'bbn-lead-toggle';
      title.insertAdjacentElement('afterend', bar);
    }
    const barSig = L.mode;
    if (bar.dataset.sig !== barSig) {
      bar.dataset.sig = barSig;
      bar.textContent = '';
      [['tm', 'Treadmill'], ['pw', 'Power Walker']].forEach(([mode, label]) => {
        const b = el('button', 'bbn-lead-btn' + (L.mode === mode ? ' bbn-on' : ''), label);
        b.onclick = () => { L.mode = mode; schedulePaint(); };
        bar.appendChild(b);
      });
    }
    const pwOn = L.mode === 'pw';
    if (native.classList.contains('bbn-lead-hide') !== pwOn) native.classList.toggle('bbn-lead-hide', pwOn);
    if (!pwOn) { if (board) board.remove(); return; }
    if (!L.pw) loadLeadPW();
    if (!board || board.previousElementSibling !== native) {
      if (board) board.remove();
      board = el('div'); board.id = 'bbn-lead-board';
      native.insertAdjacentElement('afterend', board);
    }
    const pw = L.pw || { state: 'loading', rows: [] };
    const groups = LEAD_GENDERS.map(([gid, gname]) => ({
      gname,
      ages: AGE_GROUPS.map(([aid, aname]) => ({
        aname,
        rows: pw.rows.filter((r) => r.GenderId === gid && r.AgeGroupId === aid).sort((a, b) => a.Rank - b.Rank).slice(0, LEAD_TOP)
          .map((r) => [r.MemberName || `${r.FirstName || ''} ${r.LastName || ''}`.trim(), fmtTime(r.ClassTime), leadResult(r, c)]),
      })),
    }));
    const sig = JSON.stringify([L.key, pw.state, groups]);
    if (board.dataset.sig === sig) return;
    board.dataset.sig = sig;
    board.textContent = '';
    if (pw.state !== 'ok') {
      board.appendChild(el('div', 'bbn-lead-note', pw.state === 'error' ? 'Couldn\'t load Power Walker results. Refresh to try again.' : 'Loading Power Walker results…'));
      return;
    }
    if (!pw.rows.length) { board.appendChild(el('div', 'bbn-lead-note', 'No Power Walker results yet for this challenge.')); return; }
    groups.forEach((g) => {
      board.appendChild(el('div', 'bbn-lead-gender', g.gname + ' · POWER WALKER'));
      const grid = el('div', 'bbn-lead-grid');
      g.ages.forEach((a) => {
        const box = el('div', 'bbn-lead-age');
        box.appendChild(el('div', 'bbn-lead-agename', a.aname));
        for (let i = 0; i < LEAD_TOP; i++) {
          const r = a.rows[i];
          const row = el('div', 'bbn-lead-row bbn-lead-p' + (i + 1) + (r ? '' : ' bbn-lead-empty'));
          const place = el('span', 'bbn-lead-place', String(i + 1));
          place.appendChild(el('sup', '', ['ST', 'ND', 'RD'][i]));
          row.appendChild(place);
          const who = el('span', 'bbn-lead-who');
          who.appendChild(el('span', 'bbn-lead-name', r ? r[0] : '--- ---'));
          who.appendChild(el('span', 'bbn-lead-class', r ? r[1] : '--- ---'));
          row.appendChild(who);
          row.appendChild(el('span', 'bbn-lead-res', r ? r[2] : '--:--'));
          box.appendChild(row);
        }
        grid.appendChild(box);
      });
      board.appendChild(grid);
    });
  }

  // =====================================================================
  // shared UI
  // =====================================================================
  const css = `
    th.bbn-ct, td.bbn-ct { font-size: 0 !important; }
    .bbn-ct .bbn-time { white-space: nowrap; }  /* font is copied from the neighbouring column at runtime */
    tr.bbn-hide { display: none !important; }
    .attendance-content .bbn-pr-wrap { display: block; margin-top: 3px; }
    .attendance-content .bbn-pr { display: block; font-size: 14px; line-height: 1.3; font-weight: 800; color: #f26c22;
      white-space: normal; letter-spacing: .2px; margin-top: 2px; }
    .attendance-content .bbn-pr > span { display: inline-block; white-space: nowrap; vertical-align: top; }
    .attendance-content .bbn-pr .bbn-eq { min-width: 46px; color: #1d1d1d; font-weight: 900; }
    .attendance-content .bbn-pr .bbn-best { color: #f26c22; margin-right: 12px; }
    .attendance-content .bbn-pr .bbn-prev { color: #8a8a8a; font-weight: 700; }
    /* Black cards = result already entered (and hover). Keep labels readable on them */
    .black-bg .bbn-pr .bbn-eq, .attendance-button:hover .bbn-pr .bbn-eq { color: #fff; }
    .black-bg .bbn-pr .bbn-prev, .attendance-button:hover .bbn-pr .bbn-prev { color: #b8b8b8; }
    /* Roster cards are a fixed 130px. Let them grow to fit our lines, and keep each row the same height */
    .list-member.row { display: flex !important; flex-wrap: wrap; align-content: flex-start; align-items: stretch; }
    .list-member.row::before, .list-member.row::after { display: none !important; }
    .list-member.row > .attendance-btn-wrapper { float: none !important; height: auto !important; display: flex; }
    .list-member.row > .attendance-btn-wrapper > .attendance-button { height: auto !important; min-height: 130px; flex: 1 1 auto; }
    /* CT drops to one card per row under 1300px wide. Keep the 3-across (then 2-across) grid in smaller windows. */
    @media (min-width: 900px) and (max-width: 1300px) { .list-member.row > .attendance-btn-wrapper { width: 33.3333% !important; } }
    @media (min-width: 620px) and (max-width: 899px) { .list-member.row > .attendance-btn-wrapper { width: 50% !important; } }
    .attendance-content .bbn-pr.bbn-pr-first { color: #2e9e55; }
    .leader-age-challenge.bbn-lead-hide { display: none !important; }
    #bbn-lead-toggle { display: flex; gap: 8px; justify-content: center; margin: 4px 0 14px; }
    #bbn-lead-toggle .bbn-lead-btn { font: 800 15px/1 -apple-system, Segoe UI, Roboto, sans-serif; letter-spacing: .4px; text-transform: uppercase;
      padding: 10px 18px; border-radius: 4px; border: 2px solid #f26c22; background: #fff; color: #f26c22; cursor: pointer; }
    #bbn-lead-toggle .bbn-lead-btn.bbn-on { background: #f26c22; color: #fff; }
    #bbn-lead-board { padding: 0 22px 30px; font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #1d1d1d; }
    #bbn-lead-board .bbn-lead-note { padding: 30px 0; text-align: center; color: #777; font-size: 16px; }
    #bbn-lead-board .bbn-lead-gender { font-size: 26px; font-weight: 900; letter-spacing: .5px; margin: 18px 0 8px; }
    #bbn-lead-board .bbn-lead-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px 24px; }
    #bbn-lead-board .bbn-lead-agename { font-size: 15px; font-weight: 800; margin-bottom: 4px; }
    #bbn-lead-board .bbn-lead-row { display: flex; align-items: center; background: #fff; border: 1px solid rgba(205,210,213,.6);
      margin-bottom: 4px; min-height: 44px; }
    #bbn-lead-board .bbn-lead-place { flex: 0 0 62px; align-self: stretch; display: flex; align-items: center; justify-content: center;
      color: #fff; font-weight: 900; font-size: 22px; font-style: italic; background: #e8641b; clip-path: polygon(0 0, 100% 0, 82% 100%, 0 100%); }
    #bbn-lead-board .bbn-lead-place sup { font-size: 10px; margin-left: 1px; top: -.7em; }
    #bbn-lead-board .bbn-lead-p2 .bbn-lead-place { background: #f58220; }
    #bbn-lead-board .bbn-lead-p3 .bbn-lead-place { background: #f9a51a; }
    #bbn-lead-board .bbn-lead-who { flex: 1; min-width: 0; padding: 4px 10px; display: flex; flex-direction: column; }
    #bbn-lead-board .bbn-lead-name { font-weight: 800; font-size: 15px; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #bbn-lead-board .bbn-lead-class { font-size: 11px; color: #777; }
    #bbn-lead-board .bbn-lead-res { padding: 0 16px; font-weight: 900; font-size: 18px; color: #f26c22; white-space: nowrap; }
    #bbn-lead-board .bbn-lead-empty .bbn-lead-name, #bbn-lead-board .bbn-lead-empty .bbn-lead-res { color: #c9c9c9; font-weight: 600; }
    .attendance-content .bbn-pr.bbn-pr-muted { color: #999; font-weight: 600; }
    #bbn-panel { position: fixed; left: 12px; bottom: 12px; width: 430px; max-height: 70vh; z-index: 99999;
      background: #1d1d1d; color: #fff; border-top: 4px solid #f26c22; border-radius: 6px;
      box-shadow: 0 6px 24px rgba(0,0,0,.35); font: 13px/1.35 -apple-system, Segoe UI, Roboto, sans-serif;
      display: flex; flex-direction: column; }
    #bbn-panel .bbn-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; }
    #bbn-panel .bbn-title { font-weight: 800; letter-spacing: .3px; flex: 1; }
    #bbn-panel .bbn-sub { color: #aaa; font-size: 11px; white-space: nowrap; }
    #bbn-panel .bbn-body { overflow: auto; padding: 0 12px 12px; }
    #bbn-panel .bbn-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
    #bbn-panel .bbn-chip { background: #333; color: #fff; border: 0; border-radius: 14px; padding: 5px 10px;
      font-size: 12px; cursor: pointer; }
    #bbn-panel .bbn-chip.on { background: #f26c22; }
    #bbn-panel .bbn-group { margin-top: 8px; }
    #bbn-panel .bbn-gh { color: #f26c22; font-weight: 800; border-bottom: 1px solid #333; padding-bottom: 3px; margin-bottom: 3px;
      display: flex; justify-content: space-between; }
    #bbn-panel .bbn-row { display: flex; gap: 6px; padding: 2px 0; }
    #bbn-panel .bbn-row span:first-child { flex: 1; }
    #bbn-panel .bbn-prs { color: #ccc; min-width: 92px; text-align: right; white-space: nowrap; }
    #bbn-panel .bbn-old { color: #aaa; min-width: 58px; text-align: right; white-space: nowrap; }
    #bbn-panel .bbn-new { color: #fff; font-weight: 700; min-width: 58px; text-align: right; white-space: nowrap; }
    #bbn-panel .bbn-diff { color: #7bd88f; font-weight: 700; min-width: 50px; text-align: right; white-space: nowrap; }
    #bbn-panel .bbn-cols .bbn-old, #bbn-panel .bbn-cols .bbn-new, #bbn-panel .bbn-cols .bbn-diff { color: #888; font-weight: 400; }
    #bbn-panel .bbn-c2 { min-width: 120px; text-align: right; white-space: nowrap; }
    #bbn-panel .bbn-c3 { min-width: 120px; text-align: right; white-space: nowrap; }
    #bbn-panel .bbn-c2 .bbn-t { color: #fff; font-weight: 700; }
    #bbn-panel .bbn-c2 .bbn-s { color: #f26c22; font-weight: 800; }
    #bbn-panel .bbn-c3, #bbn-panel .bbn-c3 .bbn-t { color: #aaa; }
    #bbn-panel .bbn-c3 .bbn-s { color: #d9a27f; font-weight: 700; }
    #bbn-panel .bbn-arrow { color: #666; }
    #bbn-panel .bbn-cols .bbn-c2, #bbn-panel .bbn-cols .bbn-c3 { color: #888; }
    #bbn-panel .bbn-tgt { color: #f26c22; font-weight: 700; min-width: 86px; text-align: right; white-space: nowrap; }
    #bbn-panel .bbn-cols { color: #888; font-size: 10px; text-transform: uppercase; }
    #bbn-panel .bbn-names { color: #ccc; padding: 2px 0; }
    #bbn-panel .bbn-coach { color: #aaa; font-weight: 600; }
    #bbn-panel .bbn-rate { color: #fff; font-weight: 700; }
    #bbn-panel .bbn-note { color: #d9a27f; font-size: 11px; margin-bottom: 8px; }
    #bbn-panel .bbn-muted { color: #888; font-size: 11px; margin-top: 8px; }
    #bbn-panel .bbn-group .bbn-muted { margin-top: 0; }
    #bbn-panel .bbn-btns { display: flex; gap: 8px; margin-bottom: 4px; }
    #bbn-panel.bbn-right { left: auto; right: 12px; width: 380px; }
    #bbn-panel .bbn-daych { color: #fff; font-weight: 800; margin: 2px 0 8px; }
    #bbn-panel .bbn-daysel { width: 100%; margin: 2px 0 8px; padding: 6px; background: #2a2a2a; color: #fff; border: 1px solid #444; border-radius: 4px; font-size: 13px; }
    #bbn-panel .bbn-daylist { margin: 6px 0 10px; border-top: 1px solid #333; }
    #bbn-panel .bbn-dayrow { display: flex; align-items: center; gap: 10px; padding: 7px 4px; border-bottom: 1px solid #2a2a2a; cursor: pointer; }
    #bbn-panel .bbn-dayrow.on { background: #2a2016; }
    #bbn-panel .bbn-dayrow input { width: 16px; height: 16px; accent-color: #f26c22; cursor: pointer; }
    #bbn-panel .bbn-daytxt { flex: 1; }
    #bbn-panel .bbn-daytxt b { color: #fff; }
    #bbn-panel .bbn-dayname { color: #ccc; }
    #bbn-panel .bbn-daymeta { display: block; color: #888; font-size: 11px; }
    #bbn-panel .bbn-daystat { font-weight: 800; min-width: 14px; text-align: center; }
    #bbn-panel .bbn-daystat.ready { color: #7bd88f; }
    #bbn-panel .bbn-daystat.loading { color: #aaa; }
    #bbn-panel .bbn-daystat.error { color: #ff6b6b; cursor: pointer; }
    #bbn-panel .bbn-btn-wide { width: 100%; padding: 9px; font-size: 13px; font-weight: 800; }
    #bbn-panel .bbn-btn:disabled { opacity: .55; cursor: default; }
    #bbn-qr .bbn-qr-nav { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 10px; min-height: 4px; }
    #bbn-qr .bbn-qr-step { background: #f26c22; color: #fff; border: 0; border-radius: 6px; padding: 6px 14px; font-weight: 700; cursor: pointer; }
    #bbn-qr .bbn-qr-step:disabled { opacity: .35; cursor: default; }
    #bbn-qr .bbn-qr-count { font-weight: 800; color: #1d1d1d; }
    #bbn-panel .bbn-btn-phone { background: #f26c22; color: #fff; }
    #bbn-qr { position: fixed; inset: 0; z-index: 100000; background: rgba(0,0,0,.6); display: flex;
      align-items: center; justify-content: center; font: 14px/1.4 -apple-system, Segoe UI, Roboto, sans-serif; }
    #bbn-qr .bbn-qr-card { background: #fff; color: #1d1d1d; border-top: 5px solid #f26c22; border-radius: 10px;
      padding: 18px 22px 16px; width: 470px; max-width: 94vw; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
    #bbn-qr .bbn-qr-brand { color: #f26c22; font-weight: 900; font-size: 12px; letter-spacing: 1.5px; }
    #bbn-qr .bbn-qr-title { font-weight: 800; font-size: 17px; margin: 4px 0 10px; }
    #bbn-qr .bbn-qr-box { width: 420px; max-width: 100%; margin: 0 auto; min-height: 120px; display: flex;
      align-items: center; justify-content: center; color: #777; }
    #bbn-qr .bbn-qr-box svg { width: 100%; height: auto; display: block; }
    #bbn-qr .bbn-qr-err { color: #b3261e; font-weight: 600; padding: 20px 6px; }
    #bbn-qr .bbn-qr-help { color: #555; margin: 10px 0 12px; }
    #bbn-qr .bbn-qr-close { background: #1d1d1d; color: #fff; border: 0; border-radius: 6px; padding: 8px 22px;
      font-size: 14px; font-weight: 700; cursor: pointer; }
    #bbn-panel .bbn-btn { background: transparent; color: #f26c22; border: 1px solid #f26c22; border-radius: 4px;
      font-size: 11px; padding: 2px 8px; cursor: pointer; }
  `;
  function addStyle() {
    if (document.getElementById('bbn-style')) return;
    const st = document.createElement('style');
    st.id = 'bbn-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function panelHead(title, sub, collapsed, onToggle) {
    const head = el('div', 'bbn-head');
    head.appendChild(el('span', 'bbn-title', title));
    head.appendChild(el('span', 'bbn-sub', sub));
    head.appendChild(el('span', 'bbn-sub', collapsed ? '▲' : '▼'));
    head.onclick = onToggle;
    return head;
  }
  function colsRow(a, b, c) {
    const r = el('div', 'bbn-row bbn-cols');
    r.appendChild(el('span', null, a));
    r.appendChild(el('span', 'bbn-prs', b));
    r.appendChild(el('span', 'bbn-tgt', c));
    return r;
  }
  function dataRow(a, b, c) {
    const r = el('div', 'bbn-row');
    r.appendChild(el('span', null, a));
    r.appendChild(el('span', 'bbn-prs', b));
    r.appendChild(el('span', 'bbn-tgt', c));
    return r;
  }
  // "1:49 → 8.3" with the speed highlighted
  function cellPair(time, speed) {
    const f = document.createDocumentFragment();
    f.appendChild(el('span', 'bbn-t', time));
    if (speed) { f.appendChild(el('span', 'bbn-arrow', ' → ')); f.appendChild(el('span', 'bbn-s', speed)); }
    return f;
  }
  function row3(a, b, c, extra) {
    const r = el('div', 'bbn-row' + (extra ? ' ' + extra : ''));
    r.appendChild(el('span', null, a));
    [[b, 'bbn-c2'], [c, 'bbn-c3']].forEach(([v, cls]) => {
      const cell = el('span', cls);
      if (typeof v === 'string') cell.textContent = v; else cell.appendChild(v);
      r.appendChild(cell);
    });
    return r;
  }
  function brkRow(name, oldPr, newPr, diff, isHeader) {
    const r = el('div', 'bbn-row' + (isHeader ? ' bbn-cols' : ''));
    r.appendChild(el('span', null, name));
    r.appendChild(el('span', 'bbn-old', oldPr));
    r.appendChild(el('span', 'bbn-new', newPr));
    r.appendChild(el('span', 'bbn-diff', diff));
    return r;
  }
  function row4(a, b, c, d, extra) {
    const r = el('div', 'bbn-row' + (extra ? ' ' + extra : ''));
    r.appendChild(el('span', null, a));
    r.appendChild(el('span', 'bbn-c2', b));
    r.appendChild(el('span', 'bbn-c3', c));
    r.appendChild(el('span', 'bbn-tgt', d));
    return r;
  }
  function copyBtn(getText) {
    const b = el('button', 'bbn-btn', 'Copy list');
    b.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(getText()).then(() => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy list'), 1200); });
    };
    return b;
  }

  function paint() {
    addStyle();
    let p = document.getElementById('bbn-panel');
    const mode = onPRPage() ? 'brk' : onRosterPage() ? 'ros' : onDayPage() ? 'day' : '';
    if (onLeadPage()) paintLeaders();
    if (!mode) { if (p) p.remove(); return; }
    if (p) p.classList.toggle('bbn-right', mode === 'day');

    if (mode === 'day') {
      if (!S.day) { if (p) p.remove(); return; }
      if (!p) { p = el('div'); p.id = 'bbn-panel'; p.classList.add('bbn-right'); document.body.appendChild(p); }
      paintDayPanel(p);
      return;
    }

    if (mode === 'brk') {
      paintBreakersTable();
      const rows = S.allRows || S.pageRows;
      if (!rows.length) { if (p) p.remove(); return; }
      if (!p) { p = el('div'); p.id = 'bbn-panel'; document.body.appendChild(p); }
      paintBreakersPanel(p);
    } else {
      if (!S.roster.length) { if (p) p.remove(); return; }
      if (authFor(`${API}/proxy/`) && S.roster.some((m) => m.memberId > 0 && !S.bench.has(m.memberId) && !S.benchLoading.has(m.memberId))) loadBenchmarks(false);
      const ch = selectedChallenge();
      paintRosterCards(ch);
      if (!p) { p = el('div'); p.id = 'bbn-panel'; document.body.appendChild(p); }
      paintRosterPanel(p, ch);
    }
  }

  // ---------- keep it painted as React re-renders ----------
  let queued = false;
  function schedulePaint() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (document.body) paint();
    });
  }
  const start = () => {
    new MutationObserver(schedulePaint).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('hashchange', schedulePaint);
    schedulePaint();
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();

}