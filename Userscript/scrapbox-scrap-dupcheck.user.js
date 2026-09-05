// ==UserScript==
// @name         Scrapbox Scrap with Duplicate Check
// @namespace    https://scrapbox.io/kuroma6666/
// @version      1.1.1
// @description  現在ページを Scrapbox へ保存する前に、URL とタイトルの重複を検出して確認する
// @author       kuroma6666
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      scrapbox.io
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  var CONFIG = {
    project: 'kuroma6666',
    ogpPrefix: 'https://ricapitolare.vercel.app/svg?url=',
    ogpSuffix: '#.svg',
    titlesTtlMs: 24 * 60 * 60 * 1000,
    similarMinChars: 10,
    similarMinRatio: 0.6,
    listLimit: 5,
    shortcut: { code: 'KeyS', ctrl: true, alt: true, shift: false },
    requestTimeoutMs: 15000
  };

  var API = 'https://scrapbox.io/api';
  var CACHE_KEY = 'titleIndex:' + CONFIG.project;

  /* ---------------- 正規化 ---------------- */

  // 記事の同一性に寄与しないパラメータ。落とすことで再現率を優先する。
  var TRACKING_PARAM = /^(utm_[\w-]+|gclid|dclid|fbclid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|ref|ref_src|ref_url|spm|from|share_source|si)$/i;

  function normalizeUrl(raw) {
    var u;
    try { u = new URL(raw); } catch (e) { return String(raw).toLowerCase(); }
    Array.prototype.slice.call(u.searchParams.keys()).forEach(function (key) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    });
    var host = u.host.replace(/^www\./i, '').toLowerCase();
    var path = u.pathname.replace(/\/+$/, '');
    var query = u.searchParams.toString();
    return host + path + (query ? '?' + query : '');
  }

  // 検索クエリにはクエリ文字列を含めない。
  // Scrapbox の全文検索が ? & = をどう扱うかは仕様が公開されておらず、
  // クエリ違いの判別は取得後に normalizeUrl で行うほうが確実なため。
  function urlSearchKey(raw) {
    try {
      var u = new URL(raw);
      return u.host.replace(/^www\./i, '') + u.pathname.replace(/\/+$/, '');
    } catch (e) { return String(raw); }
  }

  var TITLE_NOISE = /[\s　\-‐‑‒–—―_・･:：;；,，、.．。/／\\|｜"'“”‘’`´~〜^*+＝=()（）[\]［］【】{}｛｝<>＜＞〈〉《》「」『』!！?？#＃&＆@＠]/g;

  // NFKC で全角英数と半角カナを吸収し、記号と空白を落として比較キーとする。
  function normalizeTitle(raw) {
    return String(raw).normalize('NFKC').toLowerCase().replace(TITLE_NOISE, '');
  }

  // 本文中の [<ogpPrefix><元URL>#.svg <元URL>] 形式から元 URL を取り出す。
  function unwrapOgp(url) {
    if (url.indexOf(CONFIG.ogpPrefix) !== 0) return url;
    return url.slice(CONFIG.ogpPrefix.length).replace(/#\.svg$/, '');
  }

  /* ---------------- Scrapbox API ---------------- */

  function httpGet(url, headers) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        headers: headers || {},
        timeout: CONFIG.requestTimeoutMs,
        onload: resolve,
        onerror: function () { reject(new Error('通信失敗')); },
        ontimeout: function () { reject(new Error('タイムアウト')); }
      });
    });
  }

  function readCache() {
    try { return JSON.parse(GM_getValue(CACHE_KEY, '') || 'null'); } catch (e) { return null; }
  }

  function writeCache(value) {
    try { GM_setValue(CACHE_KEY, JSON.stringify(value)); } catch (e) { /* 保存失敗は機能を止めない */ }
  }

  // 全ページのタイトル一覧を 1 リクエストで取得する（1490 件 / 261KB）。
  // ETag は返るが If-None-Match を付けてもサーバは 304 を返さず全文を返すため
  // （2026-09-05 実測）、条件付きリクエストは行わない。
  // 代わりに TTL を長く取り、自分がページ作成に進んだ時点で索引を破棄する。
  function fetchTitleIndex() {
    var cache = readCache();
    if (cache && Date.now() - cache.at < CONFIG.titlesTtlMs) return Promise.resolve(cache.titles);

    return httpGet(API + '/pages/' + CONFIG.project + '/search/titles').then(function (res) {
      if (res.status !== 200) {
        if (cache) return cache.titles;   // 古い索引でも、無いよりは検出できる
        throw new Error('titles API が ' + res.status + ' を返した');
      }
      var titles = JSON.parse(res.responseText).map(function (p) { return p.title; });
      writeCache({ titles: titles, at: Date.now() });
      return titles;
    });
  }

  function searchPages(query) {
    var url = API + '/pages/' + CONFIG.project + '/search/query?q=' + encodeURIComponent(query);
    return httpGet(url).then(function (res) {
      if (res.status !== 200) throw new Error('search API が ' + res.status + ' を返した');
      return JSON.parse(res.responseText).pages || [];
    });
  }

  /* ---------------- 重複判定 ---------------- */

  var URL_IN_TEXT = /https?:\/\/[^\s\]>]+/g;

  // 検索ヒットを、本文中の URL が現在ページと一致するもの（exact）と
  // 同一ホスト・同一パス前方一致で拾われただけのもの（related）に分ける。
  function splitUrlHits(pages, currentKey) {
    var exact = [];
    var related = [];
    pages.forEach(function (page) {
      var urls = (page.lines || []).join('\n').match(URL_IN_TEXT) || [];
      var matched = urls.some(function (u) { return normalizeUrl(unwrapOgp(u)) === currentKey; });
      (matched ? exact : related).push(page.title);
    });
    return { exact: exact, related: related };
  }

  // 正規化キーの一致を「一致」、一方が他方を包含する場合を「類似」とする。
  // 包含だけでは短い概念ページ（例: 「JavaScript」）が長い記事タイトルに
  // 片端から一致してしまうため、下限文字数と長さ比の 2 条件で絞る。
  // 全 1490 ページを入力として与えた測定では、長さ比 0.6 でノイズが 91 件から
  // 46 件に減り、最大ヒット数も 8 件から 4 件になる（2026-09-05 実測）。
  function splitTitleHits(titles, input) {
    var key = normalizeTitle(input);
    var exact = [];
    var similar = [];
    titles.forEach(function (title) {
      var k = normalizeTitle(title);
      if (k === key) { exact.push(title); return; }
      if (key.length < CONFIG.similarMinChars || k.length < CONFIG.similarMinChars) return;
      if (k.indexOf(key) < 0 && key.indexOf(k) < 0) return;
      var ratio = Math.min(k.length, key.length) / Math.max(k.length, key.length);
      if (ratio >= CONFIG.similarMinRatio) similar.push(title);
    });
    return { exact: exact, similar: similar };
  }

  /* ---------------- UI ---------------- */

  function pageUrl(title) {
    return 'https://scrapbox.io/' + CONFIG.project + '/' + encodeURIComponent(title);
  }

  function renderSections(sections) {
    return sections.map(function (s) {
      var head = '[' + s.label + '] ' + s.items.length + '件';
      var body = s.items.slice(0, CONFIG.listLimit).map(function (t) { return '  ・' + t; }).join('\n');
      var more = s.items.length > CONFIG.listLimit
        ? '\n  … 他 ' + (s.items.length - CONFIG.listLimit) + '件'
        : '';
      return head + '\n' + body + more;
    }).join('\n\n');
  }

  function openTab(url) {
    var win = window.open(url, '_blank');
    if (!win && window.confirm('新規タブを開けませんでした。現在のタブで開きますか?')) {
      location.href = url;
    }
  }

  // 戻り値 true = 既存ページを開いたので処理を終える。
  function askExisting(sections) {
    var shown = sections.filter(function (s) { return s.items.length > 0; });
    if (shown.length === 0) return false;
    var ok = window.confirm(
      '既存ページが見つかりました。\n\n' + renderSections(shown) +
      '\n\nOK: 先頭の既存ページを開く\nキャンセル: このまま新規作成に進む'
    );
    if (!ok) return false;
    openTab(pageUrl(shown[0].items[0]));
    return true;
  }

  /* ---------------- 本体 ---------------- */

  function buildBody(url, quote) {
    var lines = ['', '[' + CONFIG.ogpPrefix + url + CONFIG.ogpSuffix + ' ' + url + ']'];
    if (quote && quote.trim()) {
      lines = lines.concat(quote.split(/\n/g).map(function (line) { return ' > ' + line; }));
    }
    lines.push('');
    return lines.join('\n');
  }

  var running = false;

  function run() {
    if (running) return;
    running = true;

    // 選択テキストは prompt を出す前に確定させる。
    // ダイアログ表示で選択が解除される環境があるため。
    var quote = String(window.getSelection());
    var currentUrl = location.href;
    var currentKey = normalizeUrl(currentUrl);
    var failure = null;

    searchPages(urlSearchKey(currentUrl)).then(function (pages) {
      var hit = splitUrlHits(pages, currentKey);
      return askExisting([
        { label: 'URL一致', items: hit.exact },
        { label: '同一サイトの既存ページ', items: hit.related }
      ]);
    }).catch(function (e) {
      failure = e;
      console.warn('[scrap] URL 重複チェックに失敗', e);
      return false;
    }).then(function (opened) {
      if (opened) return null;

      var suffix = failure ? '  ※重複チェック失敗: ' + failure.message : '';
      var title = window.prompt(
        'Scrap "' + document.title + '" to ' + CONFIG.project + '.' + suffix,
        document.title
      );
      if (!title) return null;

      return fetchTitleIndex().then(function (titles) {
        var hit = splitTitleHits(titles, title);
        return askExisting([
          { label: 'タイトル一致', items: hit.exact },
          { label: 'タイトル類似', items: hit.similar }
        ]);
      }).catch(function (e) {
        console.warn('[scrap] タイトル重複チェックに失敗', e);
        return false;
      }).then(function (opened2) {
        if (opened2) return null;
        // 作成に進んだ時点で索引は古くなる。次回起動時に取り直させる。
        writeCache(null);
        openTab(pageUrl(title.trim()) + '?body=' + encodeURIComponent(buildBody(currentUrl, quote)));
        return null;
      });
    }).catch(function (e) {
      console.error('[scrap] 想定外のエラー', e);
      window.alert('Scrap に失敗しました: ' + e.message);
    }).then(function () {
      running = false;
    });
  }

  /* ---------------- 起動 ---------------- */

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Scrap このページ（重複チェック付き）', run);
    GM_registerMenuCommand('タイトル索引のキャッシュを破棄', function () {
      writeCache(null);
      window.alert('タイトル索引のキャッシュを破棄しました。');
    });
  }

  // Windows では Alt+Shift が入力言語の切り替えに既定で割り当てられているため、
  // その組み合わせは使わない。
  window.addEventListener('keydown', function (e) {
    var s = CONFIG.shortcut;
    if (e.ctrlKey === s.ctrl && e.altKey === s.alt && e.shiftKey === s.shift &&
        !e.metaKey && e.code === s.code) {
      e.preventDefault();
      run();
    }
  }, true);

  // 読み込み確認用のマーカー。
  // コンソールで document.documentElement.dataset.scrapboxScrap を見れば、
  // スクリプトがそのページで実行されているかを判定できる。
  document.documentElement.dataset.scrapboxScrap = 'ready';

  // ブックマークレット併用時の起動口を 2 系統用意する。
  // CustomEvent は DOM 経由なので通常は isolated world をまたぐが、
  // Tampermonkey の inject mode によっては届かない。
  // unsafeWindow への関数公開はページ側から直接呼べるため、そちらを主とする。
  document.addEventListener('scrapbox-scrap', run);
  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow) {
      unsafeWindow.scrapboxScrap = typeof exportFunction === 'function'
        ? exportFunction(run, unsafeWindow)   // Firefox は関数をエクスポートする必要がある
        : run;
    }
  } catch (e) {
    console.warn('[scrap] unsafeWindow への公開に失敗', e);
  }
})();
