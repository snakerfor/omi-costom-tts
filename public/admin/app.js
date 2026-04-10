(function () {
  const state = {
    identityOptions: [],
    speakers: [],
    speakerPagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    selectedSpeakerId: null,
    conversations: [],
    conversationPagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    selectedConversationId: null,
  };

  function qs(selector) {
    return document.querySelector(selector);
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlightText(value, keyword) {
    const safe = escapeHtml(value || '');
    const normalized = String(keyword || '').trim();
    if (!normalized) return safe;
    const pattern = new RegExp(`(${escapeRegex(normalized)})`, 'gi');
    return safe.replace(pattern, '<mark class="highlight">$1</mark>');
  }

  function speakerDisplayName(item) {
    return item.name || item.display_label || item.id;
  }

  function speakerBadges(item) {
    const badges = [];
    badges.push(item.name_confirmed ? '<span class="badge">姓名已确认</span>' : '<span class="badge warning">姓名未确认</span>');
    badges.push(item.identity_confirmed ? '<span class="badge">身份已确认</span>' : '<span class="badge danger">身份未确认</span>');
    return badges.join('');
  }

  async function apiGet(url) {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }

  async function apiSend(url, method, body) {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }

  function setIdentityOptions(options) {
    state.identityOptions = Array.isArray(options) ? options : [];
    const speakerSelect = qs('#speaker-form-identity');
    const conversationSelect = qs('#conv-identity-label');
    speakerSelect.innerHTML = '<option value="">未确认</option>' + state.identityOptions.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
    conversationSelect.innerHTML = '<option value="">全部身份</option>' + state.identityOptions.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
  }

  async function loadIdentityOptions() {
    const result = await apiGet('/api/meta/identity-options');
    setIdentityOptions(result.data);
  }

  function renderStats(stats) {
    qs('#stat-unconfirmed-name').textContent = stats.unconfirmedName;
    qs('#stat-unconfirmed-identity').textContent = stats.unconfirmedIdentity;
    qs('#stat-unconfirmed-any').textContent = stats.unconfirmedAny;
  }

  function renderSpeakerPagination() {
    qs('#speaker-list-count').textContent = `共 ${state.speakerPagination.total} 条`;
    qs('#speaker-pagination').textContent = `第 ${state.speakerPagination.page} / ${state.speakerPagination.totalPages} 页`;
    qs('#speaker-prev-page').disabled = state.speakerPagination.page <= 1;
    qs('#speaker-next-page').disabled = state.speakerPagination.page >= state.speakerPagination.totalPages;
  }

  function renderConversationPagination() {
    qs('#conversation-list-count').textContent = `共 ${state.conversationPagination.total} 条`;
    qs('#conversation-pagination').textContent = `第 ${state.conversationPagination.page} / ${state.conversationPagination.totalPages} 页`;
    qs('#conv-prev-page').disabled = state.conversationPagination.page <= 1;
    qs('#conv-next-page').disabled = state.conversationPagination.page >= state.conversationPagination.totalPages;
  }

  function renderSpeakerList() {
    const keyword = qs('#speaker-q').value.trim();
    const listEl = qs('#speaker-list');
    renderSpeakerPagination();
    listEl.innerHTML = state.speakers.map((item) => `
      <article class="list-item ${item.id === state.selectedSpeakerId ? 'active' : ''}" data-speaker-id="${item.id}">
        <div class="list-item-title">
          <span>${highlightText(speakerDisplayName(item), keyword)}</span>
          <span class="subtle">${escapeHtml(formatDate(item.last_seen_at || item.created_at))}</span>
        </div>
        <div class="badge-row">${speakerBadges(item)}</div>
        <p class="subtle">${highlightText(item.identity_label || '身份未确认', keyword)}</p>
        <p>${highlightText((item.sample_text || '').slice(0, 80) || '暂无样本文本', keyword)}</p>
      </article>
    `).join('') || '<p class="subtle">没有匹配的发言人。</p>';

    listEl.querySelectorAll('[data-speaker-id]').forEach((node) => {
      node.addEventListener('click', () => {
        state.selectedSpeakerId = node.getAttribute('data-speaker-id');
        renderSpeakerList();
        loadSpeakerDetail(state.selectedSpeakerId).catch(showError);
      });
    });
  }

  function resetSpeakerDetail() {
    qs('#speaker-empty').classList.remove('hidden');
    qs('#speaker-detail').classList.add('hidden');
  }

  async function loadSpeakers(resetPage) {
    if (resetPage) state.speakerPagination.page = 1;
    const params = new URLSearchParams();
    const q = qs('#speaker-q').value.trim();
    const confirmation = qs('#speaker-confirmation').value;
    const start = qs('#speaker-start').value;
    const end = qs('#speaker-end').value;
    const pageSize = Number(qs('#speaker-page-size').value || '20');

    if (q) params.set('q', q);
    if (confirmation) params.set('confirmation', confirmation);
    if (start) params.set('start_time', new Date(start).toISOString());
    if (end) params.set('end_time', new Date(end).toISOString());
    params.set('page', String(state.speakerPagination.page));
    params.set('page_size', String(pageSize));

    const result = await apiGet(`/api/speakers?${params.toString()}`);
    state.speakers = result.data;
    state.speakerPagination = result.pagination;
    renderStats(result.stats);
    renderSpeakerList();

    const stillExists = state.speakers.some((item) => item.id === state.selectedSpeakerId);
    if (stillExists) {
      await loadSpeakerDetail(state.selectedSpeakerId);
      return;
    }
    if (state.speakers[0]) {
      state.selectedSpeakerId = state.speakers[0].id;
      renderSpeakerList();
      await loadSpeakerDetail(state.selectedSpeakerId);
      return;
    }
    state.selectedSpeakerId = null;
    resetSpeakerDetail();
  }

  function renderSpeakerDetail(detail) {
    qs('#speaker-empty').classList.add('hidden');
    qs('#speaker-detail').classList.remove('hidden');
    qs('#speaker-detail-title').textContent = speakerDisplayName(detail.speaker);
    qs('#speaker-detail-badges').innerHTML = speakerBadges(detail.speaker);
    qs('#speaker-id').textContent = detail.speaker.id;
    qs('#speaker-first-seen').textContent = formatDate(detail.speaker.first_seen_at);
    qs('#speaker-last-seen').textContent = formatDate(detail.speaker.last_seen_at);
    qs('#speaker-conv-count').textContent = detail.speaker.conversation_count;
    qs('#speaker-seg-count').textContent = detail.speaker.segment_count;
    qs('#speaker-form-name').value = detail.speaker.name || '';
    qs('#speaker-form-identity').value = detail.speaker.identity_label || '';
    qs('#speaker-form-notes').value = detail.speaker.notes || '';

    const audio = qs('#speaker-audio');
    const audioEmpty = qs('#speaker-audio-empty');
    if (detail.speaker.sample_audio_url) {
      audio.src = detail.speaker.sample_audio_url;
      audio.classList.remove('hidden');
      audioEmpty.classList.add('hidden');
    } else {
      audio.removeAttribute('src');
      audio.classList.add('hidden');
      audioEmpty.classList.remove('hidden');
    }

    qs('#speaker-representative-segments').innerHTML = detail.representativeSegments.length
      ? detail.representativeSegments.map((segment) => `
        <article class="segment-item">
          <div class="segment-title">
            <span>${escapeHtml(formatDate(segment.absolute_start_time))}</span>
            <span class="subtle">${escapeHtml(segment.conversation_id)}</span>
          </div>
          <p>${escapeHtml(segment.text)}</p>
        </article>
      `).join('')
      : '<p class="subtle">暂无代表性片段。</p>';

    qs('#speaker-recent-conversations').innerHTML = detail.recentConversations.length
      ? detail.recentConversations.map((conversation) => `
        <article class="segment-item">
          <div class="segment-title">
            <span>${escapeHtml(formatDate(conversation.started_at))}</span>
            <span class="subtle">${escapeHtml(conversation.status)}</span>
          </div>
          <p class="subtle">会话 ${escapeHtml(conversation.conversation_id)}，片段 ${conversation.segment_count}</p>
          <button class="inline-action secondary-button" data-open-conversation="${conversation.conversation_id}">查看对话记录</button>
        </article>
      `).join('')
      : '<p class="subtle">暂无最近会话。</p>';

    qs('#speaker-recent-conversations').querySelectorAll('[data-open-conversation]').forEach((node) => {
      node.addEventListener('click', () => {
        switchTab('conversations');
        state.selectedConversationId = node.getAttribute('data-open-conversation');
        loadConversations(false).catch(showError);
      });
    });
  }

  async function loadSpeakerDetail(speakerId) {
    if (!speakerId) return;
    const result = await apiGet(`/api/speakers/${speakerId}`);
    renderSpeakerDetail(result.data);
  }

  function renderConversationList() {
    const keyword = qs('#conv-keyword').value.trim();
    const listEl = qs('#conversation-list');
    renderConversationPagination();
    listEl.innerHTML = state.conversations.map((item) => `
      <article class="list-item ${item.id === state.selectedConversationId ? 'active' : ''}" data-conversation-id="${item.id}">
        <div class="list-item-title">
          <span>${escapeHtml(formatDate(item.started_at))}</span>
          <span class="subtle">${escapeHtml(item.status)}</span>
        </div>
        <div class="badge-row">
          <span class="badge">发言人 ${item.speaker_count}</span>
          <span class="badge ${item.unconfirmed_speaker_count ? 'warning' : ''}">待确认 ${item.unconfirmed_speaker_count}</span>
          <span class="badge">片段 ${item.segment_count}</span>
        </div>
        <p>${highlightText(item.summary_text || '暂无摘要', keyword)}</p>
      </article>
    `).join('') || '<p class="subtle">没有匹配的会话。</p>';

    listEl.querySelectorAll('[data-conversation-id]').forEach((node) => {
      node.addEventListener('click', () => {
        state.selectedConversationId = node.getAttribute('data-conversation-id');
        renderConversationList();
        loadConversationDetail(state.selectedConversationId).catch(showError);
      });
    });
  }

  function resetConversationDetail() {
    qs('#conversation-empty').classList.remove('hidden');
    qs('#conversation-detail').classList.add('hidden');
  }

  async function loadConversations(resetPage) {
    if (resetPage) state.conversationPagination.page = 1;
    const params = new URLSearchParams();
    const speakerName = qs('#conv-speaker-name').value.trim();
    const identityLabel = qs('#conv-identity-label').value;
    const keyword = qs('#conv-keyword').value.trim();
    const status = qs('#conv-status').value;
    const unconfirmed = qs('#conv-unconfirmed').value;
    const start = qs('#conv-start').value;
    const end = qs('#conv-end').value;
    const pageSize = Number(qs('#conv-page-size').value || '20');

    if (speakerName) params.set('speaker_name', speakerName);
    if (identityLabel) params.set('identity_label', identityLabel);
    if (keyword) params.set('keyword', keyword);
    if (status) params.set('status', status);
    if (unconfirmed) params.set('has_unconfirmed_speakers', unconfirmed);
    if (start) params.set('start_time', new Date(start).toISOString());
    if (end) params.set('end_time', new Date(end).toISOString());
    params.set('page', String(state.conversationPagination.page));
    params.set('page_size', String(pageSize));

    const result = await apiGet(`/api/conversations?${params.toString()}`);
    if (!state.identityOptions.length && result.identityOptions) {
      setIdentityOptions(result.identityOptions);
    }
    state.conversations = result.data;
    state.conversationPagination = result.pagination;
    renderConversationList();

    const stillExists = state.conversations.some((item) => item.id === state.selectedConversationId);
    if (stillExists) {
      await loadConversationDetail(state.selectedConversationId);
      return;
    }
    if (state.conversations[0]) {
      state.selectedConversationId = state.conversations[0].id;
      renderConversationList();
      await loadConversationDetail(state.selectedConversationId);
      return;
    }
    state.selectedConversationId = null;
    resetConversationDetail();
  }

  function renderConversationDetail(detail) {
    const keyword = qs('#conv-keyword').value.trim();
    qs('#conversation-empty').classList.add('hidden');
    qs('#conversation-detail').classList.remove('hidden');
    qs('#conversation-title').textContent = detail.conversation.id;
    qs('#conversation-session-id').textContent = detail.conversation.session_id;
    qs('#conversation-status').textContent = detail.conversation.status;
    qs('#conversation-started-at').textContent = formatDate(detail.conversation.started_at);
    qs('#conversation-ended-at').textContent = formatDate(detail.conversation.ended_at);
    qs('#conversation-speaker-count').textContent = detail.conversation.speaker_count;
    qs('#conversation-segment-count').textContent = detail.conversation.segment_count;

    const audioLink = qs('#conversation-audio-link');
    if (detail.conversation.audio_file_url) {
      audioLink.href = detail.conversation.audio_file_url;
      audioLink.classList.remove('hidden');
    } else {
      audioLink.classList.add('hidden');
      audioLink.removeAttribute('href');
    }

    qs('#conversation-speakers').innerHTML = detail.speakers.length
      ? detail.speakers.map((speaker) => `
        <article class="segment-item">
          <div class="segment-title">
            <span>${escapeHtml(speaker.display_name)}</span>
            <span class="subtle">${escapeHtml(speaker.identity_label || '身份未确认')}</span>
          </div>
          <p class="subtle">片段 ${speaker.segment_count}，总时长 ${(speaker.total_duration_ms / 1000).toFixed(1)}s</p>
        </article>
      `).join('')
      : '<p class="subtle">暂无参与者信息。</p>';

    qs('#conversation-segments').innerHTML = detail.segments.length
      ? detail.segments.map((segment) => {
        const needsConfirmation = !segment.speaker_name || !segment.speaker_identity;
        return `
          <article class="segment-item">
            <div class="segment-title">
              <span>${escapeHtml(segment.display_name)}</span>
              <span class="subtle">${escapeHtml(formatDate(segment.absolute_start_time))}</span>
            </div>
            <div class="badge-row">
              <span class="badge ${segment.speaker_identity ? '' : 'danger'}">${escapeHtml(segment.speaker_identity || '身份未确认')}</span>
              ${needsConfirmation && segment.speaker_id ? `<button class="inline-action secondary-button" data-go-speaker="${segment.speaker_id}">去确认</button>` : ''}
            </div>
            <p>${highlightText(segment.text, keyword)}</p>
          </article>
        `;
      }).join('')
      : '<p class="subtle">暂无 transcript。</p>';

    qs('#conversation-segments').querySelectorAll('[data-go-speaker]').forEach((node) => {
      node.addEventListener('click', () => {
        switchTab('speakers');
        state.selectedSpeakerId = node.getAttribute('data-go-speaker');
        loadSpeakers(false).catch(showError);
      });
    });
  }

  async function loadConversationDetail(conversationId) {
    if (!conversationId) return;
    const result = await apiGet(`/api/conversations/${conversationId}`);
    renderConversationDetail(result.data);
  }

  function switchTab(tabName) {
    document.querySelectorAll('.tab-button').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
  }

  function showError(err) {
    window.alert(err.message || String(err));
  }

  function bindEvents() {
    document.querySelectorAll('.tab-button').forEach((button) => {
      button.addEventListener('click', () => switchTab(button.getAttribute('data-tab')));
    });

    qs('#speaker-search').addEventListener('click', () => loadSpeakers(true).catch(showError));
    qs('#conv-search').addEventListener('click', () => loadConversations(true).catch(showError));
    qs('#speaker-page-size').addEventListener('change', () => loadSpeakers(true).catch(showError));
    qs('#conv-page-size').addEventListener('change', () => loadConversations(true).catch(showError));

    qs('#speaker-prev-page').addEventListener('click', () => {
      if (state.speakerPagination.page <= 1) return;
      state.speakerPagination.page -= 1;
      loadSpeakers(false).catch(showError);
    });
    qs('#speaker-next-page').addEventListener('click', () => {
      if (state.speakerPagination.page >= state.speakerPagination.totalPages) return;
      state.speakerPagination.page += 1;
      loadSpeakers(false).catch(showError);
    });
    qs('#conv-prev-page').addEventListener('click', () => {
      if (state.conversationPagination.page <= 1) return;
      state.conversationPagination.page -= 1;
      loadConversations(false).catch(showError);
    });
    qs('#conv-next-page').addEventListener('click', () => {
      if (state.conversationPagination.page >= state.conversationPagination.totalPages) return;
      state.conversationPagination.page += 1;
      loadConversations(false).catch(showError);
    });

    qs('#speaker-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!state.selectedSpeakerId) return;
      await apiSend(`/api/speakers/${state.selectedSpeakerId}`, 'PATCH', {
        name: qs('#speaker-form-name').value,
        identityLabel: qs('#speaker-form-identity').value || null,
        notes: qs('#speaker-form-notes').value,
      });
      await loadSpeakers(false);
      await loadSpeakerDetail(state.selectedSpeakerId);
      await loadConversations(false);
    });
  }

  bindEvents();
  Promise.all([loadIdentityOptions(), loadSpeakers(true), loadConversations(true)]).catch(showError);
})();
