// ==UserScript==
// @name         Scrapbox 蔵書登録 (openBD)
// @namespace    kuroma6666
// @version      1.0.0
// @description  ISBN から openBD を引き、Scrapbox に書誌入りの新規ページを作る
// @match        https://scrapbox.io/kuroma6666/*
// @grant        GM_xmlhttpRequest
// @connect      api.openbd.jp
// @run-at       document-idle
// ==/UserScript==

/*
 * なぜ Tampermonkey なのか:
 *   Scrapbox は connect-src を許可リストで縛る CSP を配信しており、api.openbd.jp は
 *   そこに含まれない。ページのコンテキストで動く Scrapbox の UserScript からは
 *   fetch も XHR も送出前にブラウザが拒否する（CORS ではないので openBD 側の設定は無関係）。
 *   GM_xmlhttpRequest は拡張の権限で動くためページの CSP を受けない。
 *
 * 台帳表示（bookshelf-userscript.js）との関係:
 *   互いを参照しない。連携は Scrapbox のデータだけを介する。
 *   登録して新しいページができれば、台帳は次回リロード時の一覧取得でそれを検出し、
 *   そのページだけを差分取得する。キャッシュを共有したり無効化したりする必要はない。
 */
(() => {
  'use strict';

  const PROJECT = 'kuroma6666';
  const MOUNT_TITLE = '蔵書一覧';
  const OPENBD = 'https://api.openbd.jp/v1/get?isbn=';
  const LOG = '[bookshelf-register]';

  console.log(LOG, 'loaded');

  // ---- ISBN ----------------------------------------------------------------

  function checkDigit13(core12) {
    const d = [...core12].map(Number);
    const sum = d.reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0);
    return String((10 - (sum % 10)) % 10);
  }

  function isValidIsbn13(s) {
    const d = [...s].map(Number);
    const sum = d.slice(0, 12).reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === d[12];
  }

  function normalizeIsbn(raw) {
    const s = (raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    if (s.length === 13) return isValidIsbn13(s) ? s : null;
    if (s.length === 10) { const core = '978' + s.slice(0, 9); return core + checkDigit13(core); }
    return null;
  }

  // ---- 取得 ----------------------------------------------------------------

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload: (r) => (r.status >= 200 && r.status < 300)
          ? resolve(r.responseText) : reject(new Error(`openBD ${r.status}`)),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  async function fetchOpenBd(isbn) {
    const json = JSON.parse(await gmGet(OPENBD + isbn));
    const rec = Array.isArray(json) ? json[0] : json;
    return rec && rec.summary ? rec : null;
  }

  /*
   * summary.author は "Brooks,FrederickPhillips 滝沢,徹 牧野,祐子" のように
   * 姓名のカンマと区切りのスペースが混在した 1 本の文字列で、機械的に分割できない。
   * 構造化された onix の Contributor を優先し、無い場合だけ summary に落とす。
   * ContributorRole は空配列のことがあり（実測: 人月の神話）、著/訳の区別は保証されない。
   */
  function toBook(rec) {
    const s = rec.summary || {};
    const contrib = (rec.onix && rec.onix.DescriptiveDetail && rec.onix.DescriptiveDetail.Contributor) || [];
    const authors = contrib
      .map((c) => c.PersonName && c.PersonName.content && c.PersonName.content.trim())
      .filter(Boolean);
    return {
      isbn: s.isbn || '',
      title: [s.title, s.volume].filter(Boolean).join(' ').trim(),
      publisher: s.publisher || '',
      pubdate: s.pubdate || '',
      cover: s.cover || '',        // 実測で空のことがある
      authors: authors.length ? authors : (s.author ? [s.author] : []),
    };
  }

  // 既存 75 件と同じ記法で組み立てる。これ以上記法を分岐させない
  function buildBody(b) {
    const out = [];
    if (b.cover) out.push(`[${b.cover}]`);
    out.push(`[${b.title} https://www.hanmoto.com/bd/isbn/${b.isbn}]`);
    out.push(`ISBN: ${b.isbn}`);
    if (b.authors.length === 1) out.push(`著者: [${b.authors[0]}]`);
    else if (b.authors.length) { out.push('著者:'); b.authors.forEach((a) => out.push(` [${a}]`)); }
    if (b.publisher) out.push(`出版社: [${b.publisher}]`);
    if (b.pubdate) out.push(`発行: ${b.pubdate}`);
    return out.join('\n');
  }

  // ---- Scrapbox 側の確認 ----------------------------------------------------
  // 台帳のキャッシュは読まない。構造に依存すると 2 つのスクリプトが結合するため、
  // 判定は Scrapbox の API だけで完結させる。

  const sbApi = (path) => fetch(`/api/pages/${PROJECT}${path}`, { credentials: 'include' });

  /*
   * HTTP ステータスで存在判定してはいけない。
   * 未ログイン(匿名)では未作成ページは 404 だが、ログイン済みでプロジェクトを見ている場合は
   * 未作成ページでも 200 が返る（エディタが「これから作るページ」を開けるようにするため）。
   * 実在するかどうかは persistent フィールドで判断する。
   */
  async function pageExists(title) {
    const res = await sbApi(`/${encodeURIComponent(title)}`);
    if (!res.ok) return false;
    const json = await res.json().catch(() => null);
    return !!(json && json.persistent === true);
  }

  async function findByIsbn(isbn) {
    const res = await sbApi(`/search/query?q=${encodeURIComponent(isbn)}`);
    if (!res.ok) return null;
    const { pages } = await res.json();
    return (pages && pages[0] && pages[0].title) || null;
  }

  // ---- UI ------------------------------------------------------------------

  const CSS = `
    #bookshelf-register { margin: 8px 0 12px; font-size: 13px; color: #333; line-height: 1.5;
      border: 1px solid #e0e0e0; border-radius: 4px; padding: 6px 10px; background: #fcfcfc; }
    #bookshelf-register summary { cursor: pointer; user-select: none; }
    #bookshelf-register .br-body { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    #bookshelf-register .br-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    #bookshelf-register input[type=text] { padding: 4px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
    #bookshelf-register button { padding: 4px 10px; border: 1px solid #bbb; border-radius: 4px;
      background: #fff; cursor: pointer; font-size: 13px; }
    #bookshelf-register button:hover { background: #f0f0f0; }
    #bookshelf-register textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 12px;
      padding: 6px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    #bookshelf-register .br-msg { color: #666; }
    #bookshelf-register .br-msg.err { color: #b00; }
    #bookshelf-register .br-msg.ok { color: #070; }
    #bookshelf-register .br-pv { display: flex; gap: 10px; align-items: flex-start; }
    #bookshelf-register .br-pv img { height: 72px; }
  `;

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function build() {
    const el = document.createElement('details');
    el.id = 'bookshelf-register';
    el.open = true;
    el.innerHTML = `
      <summary>ISBN で追加</summary>
      <div class="br-body">
        <div class="br-row">
          <input type="text" class="br-isbn" placeholder="ISBN-10 / ISBN-13" size="22">
          <button class="br-fetch">openBD から取得</button>
          <span class="br-msg"></span>
        </div>
        <div class="br-result" hidden>
          <div class="br-pv"></div>
          <textarea class="br-body-text" rows="9" spellcheck="false"></textarea>
          <div class="br-row">
            <button class="br-create">このページを作成</button>
            <span class="br-msg br-msg2"></span>
          </div>
        </div>
      </div>`;

    const $ = (s) => el.querySelector(s);
    const msg = $('.br-msg');
    const result = $('.br-result');
    let pending = null;

    $('.br-isbn').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('.br-fetch').click(); }
    });

    $('.br-fetch').addEventListener('click', async () => {
      result.hidden = true;
      msg.className = 'br-msg';
      const isbn = normalizeIsbn($('.br-isbn').value);
      if (!isbn) { msg.className = 'br-msg err'; msg.textContent = 'ISBN として解釈できない'; return; }

      msg.textContent = '取得中…';
      try {
        const [rec, dup] = await Promise.all([fetchOpenBd(isbn), findByIsbn(isbn)]);
        if (!rec) { msg.className = 'br-msg err'; msg.textContent = 'openBD に該当なし'; return; }

        pending = toBook(rec);
        $('.br-pv').innerHTML =
          (pending.cover ? `<img src="${pending.cover}">` : '') +
          `<div><b>${esc(pending.title)}</b><br>${esc(pending.authors.join(', '))}<br>` +
          `${esc(pending.publisher)} ${esc(pending.pubdate)}` +
          (pending.cover ? '' : '<br><span class="br-msg err">書影なし</span>') + '</div>';
        $('.br-body-text').value = buildBody(pending);
        result.hidden = false;

        if (dup) { msg.className = 'br-msg err'; msg.textContent = `この ISBN は既にある: ${dup}`; }
        else { msg.textContent = ''; }
      } catch (e) {
        msg.className = 'br-msg err';
        msg.textContent = `取得に失敗: ${e.message}`;
        console.error(LOG, e);
      }
    });

    $('.br-create').addEventListener('click', async () => {
      const msg2 = $('.br-msg2');
      if (!pending || !pending.title) return;
      msg2.className = 'br-msg br-msg2';
      msg2.textContent = '確認中…';

      // ?body= は既存ページには末尾追記として働く。作成前に必ず存在を確かめる
      if (await pageExists(pending.title)) {
        msg2.className = 'br-msg br-msg2 err';
        msg2.textContent = '同名ページが既にある。追記になるため中止した';
        return;
      }
      const url = `/${PROJECT}/${encodeURIComponent(pending.title)}?body=${encodeURIComponent($('.br-body-text').value)}`;
      window.open(url, '_blank');
      msg2.className = 'br-msg br-msg2 ok';
      msg2.textContent = '新しいタブで開いた。蔵書一覧をリロードすると反映される';
    });

    return el;
  }

  // ---- マウント ------------------------------------------------------------

  const currentTitle = () => {
    try { return decodeURIComponent(location.pathname.split('/')[2] || ''); }
    catch { return location.pathname.split('/')[2] || ''; }
  };

  function sync() {
    const onTarget = location.pathname.startsWith(`/${PROJECT}/`) && currentTitle() === MOUNT_TITLE;
    let el = document.getElementById('bookshelf-register');

    if (!onTarget) { el?.remove(); return; }

    const lines = document.querySelector('.lines');
    if (!lines || !lines.parentNode) return;

    if (!el) {
      el = build();
      lines.parentNode.insertBefore(el, lines.nextSibling);
      console.log(LOG, 'マウント完了');
    }

    // 台帳(#bookshelf)は非同期に後から挿入されるため、順序が入れ替わりうる。
    // 入力欄が先頭に来るよう、見つけたら台帳の前へ移動する
    const ledger = document.getElementById('bookshelf');
    if (ledger && ledger.parentNode === el.parentNode && ledger.nextSibling === el) {
      el.parentNode.insertBefore(el, ledger);
    }
  }

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  setInterval(sync, 500);
  sync();
})();
