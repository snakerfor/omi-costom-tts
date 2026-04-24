(function () {
  const state = {
    activeTab: 'conversations',
    identityOptions: [],
    memoryStatus: null,
    speakers: [],
    speakerPagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    selectedSpeakerId: null,
    confirmedSpeakerOptions: [],
    conversations: [],
    conversationPagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    selectedConversationId: null,
    selectedConversationDetail: null,
    selectedConversationSpeakerFilter: null,
    selectedSegmentIds: new Set(),
    speakerModalOpen: false,
  };
  let conversationPlaybackStopTimer = null;

  function qs(selector) {
    return document.querySelector(selector);
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function formatSegmentSeconds(value) {
    return `${(Math.max(0, Number(value || 0)) / 1000).toFixed(1)}s`;
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

  function voiceprintDecisionLabel(value) {
    const labels = {
      xfyun_low_confidence: '低置信',
      xfyun_conflict: '冲突',
      xfyun_no_match: '未命中',
      xfyun_error: '识别错误',
      xfyun_skipped_short: '太短跳过',
      xfyun_segment_hit: '自动命中',
      xfyun_current_conversation_backfill_hit: '回刷命中',
      human_segment_confirmed: '人工确认',
      human_segment_excluded: '已排除',
      soniox_finalized: '待确认',
      candidate_pending: '待确认',
      deferred_unresolved: '待确认',
      label_fallback: '待确认',
      neighbor_bridge: '待确认',
      manual_identity_confirm: '人工确认',
      manual_confirm: '人工确认',
      pending: '待扫描',
    };
    return labels[value] || value || '待确认';
  }

  function voiceprintDecisionClass(value) {
    if (value === 'xfyun_error') return 'danger';
    if (value === 'xfyun_low_confidence' || value === 'xfyun_conflict') return 'warning';
    return '';
  }

  function speakerDisplayName(item) {
    return item.name || item.display_label || item.id;
  }

  function speakerBadges(item) {
    return [
      item.name_confirmed ? '<span class="badge">姓名已确认</span>' : '<span class="badge warning">姓名未确认</span>',
      item.identity_confirmed ? '<span class="badge">身份已确认</span>' : '<span class="badge danger">身份未确认</span>',
    ].join('');
  }

  function conversationDisplaySpeaker(segment) {
    return segment.speaker_name || segment.display_name || segment.speaker_label || '未知发言人';
  }

  function getFilteredConversationSegments(detail = state.selectedConversationDetail) {
    const rows = detail?.segments || [];
    if (!state.selectedConversationSpeakerFilter) {
      return rows;
    }
    return rows.filter((segment) => {
      const label = segment.original_speaker_label || segment.speaker_label || null;
      return label === state.selectedConversationSpeakerFilter;
    });
  }

  function getSelectedConversationSegments(detail = state.selectedConversationDetail) {
    return (detail?.segments || []).filter((segment) => state.selectedSegmentIds.has(segment.id));
  }

  function openSpeakerModal() {
    if (!state.selectedSegmentIds.size) {
      throw new Error('请先勾选至少一个片段');
    }
    state.speakerModalOpen = true;
    qs('#speaker-modal').classList.remove('hidden');
    renderSpeakerModal();
  }

  function closeSpeakerModal() {
    state.speakerModalOpen = false;
    qs('#speaker-modal').classList.add('hidden');
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
    let data;
    try {
      data = await response.json();
    } catch (err) {
      const text = await response.text().catch(() => 'unknown');
      console.error('[DEBUG] apiSend JSON parse error:', err, 'response text:', text);
      throw new Error(`响应解析失败: ${text.slice(0, 200)}`);
    }
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `请求失败 (${response.status})`);
    }
    return data;
  }

  function setIdentityOptions(options) {
    state.identityOptions = Array.isArray(options) ? options : [];
    const html = state.identityOptions.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
    qs('#speaker-form-identity').innerHTML = `<option value="">未确认</option>${html}`;
    qs('#conv-identity-label').innerHTML = `<option value="">全部身份</option>${html}`;
    qs('#conversation-new-identity').innerHTML = `<option value="">未确认</option>${html}`;
  }

  function setConfirmedSpeakerOptions(speakers) {
    state.confirmedSpeakerOptions = Array.isArray(speakers) ? speakers : [];
    const optionsHtml = '<option value="">请选择已有发言人</option>' + state.confirmedSpeakerOptions.map((speaker) => `
      <option value="${escapeHtml(speaker.id)}">${escapeHtml(speaker.name || speaker.display_label || speaker.id)}</option>
    `).join('');
    qs('#conversation-existing-speaker').innerHTML = optionsHtml;
  }

  function renderTopStats(stats) {
    qs('#stat-confirmed-speakers').textContent = String(stats.confirmed || 0);
  }

  function formatRunSummary(summary) {
    if (!summary) return '-';
    const time = summary.finishedAt || summary.startedAt || '-';
    if (summary.error) return `${formatDate(time)} 失败：${summary.error}`;
    if (summary.mode === 'omi_import') {
      return `${formatDate(time)} 导入 ${summary.inserted || 0}，合并 ${summary.merged || 0}，总量 ${summary.totalActive || 0}`;
    }
    if (summary.mode === 'ai_supplement') {
      return `${formatDate(time)} 新增 ${summary.promoted || 0}，总量 ${summary.totalActive || 0}`;
    }
    return formatDate(time);
  }

  function renderMemoryStatus(status) {
    state.memoryStatus = status;
    qs('#memory-omi-count').textContent = String(status.omiMemoryCount || 0);
    qs('#memory-knowledge-count').textContent = String(status.knowledgeMemoryCount || 0);
    qs('#memory-candidate-count').textContent = String(status.candidateCount || 0);
    qs('#memory-ai-enabled').checked = !!status.aiSupplementEnabled;
    qs('#memory-ai-availability').textContent = status.aiAvailableFromEnv
      ? '服务器已检测到 MiniMax 环境变量，可直接补充。'
      : '服务器未配置 MiniMax 环境变量，可在执行时临时填入 API Key。';
    qs('#memory-last-omi-import').textContent = `最近 OMI 导入：${formatRunSummary(status.lastOmiImport)}`;
    qs('#memory-last-ai-supplement').textContent = `最近 AI 补充：${formatRunSummary(status.lastAiSupplement)}`;
    qs('#memory-run-ai').disabled = !status.aiSupplementEnabled || !!status.aiJobRunning;
    qs('#memory-sync-omi').disabled = !!status.aiJobRunning;
    qs('#memory-job-badge').innerHTML = status.aiJobRunning
      ? '<span class="badge warning">AI 补充运行中</span>'
      : status.aiSupplementEnabled
        ? '<span class="badge">AI 补充入口已启用</span>'
        : '<span class="badge danger">AI 补充入口已关闭</span>';
  }

  async function loadIdentityOptions() {
    const result = await apiGet('/api/meta/identity-options');
    setIdentityOptions(result.data);
  }

  async function loadMemoryStatus() {
    const result = await apiGet('/api/knowledge/memories/status');
    renderMemoryStatus(result.data);
  }

  async function loadConfirmedSpeakerOptions() {
    const result = await apiGet('/api/speakers?confirmation=confirmed&page=1&page_size=200');
    setConfirmedSpeakerOptions(result.data || []);
  }

  function renderSpeakerPagination() {
    qs('#speaker-list-count').textContent = `共 ${state.speakerPagination.total} 条`;
    qs('#speaker-pagination').textContent = `第 ${state.speakerPagination.page} / ${state.speakerPagination.totalPages} 页`;
    qs('#speaker-prev-page').disabled = state.speakerPagination.page <= 1;
    qs('#speaker-next-page').disabled = state.speakerPagination.page >= state.speakerPagination.totalPages;
  }

  function renderSpeakerList() {
    const keyword = qs('#speaker-q').value.trim();
    const listEl = qs('#speaker-list');
    renderSpeakerPagination();
    listEl.innerHTML = state.speakers.length
      ? state.speakers.map((item) => `
        <article class="list-item ${item.id === state.selectedSpeakerId ? 'active' : ''}" data-speaker-id="${item.id}">
          <div class="list-item-title">
            <span>${highlightText(speakerDisplayName(item), keyword)}</span>
            <span class="subtle">${escapeHtml(formatDate(item.last_seen_at || item.created_at))}</span>
          </div>
          <div class="badge-row">${speakerBadges(item)}</div>
          <p class="subtle">${highlightText(item.identity_label || '身份未确认', keyword)}</p>
          <p>${highlightText((item.sample_text || '').slice(0, 80) || '暂无样本文本', keyword)}</p>
        </article>
      `).join('')
      : '<p class="subtle">没有匹配的正式发言人。</p>';

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
    const confirmation = qs('#speaker-confirmation').value || 'confirmed';
    const start = qs('#speaker-start').value;
    const end = qs('#speaker-end').value;
    const pageSize = Number(qs('#speaker-page-size').value || '20');

    if (q) params.set('q', q);
    params.set('confirmation', confirmation);
    if (start) params.set('start_time', new Date(start).toISOString());
    if (end) params.set('end_time', new Date(end).toISOString());
    params.set('page', String(state.speakerPagination.page));
    params.set('page_size', String(pageSize));

    const result = await apiGet(`/api/speakers?${params.toString()}`);
    state.speakers = result.data;
    state.speakerPagination = result.pagination;
    renderTopStats(result.stats);
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
      audio.pause();
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

  function renderConversationPagination() {
    qs('#conversation-list-count').textContent = `共 ${state.conversationPagination.total} 条`;
    qs('#conversation-pagination').textContent = `第 ${state.conversationPagination.page} / ${state.conversationPagination.totalPages} 页`;
    qs('#conv-prev-page').disabled = state.conversationPagination.page <= 1;
    qs('#conv-next-page').disabled = state.conversationPagination.page >= state.conversationPagination.totalPages;
  }

  function renderConversationList() {
    const keyword = qs('#conv-keyword').value.trim();
    const listEl = qs('#conversation-list');
    renderConversationPagination();
    listEl.innerHTML = state.conversations.length
      ? state.conversations.map((item) => `
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
      `).join('')
      : '<p class="subtle">没有匹配的会话。</p>';

    listEl.querySelectorAll('[data-conversation-id]').forEach((node) => {
      node.addEventListener('click', () => {
        state.selectedConversationId = node.getAttribute('data-conversation-id');
        state.selectedConversationSpeakerFilter = null;
        renderConversationList();
        loadConversationDetail(state.selectedConversationId).catch(showError);
      });
    });
  }

  function clearConversationPlaybackTimer() {
    if (conversationPlaybackStopTimer) {
      window.clearTimeout(conversationPlaybackStopTimer);
      conversationPlaybackStopTimer = null;
    }
  }

  function playConversationSegment(segment) {
    const player = qs('#conversation-audio-player');
    if (!player || !player.getAttribute('src')) {
      throw new Error('当前会话没有可播放音频');
    }

    const startSec = Math.max(0, Number(segment.start_ms || 0) / 1000);
    const endSec = Math.max(startSec, Number(segment.end_ms || 0) / 1000);
    const startPlayback = () => {
      player.currentTime = startSec;
      void player.play().catch(showError);
      clearConversationPlaybackTimer();
      conversationPlaybackStopTimer = window.setTimeout(() => {
        player.pause();
        player.currentTime = endSec;
      }, Math.max(200, Math.round((endSec - startSec) * 1000) + 120));
    };

    if (player.readyState >= 1) {
      startPlayback();
      return;
    }

    const onLoaded = () => {
      player.removeEventListener('loadedmetadata', onLoaded);
      startPlayback();
    };
    player.addEventListener('loadedmetadata', onLoaded);
    player.load();
  }

  function updateConversationSpeakerModeVisibility() {
    const isExisting = qs('#conversation-speaker-mode').value === 'existing';
    qs('#conversation-existing-speaker-field').classList.toggle('hidden', !isExisting);
    qs('#conversation-new-name-field').classList.toggle('hidden', isExisting);
    qs('#conversation-new-identity-field').classList.toggle('hidden', isExisting);
  }

  function updateConversationSelectionSummary(detail = state.selectedConversationDetail) {
    const selected = getSelectedConversationSegments(detail);
    const selectedDurationMs = selected.reduce((sum, segment) => sum + Math.max(0, Number(segment.end_ms || 0) - Number(segment.start_ms || 0)), 0);
    const labels = [...new Set(selected.map((segment) => segment.original_speaker_label || segment.speaker_label).filter(Boolean))];
    qs('#conversation-selected-count').textContent = String(selected.length);
    qs('#conversation-selected-duration').textContent = `${(selectedDurationMs / 1000).toFixed(1)}s`;
    qs('#conversation-selected-labels').textContent = labels.length ? labels.join(', ') : '-';
    if (state.speakerModalOpen) {
      renderSpeakerModal();
    }
  }

  function renderSpeakerModal() {
    const selected = getSelectedConversationSegments();
    const selectedDurationMs = selected.reduce((sum, segment) => sum + Math.max(0, Number(segment.end_ms || 0) - Number(segment.start_ms || 0)), 0);
    const labels = [...new Set(selected.map((segment) => segment.original_speaker_label || segment.speaker_label).filter(Boolean))];
    qs('#modal-selected-count').textContent = String(selected.length);
    qs('#modal-selected-duration').textContent = `${(selectedDurationMs / 1000).toFixed(1)}s`;
    qs('#modal-selected-labels').textContent = labels.length ? labels.join(', ') : '-';
    qs('#modal-selected-preview').innerHTML = selected.length
      ? selected.slice(0, 6).map((segment) => `
        <article class="segment-item compact-segment">
          <div class="segment-title">
            <span>${escapeHtml(formatDate(segment.absolute_start_time))}</span>
            <span class="subtle">${escapeHtml(conversationDisplaySpeaker(segment))}</span>
          </div>
          <p>${escapeHtml(segment.text)}</p>
        </article>
      `).join('')
      : '<p class="subtle">尚未选择片段。</p>';
  }

  function renderConversationSpeakerSummary(detail) {
    qs('#conversation-speakers').innerHTML = detail.speakers.length
      ? detail.speakers.map((speaker) => {
        const isActive = state.selectedConversationSpeakerFilter === speaker.speaker_label;
        return `
          <article class="speaker-summary-item ${isActive ? 'active' : ''}" data-conversation-speaker-label="${escapeHtml(speaker.speaker_label || '')}">
            <div class="speaker-summary-main">
              <strong>${escapeHtml(speaker.speaker_label || speaker.display_name || '-')}</strong>
              <span class="subtle">${escapeHtml(speaker.display_name || '-')}</span>
            </div>
            <div class="speaker-summary-meta subtle">
              <span>片段 ${speaker.segment_count}</span>
              <span>${(speaker.total_duration_ms / 1000).toFixed(1)}s</span>
            </div>
          </article>
        `;
      }).join('')
      : '<p class="subtle">暂无参与者信息。</p>';

    qs('#conversation-speakers').querySelectorAll('[data-conversation-speaker-label]').forEach((node) => {
      node.addEventListener('click', () => {
        const raw = node.getAttribute('data-conversation-speaker-label');
        state.selectedConversationSpeakerFilter = raw || null;
        renderConversationSpeakerSummary(detail);
        renderConversationTranscript(detail);
      });
    });
  }

  function renderConversationTranscript(detail) {
    const keyword = qs('#conv-keyword').value.trim();
    const rows = getFilteredConversationSegments(detail);
    qs('#conversation-segments').innerHTML = rows.length
      ? rows.map((segment) => {
        const checked = state.selectedSegmentIds.has(segment.id) ? 'checked' : '';
        const displaySpeaker = conversationDisplaySpeaker(segment);
        const absoluteStart = formatDate(segment.absolute_start_time);
        const absoluteEnd = formatDate(segment.absolute_end_time);
        const displayState = segment.speaker_name ? '已实名' : (segment.speaker_label || '未标注');
        return `
          <article class="transcript-row" data-conversation-segment-id="${escapeHtml(segment.id)}">
            <div class="transcript-time">
              <label class="voiceprint-check">
                <input type="checkbox" data-conversation-segment-select ${checked} />
                <span>${escapeHtml(formatSegmentSeconds(segment.start_ms))} - ${escapeHtml(formatSegmentSeconds(segment.end_ms))}</span>
              </label>
              <div class="subtle">${escapeHtml(absoluteStart)}</div>
              <div class="subtle">${escapeHtml(absoluteEnd)}</div>
            </div>
            <div class="transcript-text">
              <div class="transcript-display-name subtle">${escapeHtml(displaySpeaker)}</div>
              <div>${highlightText(segment.text, keyword)}</div>
            </div>
            <div class="transcript-actions">
              <span class="badge">${escapeHtml(displayState)}</span>
              <button type="button" class="inline-action compact-action secondary-button" data-play-segment="${escapeHtml(segment.id)}">试听</button>
              ${segment.speaker_id ? `<button class="inline-action secondary-button" data-go-speaker="${escapeHtml(segment.speaker_id)}">去确认</button>` : ''}
            </div>
          </article>
        `;
      }).join('')
      : '<p class="subtle">当前筛选条件下没有 transcript 片段。</p>';

    qs('#conversation-segments').querySelectorAll('[data-conversation-segment-select]').forEach((node) => {
      node.addEventListener('change', () => {
        const row = node.closest('[data-conversation-segment-id]');
        const segmentId = row?.getAttribute('data-conversation-segment-id');
        if (!segmentId) return;
        if (node.checked) {
          state.selectedSegmentIds.add(segmentId);
        } else {
          state.selectedSegmentIds.delete(segmentId);
        }
        updateConversationSelectionSummary(detail);
      });
    });

    qs('#conversation-segments').querySelectorAll('[data-play-segment]').forEach((node) => {
      node.addEventListener('click', () => {
        const segmentId = node.getAttribute('data-play-segment');
        const segment = (detail.segments || []).find((item) => item.id === segmentId);
        if (segment) {
          playConversationSegment(segment);
        }
      });
    });

    qs('#conversation-segments').querySelectorAll('[data-go-speaker]').forEach((node) => {
      node.addEventListener('click', () => {
        state.selectedSpeakerId = node.getAttribute('data-go-speaker');
        switchTab('directory');
        loadSpeakers(false).catch(showError);
      });
    });
  }

  function resetConversationDetail() {
    qs('#conversation-empty').classList.remove('hidden');
    qs('#conversation-detail').classList.add('hidden');
    const player = qs('#conversation-audio-player');
    clearConversationPlaybackTimer();
    player.pause();
    player.removeAttribute('src');
    player.classList.add('hidden');
    qs('#conversation-audio-empty').classList.remove('hidden');
    state.selectedConversationDetail = null;
    state.selectedConversationSpeakerFilter = null;
    state.selectedSegmentIds.clear();
    updateConversationSelectionSummary(null);
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
    state.selectedConversationDetail = detail;
    const validIds = new Set((detail.segments || []).map((segment) => segment.id));
    state.selectedSegmentIds = new Set([...state.selectedSegmentIds].filter((segmentId) => validIds.has(segmentId)));
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
    const audioPlayer = qs('#conversation-audio-player');
    const audioEmpty = qs('#conversation-audio-empty');
    if (detail.conversation.audio_file_url) {
      audioLink.href = detail.conversation.audio_file_url;
      audioLink.classList.remove('hidden');
      audioPlayer.src = detail.conversation.audio_file_url;
      audioPlayer.classList.remove('hidden');
      audioEmpty.classList.add('hidden');
    } else {
      audioLink.classList.add('hidden');
      audioLink.removeAttribute('href');
      audioPlayer.pause();
      audioPlayer.removeAttribute('src');
      audioPlayer.classList.add('hidden');
      audioEmpty.classList.remove('hidden');
    }

    renderConversationSpeakerSummary(detail);
    renderConversationTranscript(detail);
    updateConversationSelectionSummary(detail);
  }

  async function loadConversationDetail(conversationId) {
    if (!conversationId) return;
    const result = await apiGet(`/api/conversations/${conversationId}`);
    renderConversationDetail(result.data);
  }

  async function enrollSelectedConversationSegments() {
    if (!state.selectedConversationId) {
      throw new Error('请先选择会话');
    }
    const selectedIds = [...state.selectedSegmentIds];
    if (!selectedIds.length) {
      throw new Error('请先勾选至少一个片段');
    }

    const speakerMode = qs('#conversation-speaker-mode').value;
    const body = {
      conversationId: state.selectedConversationId,
      segmentIds: selectedIds,
      speakerMode: speakerMode,
      speakerId: speakerMode === 'existing' ? qs('#conversation-existing-speaker').value : null,
      speakerName: speakerMode === 'new' ? qs('#conversation-new-speaker-name').value.trim() : null,
      identityLabel: speakerMode === 'new' ? qs('#conversation-new-identity').value : null,
      excludedSegmentIds: [],
    };

    if (speakerMode === 'existing' && !body.speakerId) {
      throw new Error('请选择已有发言人');
    }
    if (speakerMode === 'new' && !body.speakerName) {
      throw new Error('请输入新发言人姓名');
    }

    // Disable buttons during request
    qs('#conversation-enroll-existing').disabled = true;
    qs('#conversation-enroll-new').disabled = true;

    let result;
    try {
      result = await apiSend('/api/admin/voiceprint/xfyun/enroll-from-segments', 'POST', body);
    } finally {
      qs('#conversation-enroll-existing').disabled = false;
      qs('#conversation-enroll-new').disabled = false;
    }

    state.selectedSegmentIds.clear();
    closeSpeakerModal();
    await loadConversationDetail(state.selectedConversationId);
    await loadConversations(false);
    await loadSpeakers(false);
    await loadConfirmedSpeakerOptions();
    window.alert(`操作完成：${result.data.createdNewSpeaker ? '新建' : '更新'} speaker ${result.data.speakerId}，处理 ${result.data.processedSegmentCount} 条，排除 ${result.data.excludedSegmentCount} 条。`);
  }

  async function backfillSelectedConversation() {
    if (!state.selectedConversationId) {
      throw new Error('请先选择会话');
    }
    const button = qs('#conversation-backfill');
    button.disabled = true;
    let result;
    try {
      const url = `/api/admin/conversations/${encodeURIComponent(state.selectedConversationId)}/voiceprint/xfyun/backfill`;
      console.log('[DEBUG] backfill url:', url);
      result = await apiSend(url, 'POST', {
        onlyUnresolved: true,
        limit: 1000,
        dryRun: false,
      });
      console.log('[DEBUG] backfill result:', result);
    } catch (err) {
      console.error('[DEBUG] backfill error:', err);
      throw err;
    } finally {
      button.disabled = false;
    }
    await loadConversationDetail(state.selectedConversationId);
    await loadConversations(false);
    window.alert(`重刷完成：自动命中 ${result.data.hit}，低置信 ${result.data.lowConfidence}，冲突 ${result.data.conflict}，未命中 ${result.data.noMatch}，跳过 ${result.data.skipped}，错误 ${result.data.error}`);
  }

  async function saveMemoryConfig() {
    await apiSend('/api/knowledge/memories/config', 'POST', {
      aiSupplementEnabled: qs('#memory-ai-enabled').checked,
    });
    await loadMemoryStatus();
  }

  async function syncOmiMemories() {
    const button = qs('#memory-sync-omi');
    button.disabled = true;
    try {
      const result = await apiSend('/api/knowledge/memories/sync-omi', 'POST', {});
      await loadMemoryStatus();
      window.alert(`OMI memories 同步完成：导入 ${result.data.inserted}，合并 ${result.data.merged}，总量 ${result.data.totalActive}`);
    } finally {
      if (state.memoryStatus) renderMemoryStatus(state.memoryStatus);
    }
  }

  async function runAiSupplement() {
    if (!state.memoryStatus?.aiSupplementEnabled) {
      throw new Error('请先打开 AI 补充入口开关');
    }
    const button = qs('#memory-run-ai');
    button.disabled = true;
    try {
      const result = await apiSend('/api/knowledge/memories/ai-supplement', 'POST', {
        apiKey: qs('#memory-api-key').value.trim() || undefined,
      });
      await loadMemoryStatus();
      window.alert(`AI 补充完成：新增 ${result.data.promoted} 条 memory，总量 ${result.data.totalActive}`);
    } finally {
      qs('#memory-api-key').value = '';
      if (state.memoryStatus) renderMemoryStatus(state.memoryStatus);
    }
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.tab-button').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
  }

  function showError(err) {
    window.alert(err?.message || String(err));
  }

  function bindEvents() {
    document.querySelectorAll('.tab-button').forEach((button) => {
      button.addEventListener('click', () => switchTab(button.getAttribute('data-tab')));
    });

    qs('#conv-search').addEventListener('click', () => loadConversations(true).catch(showError));
    qs('#conv-page-size').addEventListener('change', () => loadConversations(true).catch(showError));
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

    qs('#conversation-clear-speaker-filter').addEventListener('click', () => {
      state.selectedConversationSpeakerFilter = null;
      if (state.selectedConversationDetail) {
        renderConversationSpeakerSummary(state.selectedConversationDetail);
        renderConversationTranscript(state.selectedConversationDetail);
      }
    });
    qs('#conversation-open-modal').addEventListener('click', () => openSpeakerModal());
    qs('#speaker-modal-close').addEventListener('click', () => closeSpeakerModal());
    qs('#speaker-modal').addEventListener('click', (event) => {
      if (event.target === qs('#speaker-modal')) {
        closeSpeakerModal();
      }
    });
    qs('#conversation-speaker-mode').addEventListener('change', updateConversationSpeakerModeVisibility);
    qs('#conversation-enroll-existing').addEventListener('click', () => enrollSelectedConversationSegments().catch(showError));
    qs('#conversation-enroll-new').addEventListener('click', () => enrollSelectedConversationSegments().catch(showError));
    qs('#conversation-backfill').addEventListener('click', () => {
      console.log('[DEBUG] backfill button clicked, selectedConversationId:', state.selectedConversationId);
      backfillSelectedConversation()
        .then(() => console.log('[DEBUG] backfill completed successfully'))
        .catch((err) => {
          console.error('[DEBUG] backfill failed with error:', err);
          showError(err);
        });
    });
    qs('#conversation-clear-selection').addEventListener('click', () => {
      state.selectedSegmentIds.clear();
      if (state.speakerModalOpen) {
        renderSpeakerModal();
      }
      updateConversationSelectionSummary(state.selectedConversationDetail);
      if (state.selectedConversationDetail) {
        renderConversationTranscript(state.selectedConversationDetail);
      }
    });

    qs('#speaker-search').addEventListener('click', () => loadSpeakers(true).catch(showError));
    qs('#speaker-page-size').addEventListener('change', () => loadSpeakers(true).catch(showError));
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
      await loadConfirmedSpeakerOptions();
    });

    qs('#memory-ai-enabled').addEventListener('change', () => saveMemoryConfig().catch(showError));
    qs('#memory-sync-omi').addEventListener('click', () => syncOmiMemories().catch(showError));
    qs('#memory-run-ai').addEventListener('click', () => runAiSupplement().catch(showError));
  }

  bindEvents();
  switchTab(state.activeTab);
  Promise.all([
    loadIdentityOptions(),
    loadConfirmedSpeakerOptions(),
    loadConversations(true),
    loadSpeakers(true),
    loadMemoryStatus(),
  ]).then(() => {
    updateConversationSpeakerModeVisibility();
  }).catch(showError);
})();
