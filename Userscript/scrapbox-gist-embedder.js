// ==UserScript==
// @name         Scrapbox Gist Embedder
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  ScrapboxでGist URLを直接API取得して自動埋め込み表示 (重複防止版)
// @author       kuroma6666
// @match        https://scrapbox.io/*
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// ==/UserScript==

/* eslint-env browser, es6 */

(function() {
  'use strict';

  function embedGists() {
    const links = document.querySelectorAll('a.link[href*="gist.github.com/"]:not([data-gist-embedded])');

    links.forEach(function(link) {
      const href = link.href;
      // Gist ID (32桁ハッシュ) の抽出
      const matchResult = href.match(/gist\.github\.com\/(?:[^\/]+\/)?([a-f0-9]+)/);
      if (!matchResult) return;

      const lineEl = link.closest('.line') || link.parentNode;

      // すでに行内に埋め込み枠が存在する場合は処理をスキップ（重複防止）
      if (lineEl.querySelector('.gist-embed-container')) {
        link.setAttribute('data-gist-embedded', 'true');
        return;
      }

      const gistId = matchResult[1];
      link.setAttribute('data-gist-embedded', 'processing');

      // GM_xmlhttpRequest でAPI取得 (CSP制限回避)
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://api.github.com/gists/' + gistId,
        headers: {
          'Accept': 'application/vnd.github.v3+json'
        },
        onload: function(response) {
          if (response.status !== 200) {
            link.removeAttribute('data-gist-embedded');
            return;
          }

          try {
            const data = JSON.parse(response.responseText);

            // 取得完了時にも再度重複チェック
            if (lineEl.querySelector('.gist-embed-container')) {
              link.setAttribute('data-gist-embedded', 'true');
              return;
            }

            const container = document.createElement('div');
            container.className = 'gist-embed-container';
            container.style.cssText = 'margin: 8px 0; padding: 12px; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; font-family: monospace; font-size: 13px; max-height: 600px; width: 100%; box-sizing: border-box; overflow: auto; color: #24292f;';

            if (data.files) {
              Object.keys(data.files).forEach(function(filename) {
                const fileObj = data.files[filename];
                const header = document.createElement('div');
                header.style.cssText = 'font-weight: bold; margin-bottom: 6px; color: #57606a; border-bottom: 1px solid #d8dee4; padding-bottom: 4px;';
                header.textContent = filename;

                const codeEl = document.createElement('pre');
                codeEl.style.cssText = 'margin: 0; white-space: pre-wrap; word-break: break-all; font-family: monospace;';
                codeEl.textContent = fileObj.content;

                container.appendChild(header);
                container.appendChild(codeEl);
              });
            }

            lineEl.appendChild(container);
            link.setAttribute('data-gist-embedded', 'true');
          } catch (e) {
            console.error('[Gist Embedder] Parse error:', e);
            link.removeAttribute('data-gist-embedded');
          }
        },
        onerror: function() {
          link.removeAttribute('data-gist-embedded');
        }
      });
    });
  }

  // DOM変更の監視
  const observer = new MutationObserver(embedGists);
  observer.observe(document.body, { childList: true, subtree: true });
  embedGists();
})();
