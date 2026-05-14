/* ============================================================
   TOEFL Vocabulary Study App - Main Application
   ============================================================ */

'use strict';

/* ============================================================
   SECTION 1: STORAGE & DATA LAYER
   ============================================================ */

const KEYS = {
  WORDS: 'toefl_words',
  SETTINGS: 'toefl_settings',
  SESSION: 'toefl_session',
};

const DB = {
  getWords() {
    try {
      return JSON.parse(localStorage.getItem(KEYS.WORDS) || '[]');
    } catch (e) {
      return [];
    }
  },

  saveWords(words) {
    localStorage.setItem(KEYS.WORDS, JSON.stringify(words));
  },

  addWord(data) {
    const words = this.getWords();
    const now = today();
    const word = {
      id: uuid(),
      word: (data.word || '').trim(),
      phonetic: (data.phonetic || '').trim(),
      partOfSpeech: data.partOfSpeech || '',
      definition: (data.definition || '').trim(),
      example: (data.example || '').trim(),
      notes: (data.notes || '').trim(),
      repetitions: 0,
      interval: 1,
      easeFactor: 2.5,
      nextReview: now,
      lastReview: null,
      totalReviews: 0,
      createdAt: now,
    };
    words.push(word);
    this.saveWords(words);
    return word;
  },

  updateWord(id, data) {
    const words = this.getWords();
    const idx = words.findIndex(w => w.id === id);
    if (idx === -1) return null;
    words[idx] = { ...words[idx], ...data };
    this.saveWords(words);
    return words[idx];
  },

  deleteWord(id) {
    const words = this.getWords().filter(w => w.id !== id);
    this.saveWords(words);
  },

  getSettings() {
    try {
      const defaults = { apiKey: '', dailyNewLimit: 20 };
      const saved = JSON.parse(localStorage.getItem(KEYS.SETTINGS) || '{}');
      return { ...defaults, ...saved };
    } catch (e) {
      return { apiKey: '', dailyNewLimit: 20 };
    }
  },

  saveSettings(s) {
    localStorage.setItem(KEYS.SETTINGS, JSON.stringify(s));
  },

  getSession() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEYS.SESSION) || '{}');
      const todayStr = today();
      if (raw.date !== todayStr) {
        const fresh = { date: todayStr, reviews: [] };
        localStorage.setItem(KEYS.SESSION, JSON.stringify(fresh));
        return fresh;
      }
      return raw;
    } catch (e) {
      const fresh = { date: today(), reviews: [] };
      localStorage.setItem(KEYS.SESSION, JSON.stringify(fresh));
      return fresh;
    }
  },

  addSessionReview(wordId, quality, wordText) {
    const session = this.getSession();
    session.reviews.push({ wordId, quality, word: wordText, ts: Date.now() });
    localStorage.setItem(KEYS.SESSION, JSON.stringify(session));
  },

  getDueWords() {
    const todayStr = today();
    return this.getWords()
      .filter(w => w.nextReview <= todayStr)
      .sort((a, b) => (a.nextReview < b.nextReview ? -1 : 1));
  },

  // Words that have been reviewed before and are now due again
  getDueReviews() {
    const todayStr = today();
    return this.getWords()
      .filter(w => w.totalReviews > 0 && w.nextReview <= todayStr)
      .sort((a, b) => (a.nextReview < b.nextReview ? -1 : 1));
  },

  // Brand-new words (never reviewed), capped by remaining daily allowance
  getNewWordsForToday() {
    const settings = this.getSettings();
    const limit = settings.dailyNewLimit || 20;
    const todayStr = today();
    // Words whose first-ever review happened today count against today's quota
    const usedToday = this.getWords().filter(
      w => w.totalReviews === 1 && w.lastReview === todayStr
    ).length;
    const remaining = Math.max(0, limit - usedToday);
    if (remaining === 0) return [];
    return this.getWords()
      .filter(w => w.totalReviews === 0)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, remaining);
  },

  // Summary used by dashboard and review view
  getTodayPlan() {
    const settings = this.getSettings();
    const limit = settings.dailyNewLimit || 20;
    const todayStr = today();
    const words = this.getWords();
    const dueReviews = words.filter(w => w.totalReviews > 0 && w.nextReview <= todayStr);
    const allNew = words.filter(w => w.totalReviews === 0);
    const usedToday = words.filter(w => w.totalReviews === 1 && w.lastReview === todayStr).length;
    const newAvailable = Math.min(allNew.length, Math.max(0, limit - usedToday));
    return {
      reviewCount: dueReviews.length,
      newCount: newAvailable,
      newPool: allNew.length,
      usedToday,
      limit,
      total: dueReviews.length + newAvailable,
    };
  },

  getDifficultWords() {
    const session = this.getSession();
    const seen = new Set();
    const result = [];
    for (const r of session.reviews) {
      if (r.quality <= 2 && !seen.has(r.wordId)) {
        seen.add(r.wordId);
        result.push(r.word);
      }
    }
    return result;
  },

  getTodayReviewCount() {
    return this.getSession().reviews.length;
  },
};

/* ============================================================
   SECTION 2: SM-2 ALGORITHM
   ============================================================ */

function sm2Update(card, quality) {
  // quality 0-5; threshold for "pass" is >= 3
  let { repetitions, interval, easeFactor } = card;
  const todayStr = today();

  if (quality >= 3) {
    if (repetitions === 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * easeFactor);
    }
    repetitions += 1;
    // EF = EF + (0.1 - (5-q)*(0.08+(5-q)*0.02))
    easeFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    if (easeFactor < 1.3) easeFactor = 1.3;
  } else {
    repetitions = 0;
    interval = 1;
    // EF does not change on failure
  }

  const nextDate = addDays(todayStr, interval);

  return {
    repetitions,
    interval,
    easeFactor: Math.round(easeFactor * 1000) / 1000,
    nextReview: nextDate,
    lastReview: todayStr,
    totalReviews: (card.totalReviews || 0) + 1,
  };
}

function getFamiliarity(card) {
  if (!card.totalReviews || card.totalReviews === 0) return 'new';
  if (card.interval <= 7) return 'learning';
  if (card.interval <= 21) return 'review';
  return 'mastered';
}

/* ============================================================
   SECTION 2b: LOWEST-MASTERY DUE WORDS HELPER
   Returns all due-today words that share the lowest mastery tier.
   Tier order: new(0) < learning(1) < review(2) < mastered(3)
   ============================================================ */

const MASTERY_ORDER = { new: 0, learning: 1, review: 2, mastered: 3 };
const MASTERY_LABEL_ZH = { new: '新词', learning: '学习中', review: '复习', mastered: '已掌握' };

function getDueTodayByLowestMastery() {
  const todayStr = today();
  const due = DB.getWords().filter(w => w.nextReview <= todayStr);
  if (due.length === 0) return { words: [], level: null };

  const minLevel = Math.min(...due.map(w => MASTERY_ORDER[getFamiliarity(w)]));
  const levelKey = Object.keys(MASTERY_ORDER).find(k => MASTERY_ORDER[k] === minLevel);
  const words = due.filter(w => getFamiliarity(w) === levelKey);
  return { words, level: levelKey };
}

/* ============================================================
   TOEFL TOPIC POOL  — picked randomly on each generation
   ============================================================ */

const TOEFL_TOPICS = [
  { en: 'marine biology and deep-ocean ecosystems',           zh: '海洋生物' },
  { en: 'ancient civilizations and archaeological discovery', zh: '古代文明' },
  { en: 'climate science and environmental conservation',     zh: '气候科学' },
  { en: 'behavioral psychology and decision-making biases',   zh: '行为心理学' },
  { en: 'astronomy and planetary formation',                  zh: '天文学' },
  { en: 'macroeconomics and international trade policy',      zh: '宏观经济' },
  { en: 'renewable energy and sustainable engineering',       zh: '可再生能源' },
  { en: 'evolutionary biology and genetic adaptation',        zh: '进化生物学' },
  { en: 'art history and cross-cultural aesthetics',          zh: '艺术史' },
  { en: 'urban planning and modern infrastructure',           zh: '城市规划' },
  { en: 'linguistics and second-language acquisition',        zh: '语言学' },
  { en: 'public health, epidemiology and disease control',    zh: '公共卫生' },
  { en: 'anthropology and early human migration',             zh: '人类学' },
  { en: 'neuroscience and memory consolidation',              zh: '神经科学' },
  { en: 'geology, plate tectonics and volcanic activity',     zh: '地质学' },
];

function pickRandomTopic() {
  return TOEFL_TOPICS[Math.floor(Math.random() * TOEFL_TOPICS.length)];
}

/* ============================================================
   SECTION 3: UTILITIES
   ============================================================ */

function uuid() {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function formatDayOfWeek(iso) {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const d = new Date(iso + 'T00:00:00');
  return days[d.getDay()];
}

function toast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-msg">${escapeHtml(message)}</span>`;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove());
  }, 3000);
}

function showModal(htmlContent) {
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  content.innerHTML = htmlContent;
  overlay.classList.add('is-open');
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('is-open');
  document.getElementById('modal-content').innerHTML = '';
}

function renderMarkdown(text) {
  if (!text) return '';
  // Convert **bold** to <strong>
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ============================================================
   SECTION 4: DASHBOARD VIEW
   ============================================================ */

function renderDashboard() {
  const words = DB.getWords();
  const session = DB.getSession();
  const todayStr = today();
  const plan = DB.getTodayPlan();

  const total = words.length;
  const masteredCount = words.filter(w => getFamiliarity(w) === 'mastered').length;
  const reviewedToday = session.reviews.length;
  const difficultWords = DB.getDifficultWords();

  // Build 7-day activity data
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(todayStr, -i);
    days7.push(d);
  }

  // Compute review counts per day from session (today only available in session)
  // For past days, derive from words' lastReview field
  const dayCounts = {};
  days7.forEach(d => { dayCounts[d] = 0; });

  // Count from session for today
  dayCounts[todayStr] = reviewedToday;

  // Count from words' review history for other days (approximate from totalReviews isn't precise)
  // We'll just show today's count vs 0 for past since we don't store history per day
  // Better: store in localStorage a running daily log
  const activityLog = getActivityLog();
  days7.forEach(d => {
    if (d !== todayStr && activityLog[d] !== undefined) {
      dayCounts[d] = activityLog[d];
    }
  });

  const maxCount = Math.max(...Object.values(dayCounts), 1);

  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const barsHtml = days7.map(d => {
    const cnt = dayCounts[d] || 0;
    const heightPct = Math.max((cnt / maxCount) * 100, cnt > 0 ? 8 : 3);
    const isToday = d === todayStr;
    const dayObj = new Date(d + 'T00:00:00');
    const label = isToday ? '今' : dayNames[dayObj.getDay()];
    return `
      <div class="activity-day" title="${d}: ${cnt}次">
        <div class="activity-bar-wrap">
          <div class="activity-bar ${cnt === 0 ? 'empty' : ''}" style="height:${heightPct}%;opacity:${isToday ? 1 : 0.65}"></div>
        </div>
        <span class="activity-label">${label}</span>
        <span class="activity-count">${cnt > 0 ? cnt : ''}</span>
      </div>`;
  }).join('');

  const difficultBanner = difficultWords.length > 0 ? `
    <div class="difficult-banner">
      <span class="banner-icon">⚠️</span>
      <span class="banner-text">今天有 <strong>${difficultWords.length}</strong> 个难词，建议生成复习短文</span>
      <button class="banner-link" onclick="Router.navigate('story')">去生成短文 →</button>
    </div>` : '';

  return `
    <div class="view-header">
      <div>
        <h1 class="view-title">今日概况</h1>
        <p class="view-subtitle" id="dashboard-clock">${formatDate(todayStr)} · ${formatDayOfWeek(todayStr)}</p>
      </div>
      ${plan.total === 0 && (plan.reviewCount > 0 || plan.usedToday > 0)
        ? `<div style="background:#E8F5E9;color:#2E7D32;border-radius:var(--radius);padding:8px 14px;font-size:13px;font-weight:600;">✅ 今日任务已完成</div>`
        : ''}
    </div>

    <div class="dashboard-grid">
      <div class="stat-card stat-primary">
        <span class="stat-icon">🔄</span>
        <div class="stat-number">${plan.reviewCount}</div>
        <div class="stat-label">到期复习</div>
      </div>
      <div class="stat-card stat-info">
        <span class="stat-icon">✨</span>
        <div class="stat-number">${plan.newCount}</div>
        <div class="stat-label">今日新词 <span style="font-size:11px;opacity:0.7;">/ ${plan.limit}</span></div>
      </div>
      <div class="stat-card stat-success">
        <span class="stat-icon">🏆</span>
        <div class="stat-number">${masteredCount}</div>
        <div class="stat-label">已掌握</div>
      </div>
      <div class="stat-card stat-warning">
        <span class="stat-icon">✅</span>
        <div class="stat-number">${reviewedToday}</div>
        <div class="stat-label">今日已完成</div>
      </div>
    </div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;font-size:13px;">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:${plan.total > 0 ? '10px' : '0'};">
        <span>📅 今日计划：</span>
        <span>🔄 复习 <strong>${plan.reviewCount}</strong> 个</span>
        <span>✨ 新词 <strong>${plan.newCount}</strong> 个（今日已学 ${plan.usedToday} / 上限 ${plan.limit}）</span>
        ${plan.newPool > plan.newCount + plan.usedToday ? `<span style="color:var(--text-muted);">词库剩余 ${plan.newPool - plan.usedToday} 个未学</span>` : ''}
      </div>
      ${plan.total > 0 ? `
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${Math.round(plan.usedToday / (plan.usedToday + plan.total) * 100) || 0}%;background:var(--primary);border-radius:3px;transition:width .4s;"></div>
        </div>
        <span style="font-size:12px;color:var(--text-muted);white-space:nowrap;">${plan.usedToday} / ${plan.usedToday + plan.total} 已完成</span>
      </div>` : `
      <div style="font-size:12px;color:#2E7D32;">✅ 所有今日单词已学完</div>`}
    </div>

    ${difficultBanner}

    <div class="activity-section">
      <div class="section-header">
        <span class="section-title">📈 最近7天复习记录</span>
      </div>
      <div class="activity-bars">${barsHtml}</div>
    </div>

    <div class="card">
      <div class="card-title">快速操作</div>
      <div class="dashboard-actions">
        <button class="btn btn-primary btn-lg" onclick="Router.navigate('review')" ${plan.total === 0 ? 'disabled' : ''}>
          <span>🔄</span> 开始复习
          ${plan.total > 0
            ? `<span style="font-size:13px;opacity:0.85;margin-left:4px;">(复习${plan.reviewCount} + 新词${plan.newCount})</span>`
            : '<span style="font-size:13px;opacity:0.7;margin-left:4px;">(今日已完成)</span>'}
        </button>
        <button class="btn btn-ghost btn-lg" onclick="Router.navigate('wordlist')">
          <span>📖</span> 管理单词
        </button>
        <button class="btn btn-ghost btn-lg" onclick="Router.navigate('story')">
          <span>✍️</span> 生成短文
        </button>
      </div>
    </div>
  `;
}

function getActivityLog() {
  try {
    return JSON.parse(localStorage.getItem('toefl_activity') || '{}');
  } catch (e) {
    return {};
  }
}

function recordActivityToday() {
  const log = getActivityLog();
  const todayStr = today();
  const session = DB.getSession();
  log[todayStr] = session.reviews.length;
  // Keep only last 30 days
  const keys = Object.keys(log).sort();
  while (keys.length > 30) {
    delete log[keys.shift()];
  }
  localStorage.setItem('toefl_activity', JSON.stringify(log));
}

/* ============================================================
   SECTION 5: WORD LIST VIEW
   ============================================================ */

let wordListState = { filter: 'all', search: '', selectMode: false, selected: new Set() };

function renderWordList() {
  const words = DB.getWords();
  const todayStr = today();

  return `
    <div class="view-header">
      <div>
        <h1 class="view-title">单词列表</h1>
        <p class="view-subtitle">共 ${words.length} 个单词</p>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost" onclick="openImportModal()">📥 批量导入</button>
        <button class="btn btn-ghost" id="btn-select-mode" onclick="toggleSelectMode()">${wordListState.selectMode ? '完成' : '☑️ 批量管理'}</button>
        <button class="btn btn-primary" onclick="openAddWordModal()">➕ 添加单词</button>
      </div>
    </div>

    <div class="wordlist-toolbar">
      <div class="search-input-wrap">
        <span class="search-icon">🔍</span>
        <input class="search-input" type="text" id="word-search" placeholder="搜索单词或释义..." value="${escapeHtml(wordListState.search)}" oninput="onWordSearch(this.value)" />
      </div>
    </div>

    <div class="filter-tabs" id="filter-tabs">
      ${[['all','全部'],['due','待复习'],['learning','学习中'],['mastered','已掌握']].map(([k,l]) =>
        `<button class="filter-tab ${wordListState.filter === k ? 'active' : ''}" onclick="setWordFilter('${k}')">${l}</button>`
      ).join('')}
    </div>

    <div id="word-list-container">
      ${renderWordListItems(words, todayStr)}
    </div>
  `;
}

function renderWordListItems(allWords, todayStr) {
  let words = [...allWords];

  // Apply filter
  if (wordListState.filter === 'due') {
    words = words.filter(w => w.nextReview <= todayStr);
  } else if (wordListState.filter === 'learning') {
    words = words.filter(w => {
      const f = getFamiliarity(w);
      return f === 'learning' || f === 'new';
    });
  } else if (wordListState.filter === 'mastered') {
    words = words.filter(w => getFamiliarity(w) === 'mastered');
  }

  // Apply search
  if (wordListState.search.trim()) {
    const q = wordListState.search.toLowerCase();
    words = words.filter(w =>
      w.word.toLowerCase().includes(q) ||
      w.definition.toLowerCase().includes(q) ||
      (w.phonetic || '').toLowerCase().includes(q)
    );
  }

  if (words.length === 0) {
    return `
      <div class="empty-state">
        <span class="empty-state-icon">📭</span>
        <div class="empty-state-title">暂无单词</div>
        <div class="empty-state-desc">点击"添加单词"开始构建你的词汇库</div>
        <button class="btn btn-primary" onclick="openAddWordModal()">➕ 添加单词</button>
      </div>`;
  }

  const { selectMode, selected } = wordListState;

  const items = words.map(w => {
    const fam = getFamiliarity(w);
    const badgeClass = `badge-${fam}`;
    const badgeLabel = { new: '新词', learning: '学习中', review: '复习', mastered: '已掌握' }[fam];
    const isDue = w.nextReview <= todayStr;
    const isSelected = selected.has(w.id);

    if (selectMode) {
      return `
        <div class="word-item ${isSelected ? 'word-item--selected' : ''}" onclick="toggleWordSelection('${w.id}')">
          <input type="checkbox" class="word-item-checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation();toggleWordSelection('${w.id}')" />
          <div class="word-item-main">
            <div class="word-item-word">${escapeHtml(w.word)}</div>
            <div class="word-item-def">${escapeHtml(w.definition)}</div>
          </div>
          <span class="badge ${badgeClass}">${badgeLabel}</span>
        </div>`;
    }

    return `
      <div class="word-item" onclick="openEditWordModal('${w.id}')">
        <div class="word-item-main">
          <div class="word-item-word">${escapeHtml(w.word)}</div>
          <div class="word-item-def">${escapeHtml(w.definition)}</div>
        </div>
        <div class="word-item-meta">
          <span class="badge ${badgeClass}">${badgeLabel}</span>
          <span class="word-item-next" title="下次复习">📅 ${isDue ? '<span style="color:var(--danger)">今天</span>' : formatDate(w.nextReview)}</span>
          <div class="word-item-actions" onclick="event.stopPropagation()">
            <button class="icon-btn" title="编辑" onclick="openEditWordModal('${w.id}')">✏️</button>
            <button class="icon-btn danger" title="删除" onclick="confirmDeleteWord('${w.id}', '${escapeHtml(w.word)}')">🗑️</button>
          </div>
        </div>
      </div>`;
  }).join('');

  const bulkBar = selectMode ? `
    <div class="bulk-bar">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input type="checkbox" id="select-all-cb"
          ${selected.size === words.length && words.length > 0 ? 'checked' : ''}
          onchange="selectAllVisible(this.checked)" />
        全选（${words.length} 个）
      </label>
      <span style="color:var(--text-muted);font-size:13px;">已选 <strong>${selected.size}</strong> 个</span>
      <button class="btn btn-danger btn-sm" onclick="bulkDeleteSelected()" ${selected.size === 0 ? 'disabled' : ''}>
        🗑️ 删除所选
      </button>
    </div>` : '';

  return `${bulkBar}<div class="word-list">${items}</div>`;
}

function onWordSearch(value) {
  wordListState.search = value;
  refreshWordList();
}

function setWordFilter(filter) {
  wordListState.filter = filter;
  refreshWordList();
}

function refreshWordList() {
  const container = document.getElementById('word-list-container');
  if (container) {
    container.innerHTML = renderWordListItems(DB.getWords(), today());
  }
  // Update filter tab active states
  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.trim() === ({
      all: '全部', due: '待复习', learning: '学习中', mastered: '已掌握'
    })[wordListState.filter]);
  });
}

function toggleSelectMode() {
  wordListState.selectMode = !wordListState.selectMode;
  wordListState.selected = new Set();
  Router.navigate('wordlist');
}

function toggleWordSelection(id) {
  if (wordListState.selected.has(id)) {
    wordListState.selected.delete(id);
  } else {
    wordListState.selected.add(id);
  }
  refreshWordList();
}

function selectAllVisible(checked) {
  const todayStr = today();
  // Derive the same filtered word list
  let words = DB.getWords();
  if (wordListState.filter === 'due') words = words.filter(w => w.nextReview <= todayStr);
  else if (wordListState.filter === 'learning') words = words.filter(w => ['learning','new'].includes(getFamiliarity(w)));
  else if (wordListState.filter === 'mastered') words = words.filter(w => getFamiliarity(w) === 'mastered');
  if (wordListState.search.trim()) {
    const q = wordListState.search.toLowerCase();
    words = words.filter(w => w.word.toLowerCase().includes(q) || w.definition.toLowerCase().includes(q));
  }
  wordListState.selected = checked ? new Set(words.map(w => w.id)) : new Set();
  refreshWordList();
}

function bulkDeleteSelected() {
  const count = wordListState.selected.size;
  if (count === 0) return;
  if (!confirm(`确定要删除选中的 ${count} 个单词吗？此操作不可撤销。`)) return;
  const ids = wordListState.selected;
  const remaining = DB.getWords().filter(w => !ids.has(w.id));
  DB.saveWords(remaining);
  wordListState.selected = new Set();
  toast(`已删除 ${count} 个单词`, 'warning');
  refreshWordList();
}

function openAddWordModal() {
  showModal(`
    <h2 class="modal-title">➕ 添加单词</h2>
    <form onsubmit="submitAddWord(event)" autocomplete="off">
      <div class="form-group">
        <label class="form-label">单词 <span class="required">*</span></label>
        <input class="form-input" id="add-word" type="text" placeholder="e.g. ameliorate" required autofocus />
      </div>
      <div class="form-group">
        <label class="form-label">释义 <span class="required">*</span></label>
        <textarea class="form-textarea" id="add-def" placeholder="中文释义或英文释义..." rows="3" required></textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button type="submit" class="btn btn-primary">添加单词</button>
      </div>
    </form>
  `);
}

function submitAddWord(e) {
  e.preventDefault();
  const word = document.getElementById('add-word').value.trim();
  const definition = document.getElementById('add-def').value.trim();

  if (!word || !definition) {
    toast('单词和释义为必填项', 'error');
    return;
  }

  DB.addWord({ word, definition });
  closeModal();
  toast(`"${word}" 已成功添加！`);
  if (Router.current === 'wordlist') Router.navigate('wordlist');
}

function openEditWordModal(id) {
  const words = DB.getWords();
  const w = words.find(x => x.id === id);
  if (!w) return;
  const fam = getFamiliarity(w);

  showModal(`
    <h2 class="modal-title">✏️ 编辑单词</h2>
    <form onsubmit="submitEditWord(event, '${id}')" autocomplete="off">
      <div class="form-group">
        <label class="form-label">单词 <span class="required">*</span></label>
        <input class="form-input" id="edit-word" type="text" value="${escapeHtml(w.word)}" required />
      </div>
      <div class="form-group">
        <label class="form-label">释义 <span class="required">*</span></label>
        <textarea class="form-textarea" id="edit-def" rows="3" required>${escapeHtml(w.definition)}</textarea>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        📊 复习进度: <strong>${fam}</strong> | 间隔: ${w.interval}天 | 共复习: ${w.totalReviews}次 | 下次: ${formatDate(w.nextReview)}
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button type="submit" class="btn btn-primary">保存修改</button>
      </div>
    </form>
  `);
}

function submitEditWord(e, id) {
  e.preventDefault();
  const data = {
    word: document.getElementById('edit-word').value.trim(),
    definition: document.getElementById('edit-def').value.trim(),
  };
  if (!data.word || !data.definition) {
    toast('单词和释义为必填项', 'error');
    return;
  }
  DB.updateWord(id, data);
  closeModal();
  toast(`"${data.word}" 已更新！`);
  if (Router.current === 'wordlist') Router.navigate('wordlist');
}

function confirmDeleteWord(id, wordText) {
  if (confirm(`确定要删除单词 "${wordText}" 吗？此操作不可撤销。`)) {
    DB.deleteWord(id);
    toast(`"${wordText}" 已删除`, 'warning');
    if (Router.current === 'wordlist') Router.navigate('wordlist');
  }
}

function openImportModal() {
  showModal(`
    <h2 class="modal-title">📥 批量导入单词</h2>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px;">
      支持两种方式，第一列为单词，第二列为词性+释义：<br>
      • 从 Excel 直接复制粘贴（Tab 分隔）<br>
      • 上传 CSV 文件（逗号/分号分隔，支持 UTF-8 / GBK 编码）
    </p>

    <label id="import-dropzone" style="display:block;border:2px dashed var(--border);border-radius:var(--radius);padding:20px;text-align:center;cursor:pointer;margin-bottom:16px;transition:border-color .2s;"
      onmouseenter="this.style.borderColor='var(--primary)'"
      onmouseleave="this.style.borderColor='var(--border)'">
      <div style="font-size:28px;margin-bottom:6px;">📂</div>
      <div style="font-weight:600;font-size:14px;margin-bottom:4px;">点击上传 CSV / Excel 导出文件</div>
      <div id="import-file-name" style="font-size:12px;color:var(--text-muted);">支持 .csv 格式，UTF-8 / GBK 编码均可</div>
      <input type="file" id="import-file" accept=".csv,.txt" onchange="handleImportFile(this)" style="display:none" />
    </label>

    <div style="text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:12px;">── 或直接粘贴文本 ──</div>

    <div class="form-group">
      <textarea class="form-textarea" id="import-text" rows="5" placeholder="从 Excel 复制粘贴到此处（Tab / 逗号 / 分号分隔均可）..." oninput="previewImport(this.value)"></textarea>
    </div>
    <div id="import-preview"></div>
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()">取消</button>
      <button type="button" class="btn btn-primary" onclick="submitImport()">导入单词</button>
    </div>
  `);
}

// Parse a CSV/TSV text into an array of string arrays (rows × columns).
// Handles quoted fields, escaped double-quotes, and \r\n line endings.
function parseCSVRows(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;

  for (let i = 0; i <= text.length; i++) {
    const ch = i < text.length ? text[i] : '\n'; // sentinel flushes last row
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped ""
        else inQuote = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === delim) {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); field = '';
        if (row.some(f => f.trim())) rows.push(row);
        row = [];
      } else if (ch !== '\r') {
        field += ch;
      }
    }
  }
  return rows;
}

// Convert CSV text to Tab-separated text (2 columns), ready for the import textarea.
function csvToTsv(text) {
  // Auto-detect delimiter from the first line
  const firstLine = text.split('\n')[0] || '';
  let delim = '\t';
  if (!firstLine.includes('\t')) {
    const commaCount = (firstLine.match(/,/g) || []).length;
    const semicolonCount = (firstLine.match(/;/g) || []).length;
    delim = semicolonCount > commaCount ? ';' : ',';
  }

  return parseCSVRows(text, delim)
    .filter(row => row.length >= 2 && row[0].trim() && row[1].trim())
    .map(row => row[0].trim() + '\t' + row[1].trim())
    .join('\n');
}

function handleImportFile(input) {
  const file = input.files[0];
  if (!file) return;

  const nameEl = document.getElementById('import-file-name');
  if (nameEl) nameEl.textContent = file.name;

  const reader = new FileReader();
  reader.onload = function(e) {
    const buf = e.target.result;
    // Try UTF-8 first; fall back to GBK if replacement characters appear
    let text = new TextDecoder('utf-8').decode(buf);
    if ((text.match(/�/g) || []).length > 3) {
      text = new TextDecoder('gbk').decode(buf);
    }
    const tsv = csvToTsv(text);
    const ta = document.getElementById('import-text');
    if (ta) {
      ta.value = tsv;
      previewImport(tsv);
    }
  };
  reader.readAsArrayBuffer(file);
}

// Parse "adj. 释义" or "n. 释义" style strings into { partOfSpeech, definition }
function parsePosAndDef(raw) {
  const posMap = {
    n: 'noun', v: 'verb', vt: 'verb', vi: 'verb',
    adj: 'adj', adv: 'adv', prep: 'other', conj: 'other', pron: 'other',
  };
  const match = raw.match(/^([a-zA-Z]+)\.\s+([\s\S]+)$/);
  if (match) {
    const pos = posMap[match[1].toLowerCase()] || '';
    return { partOfSpeech: pos, definition: match[2].trim() };
  }
  return { partOfSpeech: '', definition: raw.trim() };
}

function previewImport(text) {
  const preview = document.getElementById('import-preview');
  if (!preview) return;
  const lines = text.split('\n').filter(l => l.trim());
  if (!lines.length) { preview.innerHTML = ''; return; }
  const rows = lines.slice(0, 5).map(line => {
    const parts = line.split('\t');
    if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) {
      return `<div class="import-row error"><span class="import-word">格式错误</span><span class="import-def">${escapeHtml(line)}</span></div>`;
    }
    const { definition } = parsePosAndDef(parts[1].trim());
    return `<div class="import-row"><span class="import-word">${escapeHtml(parts[0].trim())}</span><span class="import-def">${escapeHtml(parts[1].trim())}</span></div>`;
  }).join('');
  const more = lines.length > 5 ? `<div class="import-row"><span style="color:var(--text-muted)">...共 ${lines.length} 行</span></div>` : '';
  preview.innerHTML = `<div class="import-preview">${rows}${more}</div>`;
}

function submitImport() {
  const text = document.getElementById('import-text').value;
  const lines = text.split('\n').filter(l => l.trim());
  let count = 0;
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const word = parts[0].trim();
    const raw = parts[1].trim();
    if (!word || !raw) continue;
    DB.addWord({ word, definition: raw });
    count++;
  }
  closeModal();
  toast(`成功导入 ${count} 个单词！`);
  if (Router.current === 'wordlist') Router.navigate('wordlist');
}

/* ============================================================
   SECTION 6: REVIEW VIEW
   ============================================================ */

let reviewState = {
  queue: [],
  queueBreak: 0,
  planReviewCount: 0,
  planNewCount: 0,
  currentIdx: 0,
  isFlipped: false,
  sessionStats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 },
  passedWords: new Set(),   // unique words rated Good or Easy
};

function renderReview() {
  const plan = DB.getTodayPlan();

  if (plan.total === 0) {
    const newPool = plan.newPool - plan.usedToday;
    return `
      <div class="review-container">
        <div class="empty-state">
          <span class="empty-state-icon">🎉</span>
          <div class="empty-state-title">今日计划已完成！</div>
          <div class="empty-state-desc">
            ${newPool > 0
              ? `词库还有 <strong>${newPool}</strong> 个未学单词，明天继续或在设置中提高每日上限。`
              : '暂无待学单词，继续添加新词吧！'}
          </div>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="Router.navigate('wordlist')">📖 管理单词</button>
            <button class="btn btn-ghost" onclick="Router.navigate('dashboard')">🏠 返回首页</button>
          </div>
        </div>
      </div>`;
  }

  // Build queue: due reviews (shuffled) first, then new words (in creation order)
  if (reviewState.queue.length === 0 || reviewState.currentIdx >= reviewState.queue.length) {
    const reviews = shuffle(DB.getDueReviews());
    const newWords = DB.getNewWordsForToday();
    const queue = [...reviews, ...newWords];
    reviewState = {
      queue: queue.map(w => w.id),
      queueBreak: reviews.length,
      planReviewCount: reviews.length,
      planNewCount: newWords.length,
      currentIdx: 0,
      isFlipped: false,
      sessionStats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 },
      passedWords: new Set(),
    };
  }

  return renderReviewCard();
}

function renderReviewCard() {
  const { queue, currentIdx, isFlipped, sessionStats, planReviewCount, planNewCount, passedWords } = reviewState;
  const planTotal = planReviewCount + planNewCount;

  if (currentIdx >= queue.length) {
    return renderReviewSummary();
  }

  const wordId = queue[currentIdx];
  const words = DB.getWords();
  const card = words.find(w => w.id === wordId);

  if (!card) {
    reviewState.currentIdx++;
    return renderReviewCard();
  }

  const passed = passedWords.size;
  const progress = planTotal > 0 ? Math.min((passed / planTotal) * 100, 100) : 0;

  const frontHtml = `
    <div class="card-face card-face--front">
      <div class="card-word">${escapeHtml(card.word)}</div>
      <div class="card-hint">💭 点击卡片或按钮查看答案</div>
    </div>`;

  const backHtml = `
    <div class="card-face card-face--back">
      <div class="card-word" style="font-size:28px;">${escapeHtml(card.word)}</div>
      <div class="card-definition">${escapeHtml(card.definition)}</div>
    </div>`;

  const ratingButtons = `
    <div class="rating-buttons" id="rating-buttons">
      <button class="rating-btn btn-again" onclick="rateCard(0)">
        完全不会
        <span class="rating-quality">Again</span>
      </button>
      <button class="rating-btn btn-hard" onclick="rateCard(2)">
        有点难
        <span class="rating-quality">Hard</span>
      </button>
      <button class="rating-btn btn-good" onclick="rateCard(4)">
        记住了
        <span class="rating-quality">Good</span>
      </button>
      <button class="rating-btn btn-easy" onclick="rateCard(5)">
        非常熟悉
        <span class="rating-quality">Easy</span>
      </button>
    </div>`;

  return `
    <div class="review-container" id="review-container">
      <div class="review-header">
        <button class="btn btn-ghost btn-sm" onclick="exitReview()" title="退出复习">✕ 退出</button>
        <span style="font-size:12px;color:var(--text-muted);white-space:nowrap;">
          ✨新词 <strong>${planNewCount}</strong>
          &nbsp;·&nbsp;
          🔄复习 <strong>${planReviewCount}</strong>
          &nbsp;·&nbsp;
          共 <strong>${planTotal}</strong>
        </span>
        <div class="review-progress-bar" style="flex:1;">
          <div class="review-progress-fill" style="width:${progress}%"></div>
        </div>
        <span style="font-size:13px;color:var(--text-muted);white-space:nowrap;">
          已通过 <strong style="color:var(--success, #2E7D32);">${passed}</strong> / ${planTotal}
        </span>
      </div>

      <div class="card-scene" id="card-scene" onclick="flipCard()">
        <div class="flashcard ${isFlipped ? 'is-flipped' : ''}" id="flashcard">
          ${frontHtml}
          ${backHtml}
        </div>
      </div>

      ${!isFlipped
        ? `<button class="btn btn-primary btn-lg show-answer-btn" onclick="flipCard()">👁️ 我已想好，点击查看答案</button>`
        : ratingButtons
      }
    </div>`;
}

function flipCard() {
  reviewState.isFlipped = !reviewState.isFlipped;
  const container = document.getElementById('review-container');
  if (container) {
    container.innerHTML = renderReviewCard().replace(/<div class="review-container"[^>]*>/, '').replace(/<\/div>\s*$/, '');
    // Re-render fully
    document.getElementById('view-container').innerHTML = renderReviewCard();
  }
}

function rateCard(quality) {
  const { queue, currentIdx } = reviewState;
  const wordId = queue[currentIdx];
  const words = DB.getWords();
  const card = words.find(w => w.id === wordId);
  if (!card) {
    reviewState.currentIdx++;
    reRenderReview();
    return;
  }

  // Apply SM-2
  const updates = sm2Update(card, quality);
  DB.updateWord(wordId, updates);

  // Session tracking
  DB.addSessionReview(wordId, quality, card.word);
  recordActivityToday();

  // Update session stats
  const stats = reviewState.sessionStats;
  stats.total++;
  if (quality === 0) stats.again++;
  else if (quality === 2) stats.hard++;
  else if (quality === 4) stats.good++;
  else if (quality === 5) stats.easy++;

  if (quality >= 3) {
    // Good or Easy → word is passed
    reviewState.passedWords.add(wordId);
  } else {
    // Again or Hard → append to queue end, keep cycling
    reviewState.queue.push(wordId);
  }

  reviewState.currentIdx++;
  reviewState.isFlipped = false;
  reRenderReview();
}

function reRenderReview() {
  const container = document.getElementById('view-container');
  if (container) {
    container.innerHTML = renderReviewCard();
  }
}

function exitReview() {
  reviewState = {
    queue: [],
    queueBreak: 0,
    planReviewCount: 0,
    planNewCount: 0,
    currentIdx: 0,
    isFlipped: false,
    sessionStats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 },
    passedWords: new Set(),
  };
  Router.navigate('dashboard');
}

function renderReviewSummary() {
  const { planReviewCount, planNewCount, passedWords, sessionStats: stats } = reviewState;
  const planTotal = planReviewCount + planNewCount;
  const difficultWords = DB.getDifficultWords();

  return `
    <div class="review-container">
      <div class="review-summary">
        <span class="summary-icon">🎊</span>
        <div class="summary-title">今日任务完成！</div>
        <div class="summary-subtitle">
          本次学习了 <strong>${planNewCount}</strong> 个新词，复习了 <strong>${planReviewCount}</strong> 个单词
        </div>

        <div class="summary-stats">
          <div class="summary-stat good">
            <div class="summary-stat-num">${passedWords.size}</div>
            <div class="summary-stat-label">已通过</div>
          </div>
          <div class="summary-stat easy">
            <div class="summary-stat-num">${planTotal}</div>
            <div class="summary-stat-label">今日计划</div>
          </div>
          <div class="summary-stat hard">
            <div class="summary-stat-num">${stats.again + stats.hard}</div>
            <div class="summary-stat-label">重复次数</div>
          </div>
        </div>

        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
          ${difficultWords.length > 0
            ? `<button class="btn btn-warning btn-lg" onclick="goToStoryAndReset()">✍️ 生成难词短文 (${difficultWords.length}个)</button>`
            : ''}
          <button class="btn btn-ghost btn-lg" onclick="Router.navigate('dashboard')">🏠 返回首页</button>
        </div>
      </div>
    </div>`;
}

function goToStoryAndReset() {
  reviewState = { queue: [], queueBreak: 0, planReviewCount: 0, planNewCount: 0, currentIdx: 0, isFlipped: false, sessionStats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 }, passedWords: new Set() };
  Router.navigate('story');
}

function restartReview() {
  reviewState = { queue: [], queueBreak: 0, planReviewCount: 0, planNewCount: 0, currentIdx: 0, isFlipped: false, sessionStats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 }, passedWords: new Set() };
  Router.navigate('review');
}

/* ============================================================
   SECTION 7: STORY VIEW
   ============================================================ */

let storyState = { generated: false, loading: false };

function renderStory() {
  const difficultWords = DB.getDifficultWords();
  const settings       = DB.getSettings();
  const hasApiKey      = settings.apiKey && settings.apiKey.trim().length > 0;

  /* ---- NEW: AI 助记短文 block ---- */
  const { words: mnemonicWords, level: mnemonicLevel } = getDueTodayByLowestMastery();
  const levelZh = mnemonicLevel ? MASTERY_LABEL_ZH[mnemonicLevel] : '';

  const mnemonicSection = `
    <div class="card" style="margin-bottom:24px;">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>
          <div class="card-title" style="font-size:16px;font-weight:700;">🧠 生成 AI 助记短文</div>
          <div style="font-size:13px;color:var(--text-muted);margin-top:2px;">
            自动提取今日最不熟悉的单词，生成多样化 TOEFL 学术短文帮助记忆
          </div>
        </div>
      </div>

      ${mnemonicWords.length === 0 ? `
        <div class="empty-state" style="padding:24px 0;">
          <span class="empty-state-icon">📅</span>
          <div class="empty-state-title">今日暂无待复习单词</div>
          <div class="empty-state-desc">添加单词后即可使用此功能</div>
          <button class="btn btn-primary btn-sm" onclick="Router.navigate('wordlist')">📝 去添加单词</button>
        </div>
      ` : `
        <div style="margin:16px 0 4px;">
          <span style="font-size:13px;color:var(--text-muted);">
            📌 已选单词
            <span style="margin-left:4px;font-weight:600;color:var(--text);">${mnemonicWords.length} 个</span>
            <span class="badge badge-${mnemonicLevel}" style="margin-left:6px;">${levelZh}</span>
          </span>
        </div>
        <div class="word-chips" style="margin-bottom:16px;">
          ${mnemonicWords.map(w => `<span class="word-chip">${escapeHtml(w.word)}</span>`).join('')}
        </div>
        <button class="btn btn-primary" id="mnemonic-btn"
          onclick="generateMnemonicStory()" ${hasApiKey ? '' : 'disabled'}>
          🧠 生成 AI 助记短文
        </button>
        ${!hasApiKey
          ? `<span style="font-size:13px;color:var(--text-muted);margin-left:10px;vertical-align:middle;">请先设置 API Key</span>`
          : ''}
        <div id="mnemonic-area"></div>
      `}
    </div>

    <div class="divider-label">── 复习难词短文（基于今日复习记录）──</div>
  `;
  /* ---- end NEW block ---- */

  const apiSetupHtml = !hasApiKey ? `
    <div class="setup-card">
      <div class="setup-card-title">🔑 需要 Claude API Key</div>
      <div class="setup-card-desc">
        生成短文功能需要 Anthropic Claude API Key。<br>
        请前往 <a href="https://console.anthropic.com" target="_blank" style="color:var(--primary);">console.anthropic.com</a> 获取。
      </div>
      <div class="input-with-btn">
        <input class="form-input" type="password" id="quick-api-key" placeholder="sk-ant-..." />
        <button class="btn btn-primary" onclick="saveQuickApiKey()">保存</button>
      </div>
    </div>` : '';

  const noWordsMsg = difficultWords.length === 0 ? `
    <div class="empty-state">
      <span class="empty-state-icon">📝</span>
      <div class="empty-state-title">今天还没有难词！</div>
      <div class="empty-state-desc">继续复习，标记难词后即可生成个性化复习短文</div>
      <button class="btn btn-primary" onclick="Router.navigate('review')">🔄 去复习</button>
    </div>` : '';

  const chipsHtml = difficultWords.length > 0 ? `
    <div class="section-header">
      <span class="section-title">📌 今天的难词 (${difficultWords.length}个)</span>
    </div>
    <div class="word-chips">
      ${difficultWords.map(w => `<span class="word-chip">${escapeHtml(w)}</span>`).join('')}
    </div>` : '';

  const canGenerate = hasApiKey && difficultWords.length > 0;

  return `
    <div class="view-header">
      <div>
        <h1 class="view-title">短文生成</h1>
        <p class="view-subtitle">AI 生成 TOEFL 学术短文，强化记忆效果</p>
      </div>
    </div>

    ${mnemonicSection}

    ${apiSetupHtml}
    ${chipsHtml || noWordsMsg}

    ${difficultWords.length > 0 ? `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;">
      <button class="btn btn-primary btn-lg" id="generate-btn" onclick="generateStory()" ${canGenerate ? '' : 'disabled'}>
        ✨ 生成短文
      </button>
      ${!hasApiKey ? `<span style="font-size:13px;color:var(--text-muted);align-self:center;">请先设置 API Key</span>` : ''}
    </div>
    <div id="story-area"></div>
    ` : ''}
  `;
}

function saveQuickApiKey() {
  const input = document.getElementById('quick-api-key');
  if (!input) return;
  const key = input.value.trim();
  if (!key) { toast('请输入有效的 API Key', 'error'); return; }
  const settings = DB.getSettings();
  settings.apiKey = key;
  DB.saveSettings(settings);
  toast('API Key 已保存！');
  Router.navigate('story');
}

async function callClaudeAPI(apiKey, words, topic) {
  const topicInstruction = topic
    ? `The passage topic must be: ${topic}. `
    : 'Choose a diverse academic topic typical of TOEFL reading passages (e.g. biology, history, psychology, economics, geology, art). ';
  const prompt =
    `Write a 180-220 word academic passage at TOEFL reading level. ` +
    topicInstruction +
    `The passage must naturally incorporate ALL of the following vocabulary words: ${words.join(', ')}. ` +
    `Requirements:\n` +
    `- Formal, academic prose with a clear topic sentence and logical flow\n` +
    `- Every target word must appear in context that hints at its meaning\n` +
    `- Bold each target word with **word** markdown syntax (every occurrence)\n` +
    `- No title, heading, or commentary — output the passage only`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data.content[0].text;
}

async function generateStory() {
  const difficultWords = DB.getDifficultWords();
  const settings = DB.getSettings();

  if (!settings.apiKey) { toast('请先设置 API Key', 'error'); return; }
  if (!difficultWords.length) { toast('没有难词可用', 'warning'); return; }

  const btn = document.getElementById('generate-btn');
  const area = document.getElementById('story-area');

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;margin-right:8px;vertical-align:middle;"></span> 生成中...';
  }
  if (area) {
    area.innerHTML = `
      <div class="story-loading">
        <div class="loading-spinner"></div>
        <span>Claude 正在创作短文，请稍候...</span>
      </div>`;
  }

  try {
    const story = await callClaudeAPI(settings.apiKey, difficultWords, '');
    if (area) {
      area.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:20px;margin-bottom:8px;">
          <span class="section-title">📄 生成的短文</span>
          <button class="btn btn-ghost btn-sm" onclick="generateStory()">🔄 重新生成</button>
        </div>
        <div class="story-output">${renderMarkdown(story)}</div>`;
    }
    toast('短文生成成功！');
  } catch (err) {
    if (area) {
      area.innerHTML = `
        <div style="background:var(--danger-light);border:1px solid #FFCDD2;border-radius:var(--radius);padding:16px;margin-top:16px;color:var(--danger);font-size:14px;">
          ❌ 生成失败：${escapeHtml(err.message)}
        </div>`;
    }
    toast(`生成失败：${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '✨ 重新生成';
    }
  }
}

/* ------------------------------------------------------------
   generateMnemonicStory
   Extracts the lowest-mastery due-today words, picks a random
   TOEFL topic, and asks Claude to write a mnemonic passage.
   ------------------------------------------------------------ */
async function generateMnemonicStory() {
  const { words, level } = getDueTodayByLowestMastery();
  const settings = DB.getSettings();
  const btn  = document.getElementById('mnemonic-btn');
  const area = document.getElementById('mnemonic-area');

  if (!settings.apiKey) { toast('请先设置 API Key', 'error'); return; }
  if (!words.length)    { toast('今日暂无待复习单词', 'warning'); return; }

  // Loading state
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner" style="width:16px;height:16px;'
      + 'border-width:2px;display:inline-block;margin-right:8px;vertical-align:middle;"></span>生成中…';
  }
  if (area) {
    area.innerHTML = `
      <div class="story-loading">
        <div class="loading-spinner"></div>
        <span>Claude 正在创作助记短文，请稍候…</span>
      </div>`;
  }

  const topic     = pickRandomTopic();
  const wordTexts = words.map(w => w.word);

  try {
    const story = await callClaudeAPI(settings.apiKey, wordTexts, topic.en);

    if (area) {
      area.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;
                    margin:20px 0 8px;flex-wrap:wrap;gap:8px;">
          <span class="section-title">
            📄 助记短文
            <span style="font-size:12px;font-weight:500;color:var(--text-muted);
                         background:var(--bg);padding:2px 8px;border-radius:20px;margin-left:6px;">
              ${topic.zh}
            </span>
          </span>
          <button class="btn btn-ghost btn-sm" onclick="generateMnemonicStory()">🔄 换个话题</button>
        </div>
        <div class="story-output">${renderMarkdown(story)}</div>`;
    }
    toast('助记短文生成成功！');
  } catch (err) {
    if (area) {
      area.innerHTML = `
        <div style="background:#FFF5F5;border:1px solid #FFCDD2;border-radius:var(--radius);
                    padding:16px;margin-top:16px;color:var(--danger);font-size:14px;">
          ❌ 生成失败：${escapeHtml(err.message)}
        </div>`;
    }
    toast(`生成失败：${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🧠 生成 AI 助记短文';
    }
  }
}

/* ============================================================
   SECTION 8: SETTINGS VIEW
   ============================================================ */

function renderSettings() {
  const settings = DB.getSettings();
  const words = DB.getWords();

  return `
    <div class="view-header">
      <div>
        <h1 class="view-title">设置</h1>
        <p class="view-subtitle">管理应用设置和数据</p>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">🔑 Claude API 配置</div>
      <div class="settings-item">
        <div class="settings-item-info">
          <div class="settings-item-label">API Key</div>
          <div class="settings-item-desc">用于生成短文功能。从 console.anthropic.com 获取</div>
        </div>
        <div class="settings-item-control">
          <div class="password-wrap">
            <input class="form-input" type="password" id="settings-api-key" value="${escapeHtml(settings.apiKey || '')}" placeholder="sk-ant-..." />
            <button class="password-toggle" onclick="togglePasswordVisibility('settings-api-key', this)" title="显示/隐藏">👁️</button>
          </div>
          <button class="btn btn-primary btn-sm mt-2" onclick="saveApiKey()">保存</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">📖 学习设置</div>
      <div class="settings-item">
        <div class="settings-item-info">
          <div class="settings-item-label">每日新词上限</div>
          <div class="settings-item-desc">每天最多引入的新单词数量</div>
        </div>
        <div class="settings-item-control">
          <input class="form-input" type="number" id="settings-daily-limit" value="${settings.dailyNewLimit || 20}" min="1" max="100" style="width:100px;" />
          <button class="btn btn-primary btn-sm mt-2" onclick="saveDailyLimit()">保存</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">📊 数据统计</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:4px;">
        <div style="text-align:center;padding:16px;background:var(--bg);border-radius:var(--radius);">
          <div style="font-size:24px;font-weight:800;">${words.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">总单词数</div>
        </div>
        <div style="text-align:center;padding:16px;background:var(--bg);border-radius:var(--radius);">
          <div style="font-size:24px;font-weight:800;">${words.filter(w => getFamiliarity(w) === 'mastered').length}</div>
          <div style="font-size:12px;color:var(--text-muted)">已掌握</div>
        </div>
        <div style="text-align:center;padding:16px;background:var(--bg);border-radius:var(--radius);">
          <div style="font-size:24px;font-weight:800;">${DB.getTodayReviewCount()}</div>
          <div style="font-size:12px;color:var(--text-muted)">今日复习</div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">⚠️ 危险操作</div>
      <div class="settings-item">
        <div class="settings-item-info">
          <div class="settings-item-label">清除所有数据</div>
          <div class="settings-item-desc">删除所有单词、进度和设置。此操作不可撤销！</div>
        </div>
        <div class="settings-item-control">
          <button class="btn btn-danger" onclick="clearAllData()">🗑️ 清除数据</button>
        </div>
      </div>
    </div>

    <div style="text-align:center;color:var(--text-muted);font-size:12px;padding:20px 0;">
      TOEFL Vocabulary Study App v1.0.0 · Powered by Claude AI
    </div>
  `;
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
  } else {
    input.type = 'password';
    btn.textContent = '👁️';
  }
}

function saveApiKey() {
  const input = document.getElementById('settings-api-key');
  if (!input) return;
  const settings = DB.getSettings();
  settings.apiKey = input.value.trim();
  DB.saveSettings(settings);
  toast('API Key 已保存！');
}

function saveDailyLimit() {
  const input = document.getElementById('settings-daily-limit');
  if (!input) return;
  const val = parseInt(input.value, 10);
  if (isNaN(val) || val < 1) { toast('请输入有效数值', 'error'); return; }
  const settings = DB.getSettings();
  settings.dailyNewLimit = val;
  DB.saveSettings(settings);
  toast('设置已保存！');
}

function clearAllData() {
  if (!confirm('确定要清除所有数据吗？\n\n这将删除所有单词、进度和设置，且无法恢复！')) return;
  if (!confirm('再次确认：真的要清除所有数据吗？')) return;
  localStorage.removeItem(KEYS.WORDS);
  localStorage.removeItem(KEYS.SETTINGS);
  localStorage.removeItem(KEYS.SESSION);
  localStorage.removeItem('toefl_activity');
  toast('所有数据已清除', 'warning');
  location.reload();
}

/* ============================================================
   SECTION 9: ROUTER
   ============================================================ */

const Router = {
  current: null,

  views: {
    dashboard: renderDashboard,
    wordlist: renderWordList,
    review: renderReview,
    story: renderStory,
    settings: renderSettings,
  },

  navigate(viewName) {
    const render = this.views[viewName];
    if (!render) {
      console.warn(`Unknown view: ${viewName}`);
      return;
    }

    this.current = viewName;

    // Update active nav button
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // Render view
    const container = document.getElementById('view-container');
    if (container) {
      container.innerHTML = render();
      // Scroll to top
      const main = document.getElementById('main-content');
      if (main) main.scrollTop = 0;
    }
  },
};

/* ============================================================
   SECTION 10: SEED DATA & INIT
   ============================================================ */

function seedDataIfEmpty() {
  // No pre-loaded words — user adds their own vocabulary.
}

function updateSidebarStreak() {
  const streakEl = document.getElementById('sidebar-streak');
  if (!streakEl) return;
  const log = getActivityLog();
  const todayStr = today();
  let streak = 0;
  let d = todayStr;
  while (true) {
    if (log[d] && log[d] > 0) {
      streak++;
      d = addDays(d, -1);
    } else if (d === todayStr && DB.getTodayReviewCount() > 0) {
      streak++;
      d = addDays(d, -1);
    } else {
      break;
    }
  }
  if (streak > 0) {
    streakEl.textContent = `🔥 连续学习 ${streak} 天`;
  } else {
    streakEl.textContent = '💪 今天开始学习吧';
  }
}

function init() {
  // Seed data if empty
  seedDataIfEmpty();

  // Wire up sidebar nav buttons
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view) Router.navigate(view);
    });
  });

  // Update sidebar streak badge
  updateSidebarStreak();

  // Navigate to dashboard
  Router.navigate('dashboard');

  // Close modal on overlay click
  const overlay = document.getElementById('modal-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();

    // Review shortcuts
    if (Router.current === 'review') {
      const cardScene = document.getElementById('card-scene');
      if (cardScene) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          if (!reviewState.isFlipped) {
            flipCard();
          }
        }
        if (reviewState.isFlipped) {
          if (e.key === '1') rateCard(0);
          else if (e.key === '2') rateCard(2);
          else if (e.key === '3') rateCard(4);
          else if (e.key === '4') rateCard(5);
        }
      }
    }
  });

  console.log('[TOEFL App] Initialized successfully.');
}

// Start the app
document.addEventListener('DOMContentLoaded', init);
