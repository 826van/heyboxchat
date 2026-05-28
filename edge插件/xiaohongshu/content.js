(() => {
  if (window.__xhsKeywordHelperLoaded) return;
  window.__xhsKeywordHelperLoaded = true;

  const STORAGE_KEYWORDS = "xhsKeywordHelperKeywords";
  const STORAGE_DRAFTS = "xhsKeywordHelperDrafts";
  const STORAGE_DRAFT = "xhsKeywordHelperDraft";
  const STORAGE_MAX_STEPS = "xhsKeywordHelperMaxSteps";
  const STORAGE_PENDING_DRAFT = "xhsKeywordHelperPendingDraft";

  const defaultKeywords = ["求推荐", "怎么买", "多少钱", "好用吗"];
  const defaultDrafts = ["看情况回一句，发之前先确认笔记内容是否真的相关。"];
  const defaultDraft = defaultDrafts[0];

  const state = {
    keywords: loadList(STORAGE_KEYWORDS, defaultKeywords),
    drafts: loadDrafts(),
    maxSteps: Number(localStorage.getItem(STORAGE_MAX_STEPS) || 12),
    matches: new Map(),
    seenNotes: new Map(),
    scanTimer: null,
    collecting: false,
    lastScanNewNotes: 0,
    lastScanMatches: 0
  };

  const noteLinkSelector = [
    'a[href*="/explore/"]',
    'a[href*="/discovery/item/"]',
    'a[href*="/search_result/"]'
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
    return url.href;
  }

  function noteKeyFromUrl(url) {
    const parsed = new URL(url, location.href);
    const noteMatch = parsed.pathname.match(/\/(?:explore|discovery\/item|search_result)\/([^/?#]+)/);
    if (noteMatch) return `note:${noteMatch[1]}`;
    return `${parsed.origin}${parsed.pathname}`;
  }

  function extensionStorageAvailable() {
    return Boolean(globalThis.chrome?.storage?.local);
  }

  function setExtensionStorage(key, value) {
    if (!extensionStorageAvailable()) return Promise.resolve(false);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => {
        resolve(!chrome.runtime?.lastError);
      });
    });
  }

  function getExtensionStorage(key) {
    if (!extensionStorageAvailable()) return Promise.resolve(null);
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => {
        if (chrome.runtime?.lastError) {
          resolve(null);
          return;
        }
        resolve(result?.[key] || null);
      });
    });
  }

  function removeExtensionStorage(key) {
    if (!extensionStorageAvailable()) return Promise.resolve(false);
    return new Promise((resolve) => {
      chrome.storage.local.remove(key, () => {
        resolve(!chrome.runtime?.lastError);
      });
    });
  }

  function isInsideHelper(node) {
    return Boolean(node.closest?.(".xhs-keyword-helper-panel"));
  }

  function visibleEnough(node) {
    const rect = node.getBoundingClientRect();
    return rect.width > 80 && rect.height > 30;
  }

  function collectCandidateLinks() {
    const directLinks = [...document.querySelectorAll(noteLinkSelector)]
      .filter((link) => !isInsideHelper(link));

    if (directLinks.length) return uniqueLinks(directLinks);

    const fallbackLinks = [...document.querySelectorAll("a[href]")]
      .filter((link) => {
        if (isInsideHelper(link)) return false;
        const href = link.getAttribute("href") || "";
        if (!/\/explore\/|\/discovery\/item\//.test(href)) return false;
        return normalizeText(link.innerText || link.textContent).length >= 8;
      });

    return uniqueLinks(fallbackLinks);
  }

  function uniqueLinks(links) {
    const unique = new Map();
    for (const link of links) {
      try {
        const url = cleanUrl(link.href || link.getAttribute("href"));
        unique.set(noteKeyFromUrl(url), link);
      } catch {
        // Ignore malformed href values from dynamic markup.
      }
    }
    return [...unique.values()];
  }

  function findNoteContainer(link) {
    let current = link;
    let best = link;
    for (let depth = 0; depth < 7 && current && current !== document.body; depth += 1) {
      if (isInsideHelper(current)) break;

      const text = normalizeText(current.innerText || current.textContent);
      const rect = current.getBoundingClientRect();
      const linkCount = current.querySelectorAll?.("a[href]").length || 0;
      if (
        text.length >= 8 &&
        text.length <= 1800 &&
        rect.height >= 30 &&
        rect.height <= 900 &&
        linkCount <= 12
      ) {
        best = current;
      }
      current = current.parentElement;
    }
    return best;
  }

  function textFromNote(link, container) {
    const title =
      container.querySelector?.('[class*="title"]') ||
      container.querySelector?.('[class*="name"]') ||
      link.querySelector?.('[class*="title"]') ||
      link.querySelector?.('[class*="name"]');
    const content =
      container.querySelector?.('[class*="content"]') ||
      container.querySelector?.('[class*="desc"]') ||
      container.querySelector?.('[class*="note"]') ||
      link.querySelector?.('[class*="content"]') ||
      link.querySelector?.('[class*="desc"]');

    const pieces = [
      title?.innerText || title?.textContent || "",
      content?.innerText || content?.textContent || "",
      link.innerText || link.textContent || "",
      container.innerText || container.textContent || ""
    ].map(normalizeText).filter(Boolean);

    return [...new Set(pieces)].join(" ");
  }

  function titleFromNote(text) {
    return text.slice(0, 90) || "未命名笔记";
  }

  function matchedKeywords(text) {
    const lowerText = text.toLocaleLowerCase();
    return state.keywords.filter((keyword) => {
      const item = keyword.toLocaleLowerCase();
      return item && lowerText.includes(item);
    });
  }

  function scanLoadedNotes(options = {}) {
    const { resetHighlights = false } = options;
    if (resetHighlights) {
      document.querySelectorAll(".xhs-keyword-helper-match").forEach((node) => {
        node.classList.remove("xhs-keyword-helper-match");
      });
    }

    let newNotes = 0;
    let newMatches = 0;
    const links = collectCandidateLinks();

    for (const link of links) {
      if (!visibleEnough(link) && !link.matches(noteLinkSelector)) continue;

      let url;
      try {
        url = cleanUrl(link.href || link.getAttribute("href"));
      } catch {
        continue;
      }

      const key = noteKeyFromUrl(url);
      const container = findNoteContainer(link);
      const text = textFromNote(link, container);
      if (text.length < 4) continue;

      if (!state.seenNotes.has(key)) newNotes += 1;
      state.seenNotes.set(key, { key, url, title: titleFromNote(text), text });

      const keywords = matchedKeywords(text);
      if (!keywords.length) {
        container.classList.remove("xhs-keyword-helper-match");
        continue;
      }

      container.classList.add("xhs-keyword-helper-match");
      if (!state.matches.has(key)) newMatches += 1;
      state.matches.set(key, {
        key,
        url,
        title: titleFromNote(text),
        keywords,
        text,
        lastSeenAt: Date.now()
      });
    }

    state.lastScanNewNotes = newNotes;
    state.lastScanMatches = newMatches;
    renderMatches();
    setStatus(`本次新增 ${newNotes} 条笔记，新增命中 ${newMatches} 条。`);
    return { newNotes, newMatches, scanned: links.length };
  }

  function scheduleScan() {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => scanLoadedNotes(), 350);
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
    const amount = Math.max(window.innerHeight * 1.35, 820);
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
      scanLoadedNotes();
      const info = scrollInfo(target);
      if (state.seenNotes.size > beforeSeen || info.height > beforeHeight + 120) return;
    }
  }

  async function collectMoreNotes() {
    if (state.collecting) return;
    state.collecting = true;
    setCollectingState(true);

    let staleSteps = 0;
    for (let step = 1; step <= state.maxSteps && state.collecting; step += 1) {
      const target = getScrollTarget();
      const before = scrollInfo(target);
      const beforeSeen = state.seenNotes.size;

      scanLoadedNotes();
      scrollTargetByPage(target);
      setStatus(`采集中 ${step}/${state.maxSteps}，已扫 ${state.seenNotes.size} 条笔记，命中 ${state.matches.size} 条。`);
      await waitForFeedChange(target, beforeSeen, before.height);

      scanLoadedNotes();
      const after = scrollInfo(target);
      const noNewNotes = state.seenNotes.size === beforeSeen;
      const nearBottom = after.top + after.viewport >= after.height - 80;
      const noScrollMovement = after.top <= before.top + 8;
      staleSteps = noNewNotes && (nearBottom || noScrollMovement) ? staleSteps + 1 : 0;
      if (staleSteps >= 3) break;
    }

    state.collecting = false;
    setCollectingState(false);
    setStatus(`采集结束：已扫 ${state.seenNotes.size} 条笔记，命中 ${state.matches.size} 条。`);
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

    const text = `${draft}\n\n笔记：${match.url}`;
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

    const pendingDraft = {
      key: match.key,
      url: match.url,
      text,
      createdAt: Date.now()
    };
    localStorage.setItem(STORAGE_PENDING_DRAFT, JSON.stringify(pendingDraft));
    const opened = window.open("about:blank", "_blank");
    await setExtensionStorage(STORAGE_PENDING_DRAFT, pendingDraft);

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard can be blocked by the browser; localStorage still carries the draft.
    }

    if (opened) {
      try {
        opened.location.replace(match.url);
      } catch {
        opened.location.href = match.url;
      }
    } else {
      location.href = match.url;
    }
    setStatus("已打开笔记并准备预填。最后发布仍需要你在笔记页手动确认。");
  }

  function shouldRemovePendingDraft(pending) {
    return Boolean(
      pending &&
      (!pending.text || !pending.createdAt || Date.now() - pending.createdAt > 15 * 60 * 1000)
    );
  }

  function validatePendingDraft(pending) {
    if (!pending || shouldRemovePendingDraft(pending)) return null;

    const currentKey = noteKeyFromUrl(location.href);
    if (pending.key && pending.key !== currentKey) return null;
    if (pending.url && noteKeyFromUrl(pending.url) !== currentKey) return null;
    return pending;
  }

  async function clearPendingDraft() {
    localStorage.removeItem(STORAGE_PENDING_DRAFT);
    await removeExtensionStorage(STORAGE_PENDING_DRAFT);
  }

  async function loadPendingDraft() {
    try {
      const localPending = JSON.parse(localStorage.getItem(STORAGE_PENDING_DRAFT) || "null");
      if (shouldRemovePendingDraft(localPending)) localStorage.removeItem(STORAGE_PENDING_DRAFT);
      const validLocal = validatePendingDraft(localPending);
      if (validLocal) return validLocal;
    } catch {
      localStorage.removeItem(STORAGE_PENDING_DRAFT);
    }

    const storedPending = await getExtensionStorage(STORAGE_PENDING_DRAFT);
    if (shouldRemovePendingDraft(storedPending)) {
      await removeExtensionStorage(STORAGE_PENDING_DRAFT);
      return null;
    }
    const validStored = validatePendingDraft(storedPending);
    return validStored;
  }

  function isLikelyNotePage() {
    const key = noteKeyFromUrl(location.href);
    return key.startsWith("note:");
  }

  async function waitForNotePageFromPending() {
    const storedPending = await getExtensionStorage(STORAGE_PENDING_DRAFT);
    if (!storedPending || !storedPending.text) return null;
    if (shouldRemovePendingDraft(storedPending)) {
      await removeExtensionStorage(STORAGE_PENDING_DRAFT);
      return null;
    }

    for (let attempt = 0; attempt < 24; attempt += 1) {
      const valid = validatePendingDraft(storedPending);
      if (valid) return valid;
      await sleep(isLikelyNotePage() ? 250 : 350);
    }
    return null;
  }

  function isCommentInput(element) {
    if (isInsideHelper(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 16) return false;
    if (element.disabled || element.readOnly) return false;

    const text = normalizeText([
      element.getAttribute("placeholder") || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("role") || "",
      element.className || "",
      element.id || "",
      element.innerText || element.textContent || ""
    ].join(" "));

    if (/搜索|search|私信|昵称|验证码|手机号|密码/i.test(text)) return false;
    if (/评论|回复|comment|reply|说点|输入|互动/i.test(text)) return true;
    if (element.matches("textarea, input")) return /comment|reply/i.test(`${element.name || ""} ${element.id || ""}`);
    return element.isContentEditable && rect.height >= 18;
  }

  function findCommentInput() {
    const selectors = [
      "textarea",
      'input[type="text"]',
      'input:not([type])',
      '[contenteditable="true"]',
      '[role="textbox"]',
      ".ProseMirror"
    ];

    const fields = selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter(isCommentInput)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
      });

    return fields[0] || null;
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

    if (/搜索|search|分享|收藏|点赞|关注/i.test(text)) return false;
    return /评论|回复|comment|reply|说点|输入|我来说/i.test(text);
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
    const pending = await loadPendingDraft() || await waitForNotePageFromPending();
    if (!pending) return;

    setStatus("检测到待填评论，正在查找评论框。不会自动发送。");
    for (let attempt = 0; attempt < 36; attempt += 1) {
      const input = findCommentInput();
      if (input) {
        fillInput(input, pending.text);
        setStatus("评论已预填。请检查内容，然后手动点击小红书的发布按钮。");
        await clearPendingDraft();
        return;
      }
      if (attempt === 3 || attempt === 9 || attempt === 18) clickCommentTrigger();
      if (attempt === 6 || attempt === 14 || attempt === 24) {
        window.scrollBy({ top: Math.max(window.innerHeight * 0.7, 480), behavior: "smooth" });
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

    const searchUrl = new URL("/search_result", location.origin);
    searchUrl.searchParams.set("keyword", keyword);
    searchUrl.searchParams.set("source", "web_explore_feed");
    window.open(searchUrl.href, "_blank", "noopener,noreferrer");
  }

  function parseKeywords(value) {
    return value
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function setStatus(message) {
    const status = document.querySelector("[data-xhs-helper-status]");
    if (status) status.textContent = message;
  }

  function setCollectingState(isCollecting) {
    const collectButton = document.querySelector("[data-xhs-helper-collect]");
    const stopButton = document.querySelector("[data-xhs-helper-stop]");
    if (collectButton) collectButton.disabled = isCollecting;
    if (stopButton) stopButton.disabled = !isCollecting;
  }

  function createPanel() {
    const panel = document.createElement("aside");
    panel.className = "xhs-keyword-helper-panel";
    panel.innerHTML = `
      <div class="xhs-keyword-helper-head">
        <strong>小红书采集</strong>
        <button type="button" data-xhs-helper-toggle title="收起/展开">-</button>
      </div>
      <label>
        关键词
        <textarea data-xhs-helper-keywords rows="3" spellcheck="false"></textarea>
      </label>
      <div class="xhs-keyword-helper-field">
        <div class="xhs-keyword-helper-label">评论草稿池</div>
        <div data-xhs-helper-drafts class="xhs-keyword-helper-drafts"></div>
      </div>
      <div class="xhs-keyword-helper-draft-tools">
        <button type="button" data-xhs-helper-add-draft>新增草稿</button>
      </div>
      <div class="xhs-keyword-helper-row">
        <label>
          采集页数
          <input type="number" min="1" max="80" step="1" data-xhs-helper-max-steps>
        </label>
      </div>
      <div class="xhs-keyword-helper-actions">
        <button type="button" data-xhs-helper-save>保存</button>
        <button type="button" data-xhs-helper-scan>扫当前</button>
        <button type="button" data-xhs-helper-search>打开搜索页</button>
        <button type="button" data-xhs-helper-collect>采集更多</button>
        <button type="button" data-xhs-helper-stop disabled>停止</button>
      </div>
      <p data-xhs-helper-summary class="xhs-keyword-helper-summary"></p>
      <p data-xhs-helper-status class="xhs-keyword-helper-status"></p>
      <div data-xhs-helper-list class="xhs-keyword-helper-list"></div>
    `;
    document.documentElement.append(panel);

    panel.querySelector("[data-xhs-helper-keywords]").value = state.keywords.join("\n");
    renderDraftEditors();
    panel.querySelector("[data-xhs-helper-max-steps]").value = state.maxSteps;

    panel.querySelector("[data-xhs-helper-save]").addEventListener("click", () => {
      readSettingsFromPanel();
      saveSettings();
      resetCollectedNotes();
      scanLoadedNotes({ resetHighlights: true });
      setStatus("已保存设置，并重新扫描当前已加载笔记。");
    });
    panel.querySelector("[data-xhs-helper-scan]").addEventListener("click", () => {
      readSettingsFromPanel();
      saveSettings();
      resetMatches();
      scanLoadedNotes({ resetHighlights: true });
    });
    panel.querySelector("[data-xhs-helper-collect]").addEventListener("click", () => {
      readSettingsFromPanel();
      saveSettings();
      resetMatches();
      collectMoreNotes();
    });
    panel.querySelector("[data-xhs-helper-search]").addEventListener("click", openKeywordSearch);
    panel.querySelector("[data-xhs-helper-add-draft]").addEventListener("click", () => {
      const nextDrafts = readDraftEditors({ keepBlank: true });
      nextDrafts.push("");
      setDraftsForRender(nextDrafts);
      renderDraftEditors();
    });
    panel.querySelector("[data-xhs-helper-stop]").addEventListener("click", stopCollecting);
    panel.querySelector("[data-xhs-helper-toggle]").addEventListener("click", () => {
      panel.classList.toggle("xhs-keyword-helper-panel-collapsed");
    });
  }

  function readSettingsFromPanel() {
    const keywordInput = document.querySelector("[data-xhs-helper-keywords]");
    const maxStepsInput = document.querySelector("[data-xhs-helper-max-steps]");

    state.keywords = parseKeywords(keywordInput?.value || "").slice(0, 80);
    if (!state.keywords.length) state.keywords = defaultKeywords;
    state.drafts = readDraftEditors();
    if (!state.drafts.length) state.drafts = defaultDrafts;
    state.maxSteps = Math.min(80, Math.max(1, Number(maxStepsInput?.value || 12)));
  }

  function readDraftEditors(options = {}) {
    const { keepBlank = false } = options;
    const drafts = [...document.querySelectorAll("[data-xhs-helper-draft]")]
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
    const container = document.querySelector("[data-xhs-helper-drafts]");
    if (!container) return;

    const drafts = getRenderableDrafts();
    container.innerHTML = "";
    drafts.forEach((draft, index) => {
      const item = document.createElement("div");
      item.className = "xhs-keyword-helper-draft";

      const head = document.createElement("div");
      head.className = "xhs-keyword-helper-draft-head";

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
      textarea.dataset.xhsHelperDraft = "";
      textarea.value = draft;
      textarea.placeholder = "这里可以写多行评论内容";

      head.append(title, remove);
      item.append(head, textarea);
      container.append(item);
    });
  }

  function resetMatches() {
    state.matches.clear();
    document.querySelectorAll(".xhs-keyword-helper-match").forEach((node) => {
      node.classList.remove("xhs-keyword-helper-match");
    });
  }

  function resetCollectedNotes() {
    resetMatches();
    state.seenNotes.clear();
  }

  function renderMatches() {
    const list = document.querySelector("[data-xhs-helper-list]");
    const summary = document.querySelector("[data-xhs-helper-summary]");
    if (!list || !summary) return;

    summary.textContent = `已扫 ${state.seenNotes.size} 条笔记，命中 ${state.matches.size} 条。`;

    const matches = [...state.matches.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, 80);

    if (!matches.length) {
      list.innerHTML = `<p class="xhs-keyword-helper-empty">还没命中。先点“采集更多”，或换成更宽一点的关键词。</p>`;
      return;
    }

    list.innerHTML = "";
    for (const match of matches) {
      const item = document.createElement("article");
      item.className = "xhs-keyword-helper-item";

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
      actions.className = "xhs-keyword-helper-item-actions";
      actions.append(button, prefillButton);

      item.append(link, meta, preview, actions);
      list.append(item);
    }
  }

  createPanel();
  scanLoadedNotes();
  prefillPendingDraft();

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
})();
