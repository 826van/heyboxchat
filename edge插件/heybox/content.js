(() => {
  if (window.__xhhKeywordHelperLoaded) return;
  window.__xhhKeywordHelperLoaded = true;

  const STORAGE_KEYWORDS = "xhhKeywordHelperKeywords";
  const STORAGE_DRAFT = "xhhKeywordHelperDraft";
  const STORAGE_DRAFTS = "xhhKeywordHelperDrafts";
  const STORAGE_MAX_STEPS = "xhhKeywordHelperMaxSteps";
  const STORAGE_PENDING_DRAFT = "xhhKeywordHelperPendingDraft";

  const defaultKeywords = ["买", "求推荐", "合适", "多少钱"];
  const defaultDrafts = ["看情况回一句，发之前先确认帖子内容是否真的相关。"];
  const defaultDraft = defaultDrafts[0];

  const state = {
    keywords: loadList(STORAGE_KEYWORDS, defaultKeywords),
    drafts: loadDrafts(),
    maxSteps: Number(localStorage.getItem(STORAGE_MAX_STEPS) || 12),
    matches: new Map(),
    seenPosts: new Map(),
    scanTimer: null,
    collecting: false,
    lastScanNewPosts: 0,
    lastScanMatches: 0
  };

  const postLinkSelector = [
    'a[href*="/app/bbs/link/"]',
    'a[href*="/app/post/link/"]',
    'a[href*="/app/article/"]'
  ].join(",");

  function loadList(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return Array.isArray(value) && value.length ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEYWORDS, JSON.stringify(state.keywords));
    localStorage.setItem(STORAGE_DRAFTS, JSON.stringify(state.drafts));
    localStorage.setItem(STORAGE_DRAFT, state.drafts[0] || defaultDraft);
    localStorage.setItem(STORAGE_MAX_STEPS, String(state.maxSteps));
  }

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeDraft(value) {
    return (value || "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function loadDrafts() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_DRAFTS) || "null");
      if (Array.isArray(stored)) {
        const drafts = stored.map(normalizeDraft).filter(Boolean);
        if (drafts.length) return drafts;
      }
    } catch {
      // Fall through to the legacy single-draft value.
    }

    const legacyDraft = normalizeDraft(localStorage.getItem(STORAGE_DRAFT) || "");
    return legacyDraft ? [legacyDraft] : defaultDrafts;
  }

  function pickRandomDraft() {
    const drafts = state.drafts.map(normalizeDraft).filter(Boolean);
    if (!drafts.length) return "";
    return drafts[Math.floor(Math.random() * drafts.length)];
  }

  function cleanUrl(href) {
    const url = new URL(href, location.href);
    url.hash = "";
    url.searchParams.delete("htk");
    return url.href;
  }

  function postKeyFromUrl(url) {
    const parsed = new URL(url, location.href);
    const bbsMatch = parsed.pathname.match(/\/app\/bbs\/link\/(\d+)/);
    if (bbsMatch) return `bbs:${bbsMatch[1]}`;
    return `${parsed.origin}${parsed.pathname}`;
  }

  function isInsideHelper(node) {
    return Boolean(node.closest?.(".xhh-keyword-helper-panel"));
  }

  function visibleEnough(node) {
    const rect = node.getBoundingClientRect();
    return rect.width > 120 && rect.height > 35;
  }

  function collectCandidateLinks() {
    const directLinks = [...document.querySelectorAll(postLinkSelector)]
      .filter((link) => !isInsideHelper(link));

    if (directLinks.length) {
      return uniqueLinks(directLinks);
    }

    const fallbackLinks = [...document.querySelectorAll("a[href]")]
      .filter((link) => {
        if (isInsideHelper(link)) return false;
        const href = link.getAttribute("href") || "";
        if (!/\/app\//.test(href)) return false;
        if (/\/user\/profile|\/creator\/|\/bbs\/home|\/topic\/link\//.test(href)) return false;
        return normalizeText(link.innerText || link.textContent).length >= 18;
      });

    return uniqueLinks(fallbackLinks);
  }

  function uniqueLinks(links) {
    const unique = new Map();
    for (const link of links) {
      try {
        const url = cleanUrl(link.href || link.getAttribute("href"));
        unique.set(postKeyFromUrl(url), link);
      } catch {
        // Ignore malformed href values from dynamic markup.
      }
    }
    return [...unique.values()];
  }

  function findPostContainer(link) {
    if (link.matches(postLinkSelector)) return link;

    let current = link;
    let best = link;
    for (let depth = 0; depth < 6 && current && current !== document.body; depth += 1) {
      if (isInsideHelper(current)) break;

      const text = normalizeText(current.innerText || current.textContent);
      const rect = current.getBoundingClientRect();
      const linkCount = current.querySelectorAll?.("a[href]").length || 0;
      if (
        text.length >= 24 &&
        text.length <= 2200 &&
        rect.height >= 40 &&
        rect.height <= 900 &&
        linkCount <= 10
      ) {
        best = current;
      }
      current = current.parentElement;
    }
    return best;
  }

  function textFromPost(link, container) {
    const title =
      container.querySelector?.(".bbs-content__title") ||
      container.querySelector?.('[class*="title"]') ||
      link.querySelector?.(".bbs-content__title") ||
      link.querySelector?.('[class*="title"]');
    const content =
      container.querySelector?.(".bbs-content__content") ||
      container.querySelector?.('[class*="content"]') ||
      link.querySelector?.(".bbs-content__content") ||
      link.querySelector?.('[class*="content"]');

    const pieces = [
      title?.innerText || title?.textContent || "",
      content?.innerText || content?.textContent || "",
      link.innerText || link.textContent || "",
      container.innerText || container.textContent || ""
    ].map(normalizeText).filter(Boolean);

    return [...new Set(pieces)].join(" ");
  }

  function titleFromPost(text) {
    const parts = text
      .split(/(?<=Lv\.\d{1,3})\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const candidate = parts.length > 1 ? parts.slice(1).join(" ") : text;
    return candidate.slice(0, 96) || "未命名帖子";
  }

  function matchedKeywords(text) {
    const lowerText = text.toLocaleLowerCase();
    return state.keywords.filter((keyword) => {
      const item = keyword.toLocaleLowerCase();
      return item && lowerText.includes(item);
    });
  }

  function scanLoadedPosts(options = {}) {
    const { resetHighlights = false } = options;
    if (resetHighlights) {
      document.querySelectorAll(".xhh-keyword-helper-match").forEach((node) => {
        node.classList.remove("xhh-keyword-helper-match");
      });
    }

    let newPosts = 0;
    let newMatches = 0;
    const links = collectCandidateLinks();

    for (const link of links) {
      if (!visibleEnough(link) && !link.matches(postLinkSelector)) continue;

      let url;
      try {
        url = cleanUrl(link.href || link.getAttribute("href"));
      } catch {
        continue;
      }

      const key = postKeyFromUrl(url);
      const container = findPostContainer(link);
      const text = textFromPost(link, container);
      if (text.length < 8) continue;

      if (!state.seenPosts.has(key)) newPosts += 1;
      state.seenPosts.set(key, { key, url, title: titleFromPost(text), text });

      const keywords = matchedKeywords(text);
      if (!keywords.length) {
        container.classList.remove("xhh-keyword-helper-match");
        continue;
      }

      container.classList.add("xhh-keyword-helper-match");
      if (!state.matches.has(key)) newMatches += 1;
      state.matches.set(key, {
        key,
        url,
        title: titleFromPost(text),
        keywords,
        text,
        lastSeenAt: Date.now()
      });
    }

    state.lastScanNewPosts = newPosts;
    state.lastScanMatches = newMatches;
    renderMatches();
    setStatus(`本次新增 ${newPosts} 个帖子，新增命中 ${newMatches} 个。`);
    return { newPosts, newMatches, scanned: links.length };
  }

  function scheduleScan() {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => scanLoadedPosts(), 350);
  }

  function getScrollTarget() {
    const scrollingElement = document.scrollingElement || document.documentElement;
    if (scrollingElement.scrollHeight > scrollingElement.clientHeight + 100) {
      return scrollingElement;
    }

    const candidates = [...document.querySelectorAll("main, [class*='scroll'], [class*='list'], body *")]
      .filter((element) => {
        if (isInsideHelper(element)) return false;
        const style = getComputedStyle(element);
        return (
          element.scrollHeight > element.clientHeight + 180 &&
          /auto|scroll|overlay/.test(style.overflowY)
        );
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));

    return candidates[0] || scrollingElement;
  }

  function scrollTargetByPage(target) {
    const amount = Math.max(window.innerHeight * 1.45, 900);
    if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
      window.scrollBy({ top: amount, behavior: "smooth" });
      return;
    }
    target.scrollBy({ top: amount, behavior: "smooth" });
  }

  function scrollInfo(target) {
    if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
      return {
        top: window.scrollY,
        height: document.documentElement.scrollHeight,
        viewport: window.innerHeight
      };
    }
    return {
      top: target.scrollTop,
      height: target.scrollHeight,
      viewport: target.clientHeight
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForFeedChange(target, beforeSeen, beforeHeight) {
    const start = Date.now();
    while (Date.now() - start < 1800) {
      await sleep(300);
      scanLoadedPosts();
      const info = scrollInfo(target);
      if (state.seenPosts.size > beforeSeen || info.height > beforeHeight + 120) return;
    }
  }

  async function collectMorePosts() {
    if (state.collecting) return;
    state.collecting = true;
    setCollectingState(true);

    let staleSteps = 0;
    for (let step = 1; step <= state.maxSteps && state.collecting; step += 1) {
      const target = getScrollTarget();
      const before = scrollInfo(target);
      const beforeSeen = state.seenPosts.size;

      scanLoadedPosts();
      scrollTargetByPage(target);
      setStatus(`采集中 ${step}/${state.maxSteps}，已扫 ${state.seenPosts.size} 个帖子，命中 ${state.matches.size} 个。`);
      await waitForFeedChange(target, beforeSeen, before.height);

      scanLoadedPosts();
      const after = scrollInfo(target);
      const noNewPosts = state.seenPosts.size === beforeSeen;
      const nearBottom = after.top + after.viewport >= after.height - 80;
      const noScrollMovement = after.top <= before.top + 8;
      staleSteps = noNewPosts && (nearBottom || noScrollMovement) ? staleSteps + 1 : 0;
      if (staleSteps >= 3) break;
    }

    state.collecting = false;
    setCollectingState(false);
    setStatus(`采集结束：已扫 ${state.seenPosts.size} 个帖子，命中 ${state.matches.size} 个。`);
  }

  function stopCollecting() {
    state.collecting = false;
    setCollectingState(false);
    setStatus("已停止采集。");
  }

  async function copyDraft(match) {
    readSettingsFromPanel();
    saveSettings();

    const draft = pickRandomDraft();
    if (!draft) {
      setStatus("先写好评论草稿，再复制。");
      return;
    }

    const text = `${draft}\n\n帖子：${match.url}`;
    await navigator.clipboard.writeText(text);
    setStatus("已随机复制 1 条评论草稿，发出前请自己确认是否合适。");
  }

  async function openAndPrefill(match) {
    readSettingsFromPanel();
    saveSettings();

    const text = pickRandomDraft();
    if (!text) {
      setStatus("先写好评论草稿，再打开并预填。");
      return;
    }

    localStorage.setItem(STORAGE_PENDING_DRAFT, JSON.stringify({
      key: match.key,
      url: match.url,
      text,
      createdAt: Date.now()
    }));

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard can be blocked by the browser; localStorage still carries the draft.
    }

    const opened = window.open(match.url, "_blank");
    if (!opened) {
      location.href = match.url;
    }
    setStatus("已打开帖子并准备预填。最后发送仍需你在帖子页手动确认。");
  }

  function loadPendingDraft() {
    try {
      const pending = JSON.parse(localStorage.getItem(STORAGE_PENDING_DRAFT) || "null");
      if (!pending || !pending.text || !pending.createdAt) return null;
      if (Date.now() - pending.createdAt > 15 * 60 * 1000) {
        localStorage.removeItem(STORAGE_PENDING_DRAFT);
        return null;
      }
      if (pending.url && postKeyFromUrl(pending.url) !== postKeyFromUrl(location.href)) return null;
      return pending;
    } catch {
      return null;
    }
  }

  function isCommentInput(element) {
    if (isInsideHelper(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 16) return false;

    const text = [
      element.getAttribute("placeholder") || "",
      element.getAttribute("aria-label") || "",
      element.className || "",
      element.id || ""
    ].join(" ");

    if (/搜索|search|keyword|关键词/i.test(text)) return false;
    if (/评论|回复|comment|reply|输入|说点|发一条/i.test(text)) return true;
    if (element.matches('[contenteditable="true"], .ProseMirror, [role="textbox"]')) return true;
    return element.tagName === "TEXTAREA";
  }

  function findCommentInput() {
    return [
      ...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, input[type="text"], input:not([type])')
    ].find(isCommentInput) || null;
  }

  function isCommentTrigger(element) {
    if (isInsideHelper(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 18) return false;

    const text = normalizeText([
      element.innerText || element.textContent || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || "",
      element.className || ""
    ].join(" "));

    if (/搜索|search|分享|收藏|点赞/i.test(text)) return false;
    return /评论|回复|comment|reply|说点|输入|我来说|参与讨论/i.test(text);
  }

  function findCommentTrigger() {
    return [
      ...document.querySelectorAll('button, [role="button"], a, div, span')
    ].find(isCommentTrigger) || null;
  }

  function clickCommentTrigger() {
    const trigger = findCommentTrigger();
    if (!trigger) return false;
    trigger.scrollIntoView({ block: "center", behavior: "smooth" });
    trigger.click();
    return true;
  }

  function fillInput(element, text) {
    element.focus();
    if ("value" in element) {
      element.value = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    const inserted = document.execCommand?.("insertText", false, text);
    if (!inserted) element.textContent = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function prefillPendingDraft() {
    const pending = loadPendingDraft();
    if (!pending) return;

    setStatus("检测到待填评论，正在查找评论框。不会自动发送。");
    for (let attempt = 0; attempt < 36; attempt += 1) {
      const input = findCommentInput();
      if (input) {
        fillInput(input, pending.text);
        setStatus("评论已预填。请检查内容，然后手动点击小黑盒的发布按钮。");
        localStorage.removeItem(STORAGE_PENDING_DRAFT);
        return;
      }
      if (attempt === 3 || attempt === 9 || attempt === 18) clickCommentTrigger();
      if (attempt === 6 || attempt === 14 || attempt === 24) {
        window.scrollBy({ top: Math.max(window.innerHeight * 0.75, 520), behavior: "smooth" });
      }
      await sleep(500);
    }

    setStatus("没找到评论框，草稿已复制过；你可以手动粘贴后再发布。");
  }

  async function openKeywordSearch() {
    readSettingsFromPanel();
    saveSettings();

    const keyword = state.keywords[0] || "";
    if (!keyword) {
      setStatus("先填一个关键词，再打开搜索页。");
      return;
    }

    try {
      await navigator.clipboard.writeText(keyword);
      setStatus(`已复制关键词“${keyword}”，搜索页打开后直接粘贴搜索。`);
    } catch {
      setStatus(`搜索页打开后手动输入关键词：${keyword}`);
    }

    const searchUrl = new URL("/app/search", location.origin);
    searchUrl.searchParams.set("q", keyword);
    window.open(searchUrl.href, "_blank", "noopener,noreferrer");
  }

  function isSearchPage() {
    return location.pathname.replace(/\/+$/, "") === "/app/search";
  }

  function getSearchKeywordFromUrl() {
    const params = new URLSearchParams(location.search);
    return params.get("q") || params.get("keyword") || params.get("query") || "";
  }

  function findSiteSearchInput() {
    const candidates = [
      ...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type]), textarea, [contenteditable="true"]')
    ].filter((field) => !isInsideHelper(field));

    const fields = candidates.filter((field) => {
      if (isInsideHelper(field)) return false;
      const rect = field.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 20) return false;
      const text = [
        field.getAttribute("placeholder") || "",
        field.getAttribute("aria-label") || "",
        field.className || "",
        field.id || ""
      ].join(" ");
      return /搜|search|keyword|关键词|帖子|内容/i.test(text) || candidates.length === 1;
    });

    return fields[0] || null;
  }

  function submitSiteSearchInput(field, keyword) {
    field.focus();
    if ("value" in field) {
      field.value = keyword;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      field.textContent = keyword;
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: keyword }));
    }
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  }

  async function triggerSearchFromUrl() {
    if (!isSearchPage()) return;
    const keyword = getSearchKeywordFromUrl();
    if (!keyword) return;

    setStatus(`正在尝试搜索“${keyword}”。如果页面提示登录，先登录后刷新此页。`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const field = findSiteSearchInput();
      if (field) {
        submitSiteSearchInput(field, keyword);
        setTimeout(() => scanLoadedPosts({ resetHighlights: true }), 1200);
        return;
      }
      await sleep(500);
    }
    setStatus(`没找到搜索框。可能需要先登录；登录后刷新页面，或手动粘贴：${keyword}`);
  }

  function parseKeywords(value) {
    return value
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function setStatus(message) {
    const status = document.querySelector("[data-xhh-helper-status]");
    if (status) status.textContent = message;
  }

  function setCollectingState(isCollecting) {
    const collectButton = document.querySelector("[data-xhh-helper-collect]");
    const stopButton = document.querySelector("[data-xhh-helper-stop]");
    if (collectButton) collectButton.disabled = isCollecting;
    if (stopButton) stopButton.disabled = !isCollecting;
  }

  function createPanel() {
    const panel = document.createElement("aside");
    panel.className = "xhh-keyword-helper-panel";
    panel.innerHTML = `
      <div class="xhh-keyword-helper-head">
        <strong>关键词采集</strong>
        <button type="button" data-xhh-helper-toggle title="收起/展开">-</button>
      </div>
      <label>
        关键词
        <textarea data-xhh-helper-keywords rows="3" spellcheck="false"></textarea>
      </label>
      <div class="xhh-keyword-helper-field">
        <div class="xhh-keyword-helper-label">评论草稿池</div>
        <div data-xhh-helper-drafts class="xhh-keyword-helper-drafts"></div>
      </div>
      <div class="xhh-keyword-helper-draft-tools">
        <button type="button" data-xhh-helper-add-draft>新增草稿</button>
      </div>
      <div class="xhh-keyword-helper-row">
        <label>
          采集页数
          <input type="number" min="1" max="80" step="1" data-xhh-helper-max-steps>
        </label>
      </div>
      <div class="xhh-keyword-helper-actions">
        <button type="button" data-xhh-helper-save>保存</button>
        <button type="button" data-xhh-helper-scan>扫当前</button>
        <button type="button" data-xhh-helper-search>打开搜索页</button>
        <button type="button" data-xhh-helper-collect>采集更多</button>
        <button type="button" data-xhh-helper-stop disabled>停止</button>
      </div>
      <p data-xhh-helper-summary class="xhh-keyword-helper-summary"></p>
      <p data-xhh-helper-status class="xhh-keyword-helper-status"></p>
      <div data-xhh-helper-list class="xhh-keyword-helper-list"></div>
    `;
    document.documentElement.append(panel);

    panel.querySelector("[data-xhh-helper-keywords]").value = state.keywords.join("\n");
    renderDraftEditors();
    panel.querySelector("[data-xhh-helper-max-steps]").value = state.maxSteps;

    panel.querySelector("[data-xhh-helper-save]").addEventListener("click", () => {
      readSettingsFromPanel();
      saveSettings();
      resetCollectedPosts();
      scanLoadedPosts({ resetHighlights: true });
      setStatus("已保存设置，并重新扫描当前已加载帖子。");
    });
    panel.querySelector("[data-xhh-helper-scan]").addEventListener("click", () => {
      readSettingsFromPanel();
      saveSettings();
      resetMatches();
      scanLoadedPosts({ resetHighlights: true });
    });
    panel.querySelector("[data-xhh-helper-collect]").addEventListener("click", () => {
      readSettingsFromPanel();
      saveSettings();
      resetMatches();
      collectMorePosts();
    });
    panel.querySelector("[data-xhh-helper-search]").addEventListener("click", openKeywordSearch);
    panel.querySelector("[data-xhh-helper-add-draft]").addEventListener("click", () => {
      const nextDrafts = readDraftEditors({ keepBlank: true });
      nextDrafts.push("");
      setDraftsForRender(nextDrafts);
      renderDraftEditors();
    });
    panel.querySelector("[data-xhh-helper-stop]").addEventListener("click", stopCollecting);
    panel.querySelector("[data-xhh-helper-toggle]").addEventListener("click", () => {
      panel.classList.toggle("xhh-keyword-helper-panel-collapsed");
    });
  }

  function readSettingsFromPanel() {
    const keywordInput = document.querySelector("[data-xhh-helper-keywords]");
    const maxStepsInput = document.querySelector("[data-xhh-helper-max-steps]");

    state.keywords = parseKeywords(keywordInput?.value || "").slice(0, 80);
    if (!state.keywords.length) state.keywords = defaultKeywords;
    state.drafts = readDraftEditors();
    if (!state.drafts.length) state.drafts = defaultDrafts;
    state.maxSteps = Math.min(80, Math.max(1, Number(maxStepsInput?.value || 12)));
  }

  function readDraftEditors(options = {}) {
    const { keepBlank = false } = options;
    const drafts = [...document.querySelectorAll("[data-xhh-helper-draft]")]
      .map((input) => normalizeDraft(input.value));
    if (keepBlank) return drafts;
    return drafts.filter(Boolean);
  }

  function getRenderableDrafts() {
    return state.drafts.length ? state.drafts : [""];
  }

  function setDraftsForRender(drafts) {
    state.drafts = drafts.length ? drafts : [""];
  }

  function renderDraftEditors() {
    const container = document.querySelector("[data-xhh-helper-drafts]");
    if (!container) return;

    const drafts = getRenderableDrafts();
    container.innerHTML = "";
    drafts.forEach((draft, index) => {
      const item = document.createElement("div");
      item.className = "xhh-keyword-helper-draft";

      const head = document.createElement("div");
      head.className = "xhh-keyword-helper-draft-head";

      const title = document.createElement("span");
      title.textContent = `草稿 ${index + 1}`;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "删除";
      remove.disabled = drafts.length === 1;
      remove.addEventListener("click", () => {
        const nextDrafts = readDraftEditors({ keepBlank: true });
        nextDrafts.splice(index, 1);
        setDraftsForRender(nextDrafts);
        renderDraftEditors();
      });

      const textarea = document.createElement("textarea");
      textarea.rows = 4;
      textarea.dataset.xhhHelperDraft = "";
      textarea.value = draft;
      textarea.placeholder = "这里可以写多行评论内容";

      head.append(title, remove);
      item.append(head, textarea);
      container.append(item);
    });
  }

  function resetMatches() {
    state.matches.clear();
    document.querySelectorAll(".xhh-keyword-helper-match").forEach((node) => {
      node.classList.remove("xhh-keyword-helper-match");
    });
  }

  function resetCollectedPosts() {
    resetMatches();
    state.seenPosts.clear();
  }

  function renderMatches() {
    const list = document.querySelector("[data-xhh-helper-list]");
    const summary = document.querySelector("[data-xhh-helper-summary]");
    if (!list || !summary) return;

    summary.textContent = `已扫 ${state.seenPosts.size} 个帖子，命中 ${state.matches.size} 个。`;

    const matches = [...state.matches.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, 80);

    if (!matches.length) {
      list.innerHTML = `<p class="xhh-keyword-helper-empty">还没命中。先点“采集更多”，或换成更宽一点的关键词。</p>`;
      return;
    }

    list.innerHTML = "";
    for (const match of matches) {
      const item = document.createElement("article");
      item.className = "xhh-keyword-helper-item";

      const link = document.createElement("a");
      link.href = match.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = match.title;

      const meta = document.createElement("span");
      meta.textContent = `命中：${match.keywords.join(", ")}`;

      const preview = document.createElement("p");
      preview.textContent = match.text.slice(0, 140);

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "复制草稿";
      button.addEventListener("click", () => copyDraft(match));

      const prefillButton = document.createElement("button");
      prefillButton.type = "button";
      prefillButton.textContent = "打开并预填";
      prefillButton.addEventListener("click", () => openAndPrefill(match));

      const actions = document.createElement("div");
      actions.className = "xhh-keyword-helper-item-actions";
      actions.append(button, prefillButton);

      item.append(link, meta, preview, actions);
      list.append(item);
    }
  }

  createPanel();
  scanLoadedPosts();
  triggerSearchFromUrl();
  prefillPendingDraft();

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
})();
