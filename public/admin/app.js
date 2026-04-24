(function () {
  const state = {
    activeTab: 'directory',
    identityOptions: [],
    speakers: [],
    speakerPagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    selectedSpeakerId: null,
    conversations: [],
    conversationPagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    selectedConversationId: null,
    memoryStatus: null,
    voiceprintConversations: [],
    voiceprintConversationId: null,
    voiceprintPendingSegments: [],
    voiceprintGroups: [],
    voiceprintStats: {
      totalSegments: 0,
      autoHitCount: 0,
      humanConfirmedCount: 0,
      unresolvedCount: 0,
      skippedShortCount: 0,
      errorCount: 0,
    },
    voiceprintSelectedSegmentIds: new Set(),
    voiceprintSpeakers: [],
    voiceprintStatusFilter: 'actionable',
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

  function formatSeconds(value) {
    const totalSeconds = Math.max(0, Math.round(Number(value || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
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
    const conversationVoiceprintSelect = qs('#conversation-new-identity');
    speakerSelect.innerHTML = '<option value="">未确认</option>' + state.identityOptions.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
    conversationSelect.innerHTML = '<option value="">全部身份</option>' + state.identityOptions.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
    if (conversationVoiceprintSelect) {
      conversationVoiceprintSelect.innerHTML = '<option value="">未确认</option>' + state.identityOptions.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
    }
  }

  async function loadIdentityOptions() {
    const result = await apiGet('/api/meta/identity-options');
    setIdentityOptions(result.data);
  }

  function renderStats(stats) {
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

  async function loadMemoryStatus() {
    const result = await apiGet('/api/knowledge/memories/status');
    renderMemoryStatus(result.data);
  }

  function renderVoiceprintStats(stats) {
    const current = stats || state.voiceprintStats;
    qs('#voiceprint-total-count').textContent = String(current.totalSegments || 0);
    qs('#voiceprint-auto-hit-count').textContent = String(current.autoHitCount || 0);
    qs('#voiceprint-human-count').textContent = String(current.humanConfirmedCount || 0);
    qs('#voiceprint-unresolved-count').textContent = String(current.unresolvedCount || 0);
    qs('#voiceprint-skipped-count').textContent = String(current.skippedShortCount || 0);
    qs('#voiceprint-error-count').textContent = String(current.errorCount || 0);
  }

  function voiceprintDecisionLabel(value) {
    const labels = {
      xfyun_low_confidence: '低置信',
      xfyun_conflict: '冲突',
      xfyun_no_match: '未命中',
      xfyun_error: '错误',
      xfyun_skipped_short: '太短跳过',
      xfyun_segment_hit: '自动命中',
      xfyun_current_conversation_backfill_hit: '回刷命中',
      human_segment_confirmed: '人工确认',
      human_segment_excluded: '已排除',
      pending: '待扫描',
    };
    return labels[value] || value || '待处理';
  }

  function voiceprintDecisionClass(value) {
    if (value === 'xfyun_error') return 'danger';
    if (value === 'xfyun_low_confidence' || value === 'xfyun_conflict') return 'warning';
    return '';
  }

  function getVisibleVoiceprintSegments() {
    const rows = state.voiceprintPendingSegments || [];
    const filter = state.voiceprintStatusFilter || 'actionable';
    if (filter === 'all') return rows;
    return rows.filter((item) => {
      const decision = item.decision || item.resolutionMethod || 'pending';
      if (filter === 'low') return decision === 'xfyun_low_confidence';
      if (filter === 'error') return decision === 'xfyun_error';
      if (filter === 'nomatch') return decision === 'xfyun_no_match';
      if (filter === 'conflict') return decision === 'xfyun_conflict';
      return ['pending', 'xfyun_low_confidence', 'xfyun_conflict', 'xfyun_no_match', 'xfyun_error'].includes(decision);
    });
  }

  function getVisibleVoiceprintGroups() {
    const visibleIds = new Set(getVisibleVoiceprintSegments().map((item) => item.segmentId));
    return (state.voiceprintGroups || [])
      .map((group) => ({
        ...group,
        segments: (group.segments || []).filter((item) => visibleIds.has(item.segmentId)),
      }))
      .filter((group) => group.segments.length > 0);
  }

  function getVoiceprintSelectedIds() {
    return Array.from(state.voiceprintSelectedSegmentIds);
  }

  function updateVoiceprintSelectionSummary() {
    const selectedCount = state.voiceprintSelectedSegmentIds.size;
    qs('#voiceprint-selected-count').textContent = String(selectedCount);
    qs('#voiceprint-selected-summary').textContent = `${selectedCount} 条`;
  }

  function setVoiceprintConversationOptions(conversations) {
    state.voiceprintConversations = Array.isArray(conversations) ? conversations : [];
    const select = qs('#voiceprint-conversation-select');
    const options = ['<option value="">选择会话</option>']
      .concat(state.voiceprintConversations.map((conversation) => `
        <option value="${escapeHtml(conversation.id)}">
          ${escapeHtml(formatDate(conversation.started_at))} / ${escapeHtml(conversation.id)}
        </option>
      `));
    select.innerHTML = options.join('');
    if (state.voiceprintConversationId) {
      select.value = state.voiceprintConversationId;
    }
  }

  function setVoiceprintSpeakerOptions(speakers) {
    state.voiceprintSpeakers = Array.isArray(speakers) ? speakers : [];
    const optionsHtml = '<option value="">请选择已有发言人</option>' + state.voiceprintSpeakers.map((speaker) => `
      <option value="${escapeHtml(speaker.id)}">${escapeHtml(speaker.name || speaker.display_label || speaker.id)}</option>
    `).join('');
    const select = qs('#voiceprint-existing-speaker');
    if (select) {
      select.innerHTML = optionsHtml;
    }
    const conversationSelect = qs('#conversation-existing-speaker');
    if (conversationSelect) {
      conversationSelect.innerHTML = optionsHtml;
    }
  }

  function conversationDisplaySpeaker(segment) {
    return segment.speaker_name || segment.display_name || segment.speaker_label || '未知发言人';
  }

  function updateConversationSpeakerModeVisibility() {
    const isExisting = qs('#conversation-speaker-mode').value === 'existing';
    qs('#conversation-existing-speaker-field').classList.toggle('hidden', !isExisting);
    qs('#conversation-new-name-field').classList.toggle('hidden', isExisting);
    qs('#conversation-new-identity-field').classList.toggle('hidden', isExisting);
  }

  function updateConversationSelectionSummary(detail) {
    const selectedCount = state.voiceprintSelectedSegmentIds.size;
    const unresolvedCount = (detail?.segments || []).filter((segment) => !segment.speaker_id).length;
    qs('#conversation-selected-count').textContent = String(selectedCount);
    qs('#conversation-unresolved-count').textContent = String(unresolvedCount);
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

  async function scanSelectedConversation() {
    if (!state.selectedConversationId) {
      throw new Error('请先选择会话');
    }
    const result = await apiSend(`/api/admin/conversations/${encodeURIComponent(state.selectedConversationId)}/voiceprint/xfyun/scan`, 'POST', {
      onlyUnresolved: true,
      limit: 1000,
      dryRun: false,
    });
    await loadConversationDetail(state.selectedConversationId);
    await loadConversations(false);
    window.alert(`扫描完成：自动命中 ${result.data.hit}，低置信 ${result.data.lowConfidence}，冲突 ${result.data.conflict}，未命中 ${result.data.noMatch}，跳过 ${result.data.skipped}，错误 ${result.data.error}`);
  }

  async function backfillSelectedConversation() {
    if (!state.selectedConversationId) {
      throw new Error('请先选择会话');
    }
    const result = await apiSend(`/api/admin/conversations/${encodeURIComponent(state.selectedConversationId)}/voiceprint/xfyun/backfill`, 'POST', {
      onlyUnresolved: true,
      limit: 1000,
      dryRun: false,
    });
    await loadConversationDetail(state.selectedConversationId);
    await loadConversations(false);
    window.alert(`重刷完成：自动命中 ${result.data.hit}，低置信 ${result.data.lowConfidence}，冲突 ${result.data.conflict}，未命中 ${result.data.noMatch}，跳过 ${result.data.skipped}，错误 ${result.data.error}`);
  }

  async function enrollSelectedConversationSegments(mode) {
    if (!state.selectedConversationId) {
      throw new Error('请先选择会话');
    }
    const selectedIds = getVoiceprintSelectedIds();
    if (!selectedIds.length) {
      throw new Error('请先勾选至少一个片段');
    }

    const body = {
      conversationId: state.selectedConversationId,
      segmentIds: mode === 'exclude' ? [] : selectedIds,
      speakerMode: qs('#conversation-speaker-mode').value === 'existing' ? 'existing' : 'new',
      speakerId: qs('#conversation-existing-speaker').value || null,
      speakerName: qs('#conversation-new-speaker-name').value.trim() || null,
      identityLabel: qs('#conversation-new-identity').value || null,
      excludedSegmentIds: mode === 'exclude' ? selectedIds : [],
    };

    if (mode === 'existing' && !body.speakerId) {
      throw new Error('请选择已有发言人');
    }
    if (mode === 'new' && !body.speakerName) {
      throw new Error('请输入新发言人姓名');
    }

    const result = await apiSend('/api/admin/voiceprint/xfyun/enroll-from-segments', 'POST', body);
    state.voiceprintSelectedSegmentIds.clear();
    await loadConversationDetail(state.selectedConversationId);
    await loadConversations(false);
    await loadSpeakers(false);
    if (result.data.action === 'exclude_segments') {
      window.alert(`已排除 ${result.data.excludedSegmentCount} 条片段。`);
      return;
    }
    window.alert(`操作完成：${result.data.createdNewSpeaker ? '新建' : '更新'} speaker ${result.data.speakerId}，处理 ${result.data.processedSegmentCount} 条，排除 ${result.data.excludedSegmentCount} 条。`);
  }

  function renderVoiceprintPanel(detail) {
    const conversationId = detail?.conversationId || state.voiceprintConversationId || '-';
    qs('#voiceprint-panel-title').textContent = detail ? `会话 ${conversationId}` : '选择一个会话后离线扫描';
    qs('#voiceprint-conversation-id').textContent = conversationId || '-';
    qs('#voiceprint-current-status').textContent = detail
      ? `已加载 ${getVisibleVoiceprintGroups().length} 组 / ${getVisibleVoiceprintSegments().length} 条待处理`
      : '未加载';
    qs('#voiceprint-panel-badges').innerHTML = detail
      ? [
        `<span class="badge">待确认 ${detail.stats?.unresolvedCount || 0}</span>`,
        `<span class="badge">自动命中 ${detail.stats?.autoHitCount || 0}</span>`,
      ].join('')
      : '';
  }

  function renderVoiceprintPendingList() {
    const listEl = qs('#voiceprint-pending-list');
    const filterText = '';
    const groups = getVisibleVoiceprintGroups();
    listEl.innerHTML = groups.length
      ? groups.map((group) => `
        <section class="voiceprint-group">
          <div class="voiceprint-group-header">
            <div>
              <div class="segment-title">
                <strong>${escapeHtml(group.speakerLabel || '未标注 Soniox speaker')}</strong>
                <span class="subtle">${group.segmentCount} 条 / ${(group.totalDurationMs / 1000).toFixed(1)}s</span>
              </div>
              <p class="subtle">${escapeHtml((group.samples || []).join(' / ') || '暂无代表文本')}</p>
            </div>
            <button type="button" class="secondary-button inline-action" data-voiceprint-select-group="${escapeHtml(group.speakerLabel || 'unknown')}">全选本组</button>
          </div>
          <div class="voiceprint-group-list">
            ${(group.segments || []).map((item) => {
              const checked = state.voiceprintSelectedSegmentIds.has(item.segmentId) ? 'checked' : '';
              const scoreText = item.topScore == null ? '-' : item.topScore.toFixed(1);
              const secondScoreText = item.secondScore == null ? '-' : item.secondScore.toFixed(1);
              const hasAudio = !!item.audioUrl;
              return `
                <article class="segment-item voiceprint-segment ${checked ? 'active' : ''}" data-voiceprint-segment-id="${escapeHtml(item.segmentId)}">
                  <div class="voiceprint-segment-top">
                    <label class="voiceprint-check">
                      <input type="checkbox" data-voiceprint-select ${checked} />
                      <span>选择</span>
                    </label>
                    <div class="segment-title">
                      <span>${escapeHtml(formatSeconds(item.startMs))} - ${escapeHtml(formatSeconds(item.endMs))}</span>
                      <span class="subtle">当前标签 ${escapeHtml(item.speakerLabel || '未标注')}</span>
                    </div>
                  </div>
                  <div class="badge-row">
                    <span class="badge">${escapeHtml(item.sourceSpeakerLabel || item.speakerLabel || 'unknown')}</span>
                    <span class="badge ${voiceprintDecisionClass(item.decision)}">${escapeHtml(voiceprintDecisionLabel(item.decision || 'pending'))}</span>
                    <span class="badge">Top1 ${escapeHtml(scoreText)}</span>
                    <span class="badge">Top2 ${escapeHtml(secondScoreText)}</span>
                    <span class="badge ${item.resolutionMethod ? '' : 'warning'}">${escapeHtml(voiceprintDecisionLabel(item.resolutionMethod || '未确认'))}</span>
                  </div>
                  <p class="subtle">Segment ID: ${escapeHtml(item.segmentId)}</p>
                  <p>${highlightText(item.text || '', filterText)}</p>
                  ${hasAudio ? `<audio controls preload="none" src="${escapeHtml(item.audioUrl)}"></audio>` : '<p class="subtle">暂无音频，先执行扫描生成试听片段。</p>'}
                </article>
              `;
            }).join('')}
          </div>
        </section>
      `).join('')
      : '<p class="subtle">当前筛选条件下没有待处理 segment。可切换筛选或执行离线扫描未确认。</p>';

    listEl.querySelectorAll('[data-voiceprint-select-group]').forEach((node) => {
      node.addEventListener('click', () => {
        const groupKey = node.getAttribute('data-voiceprint-select-group') || 'unknown';
        const group = getVisibleVoiceprintGroups().find((item) => (item.speakerLabel || 'unknown') === groupKey);
        if (!group) return;
        (group.segments || []).forEach((segment) => state.voiceprintSelectedSegmentIds.add(segment.segmentId));
        updateVoiceprintSelectionSummary();
        renderVoiceprintPendingList();
      });
    });
    listEl.querySelectorAll('[data-voiceprint-select]').forEach((node) => {
      node.addEventListener('change', () => {
        const row = node.closest('[data-voiceprint-segment-id]');
        const segmentId = row?.getAttribute('data-voiceprint-segment-id');
        if (!segmentId) return;
        if (node.checked) {
          state.voiceprintSelectedSegmentIds.add(segmentId);
        } else {
          state.voiceprintSelectedSegmentIds.delete(segmentId);
        }
        updateVoiceprintSelectionSummary();
        renderVoiceprintPendingList();
      });
    });
    updateVoiceprintSelectionSummary();
  }

  async function loadVoiceprintConversations() {
    const result = await apiGet('/api/conversations?page=1&page_size=100');
    setVoiceprintConversationOptions(result.data || []);
    const preferredId = state.selectedConversationId || state.voiceprintConversationId || (result.data && result.data[0] && result.data[0].id);
    if (preferredId) {
      state.voiceprintConversationId = preferredId;
      qs('#voiceprint-conversation-select').value = state.voiceprintConversationId;
    }
  }

  async function loadVoiceprintSpeakers() {
    const result = await apiGet('/api/speakers?confirmation=confirmed&page=1&page_size=200');
    setVoiceprintSpeakerOptions(result.data || []);
  }

  async function loadVoiceprintPendingSegments() {
    if (!state.voiceprintConversationId) {
      state.voiceprintPendingSegments = [];
      state.voiceprintGroups = [];
      state.voiceprintStats = {
        totalSegments: 0,
        autoHitCount: 0,
        humanConfirmedCount: 0,
        unresolvedCount: 0,
        skippedShortCount: 0,
        errorCount: 0,
      };
      renderVoiceprintStats();
      renderVoiceprintPendingList();
      renderVoiceprintPanel(null);
      return;
    }

    const result = await apiGet(`/api/admin/conversations/${encodeURIComponent(state.voiceprintConversationId)}/voiceprint/pending-segments`);
    state.voiceprintPendingSegments = result.data.segments || [];
    state.voiceprintGroups = result.data.groups || [];
    state.voiceprintStats = result.data.stats || state.voiceprintStats;
    const validIds = new Set(getVisibleVoiceprintSegments().map((segment) => segment.segmentId));
    state.voiceprintSelectedSegmentIds = new Set([...state.voiceprintSelectedSegmentIds].filter((segmentId) => validIds.has(segmentId)));
    renderVoiceprintStats();
    renderVoiceprintPanel(result.data);
    renderVoiceprintPendingList();
  }

  function updateVoiceprintSpeakerModeVisibility() {
    const isExisting = qs('#voiceprint-speaker-mode').value === 'existing';
    qs('#voiceprint-existing-speaker-field').classList.toggle('hidden', !isExisting);
    qs('#voiceprint-new-name-field').classList.toggle('hidden', isExisting);
    qs('#voiceprint-new-identity-field').classList.toggle('hidden', isExisting);
  }

  async function scanVoiceprintConversation() {
    if (!state.voiceprintConversationId) {
      throw new Error('请先选择会话');
    }
    const result = await apiSend(`/api/admin/conversations/${encodeURIComponent(state.voiceprintConversationId)}/voiceprint/xfyun/scan`, 'POST', {
      onlyUnresolved: true,
      limit: 100,
      dryRun: false,
    });
    await loadVoiceprintPendingSegments();
    window.alert(`扫描完成：自动命中 ${result.data.hit}，低置信 ${result.data.lowConfidence}，冲突 ${result.data.conflict}，未命中 ${result.data.noMatch}，跳过 ${result.data.skipped}，错误 ${result.data.error}`);
  }

  async function backfillVoiceprintConversation() {
    if (!state.voiceprintConversationId) {
      throw new Error('请先选择会话');
    }
    const result = await apiSend(`/api/admin/conversations/${encodeURIComponent(state.voiceprintConversationId)}/voiceprint/xfyun/backfill`, 'POST', {
      onlyUnresolved: true,
      limit: 1000,
      dryRun: false,
    });
    await loadVoiceprintPendingSegments();
    await loadConversations(false);
    window.alert(`重刷完成：自动命中 ${result.data.hit}，低置信 ${result.data.lowConfidence}，冲突 ${result.data.conflict}，未命中 ${result.data.noMatch}，跳过 ${result.data.skipped}，错误 ${result.data.error}`);
  }

  async function enrollVoiceprintSegments(mode) {
    if (!state.voiceprintConversationId) {
      throw new Error('请先选择会话');
    }
    const selectedIds = getVoiceprintSelectedIds();
    if (!selectedIds.length) {
      throw new Error('请先勾选至少一个 segment');
    }

    const body = {
      conversationId: state.voiceprintConversationId,
      segmentIds: mode === 'exclude' ? [] : selectedIds,
      speakerMode: qs('#voiceprint-speaker-mode').value === 'existing' ? 'existing' : 'new',
      speakerId: qs('#voiceprint-existing-speaker').value || null,
      speakerName: qs('#voiceprint-new-speaker-name').value.trim() || null,
      identityLabel: qs('#voiceprint-new-identity').value || null,
      excludedSegmentIds: mode === 'exclude' ? selectedIds : [],
    };

    if (mode === 'existing' && !body.speakerId) {
      throw new Error('请选择已有发言人');
    }
    if (mode === 'new' && !body.speakerName) {
      throw new Error('请输入新发言人姓名');
    }

    const result = await apiSend('/api/admin/voiceprint/xfyun/enroll-from-segments', 'POST', body);
    state.voiceprintSelectedSegmentIds.clear();
    await loadVoiceprintPendingSegments();
    await loadSpeakers(false);
    await loadConversations(false);
    if (result.data.action === 'exclude_segments') {
      window.alert(`已排除 ${result.data.excludedSegmentCount} 条 segment。`);
      return;
    }
    window.alert(`操作完成：${result.data.createdNewSpeaker ? '新建' : '更新'} speaker ${result.data.speakerId}，处理 ${result.data.processedSegmentCount} 条，排除 ${result.data.excludedSegmentCount} 条。`);
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
    const player = qs('#conversation-audio-player');
    clearConversationPlaybackTimer();
    if (player) {
      player.pause();
      player.removeAttribute('src');
      player.classList.add('hidden');
    }
    qs('#conversation-audio-empty').classList.remove('hidden');
    state.voiceprintSelectedSegmentIds.clear();
    qs('#conversation-selected-count').textContent = '0';
    qs('#conversation-unresolved-count').textContent = '0';
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
    const validIds = new Set((detail.segments || []).map((segment) => segment.id));
    state.voiceprintSelectedSegmentIds = new Set([...state.voiceprintSelectedSegmentIds].filter((segmentId) => validIds.has(segmentId)));
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

    qs('#conversation-speakers').innerHTML = detail.speakers.length
      ? detail.speakers.map((speaker) => `
        <article class="speaker-summary-item">
          <div class="speaker-summary-main">
            <strong>${escapeHtml(speaker.speaker_label || speaker.display_name || '-')}</strong>
            <span class="subtle">${escapeHtml(speaker.identity_label || '身份未确认')}</span>
          </div>
          <div class="speaker-summary-meta subtle">
            <span>${escapeHtml(speaker.display_name || '-')}</span>
            <span>片段 ${speaker.segment_count}</span>
            <span>${(speaker.total_duration_ms / 1000).toFixed(1)}s</span>
          </div>
        </article>
      `).join('')
      : '<p class="subtle">暂无参与者信息。</p>';

    qs('#conversation-segments').innerHTML = detail.segments.length
      ? detail.segments.map((segment) => {
        const checked = state.voiceprintSelectedSegmentIds.has(segment.id) ? 'checked' : '';
        const unresolved = !segment.speaker_id;
        const speakerText = conversationDisplaySpeaker(segment);
        return `
          <article class="transcript-row ${unresolved ? 'unresolved' : ''}" data-conversation-segment-id="${segment.id}">
            <div class="transcript-time">
              <label class="voiceprint-check">
                <input type="checkbox" data-conversation-segment-select ${checked} />
                <span>${escapeHtml(formatSegmentSeconds(segment.start_ms))} - ${escapeHtml(formatSegmentSeconds(segment.end_ms))}</span>
              </label>
              <button type="button" class="inline-action secondary-button" data-play-segment="${segment.id}">试听</button>
            </div>
            <div class="transcript-text">
              <div class="transcript-display-name subtle">${escapeHtml(speakerText)}</div>
              <div>${highlightText(segment.text, keyword)}</div>
            </div>
            <div class="transcript-actions">
              <span class="badge ${unresolved ? 'warning' : ''}">${escapeHtml(segment.speaker_name ? '已实名' : (segment.speaker_label || '未标注'))}</span>
              <span class="badge ${segment.speaker_identity ? '' : 'danger'}">${escapeHtml(segment.speaker_identity || '身份未确认')}</span>
              ${segment.resolution_method ? `<span class="badge">${escapeHtml(voiceprintDecisionLabel(segment.resolution_method))}</span>` : ''}
              ${segment.speaker_id ? `<button class="inline-action secondary-button" data-go-speaker="${segment.speaker_id}">去确认</button>` : ''}
            </div>
          </article>
        `;
      }).join('')
      : '<p class="subtle">暂无 transcript。</p>';

    qs('#conversation-segments').querySelectorAll('[data-conversation-segment-select]').forEach((node) => {
      node.addEventListener('change', () => {
        const row = node.closest('[data-conversation-segment-id]');
        const segmentId = row?.getAttribute('data-conversation-segment-id');
        if (!segmentId) return;
        if (node.checked) {
          state.voiceprintSelectedSegmentIds.add(segmentId);
        } else {
          state.voiceprintSelectedSegmentIds.delete(segmentId);
        }
        updateConversationSelectionSummary(detail);
      });
    });
    qs('#conversation-segments').querySelectorAll('[data-play-segment]').forEach((node) => {
      node.addEventListener('click', () => {
        const segmentId = node.getAttribute('data-play-segment');
        const segment = detail.segments.find((item) => item.id === segmentId);
        if (!segment) return;
        playConversationSegment(segment);
      });
    });
    qs('#conversation-segments').querySelectorAll('[data-go-speaker]').forEach((node) => {
      node.addEventListener('click', () => {
        switchTab('directory');
        state.selectedSpeakerId = node.getAttribute('data-go-speaker');
        loadSpeakers(false).catch(showError);
      });
    });
    updateConversationSelectionSummary(detail);
  }

  async function loadConversationDetail(conversationId) {
    if (!conversationId) return;
    const result = await apiGet(`/api/conversations/${conversationId}`);
    renderConversationDetail(result.data);
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.tab-button').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });

    if (tabName === 'voiceprint') {
      if (!state.voiceprintConversations.length) {
        loadVoiceprintConversations().catch(showError);
      }
      if (!state.voiceprintSpeakers.length) {
        loadVoiceprintSpeakers().catch(showError);
      }
      if (state.voiceprintConversationId) {
        loadVoiceprintPendingSegments().catch(showError);
      }
      updateVoiceprintSpeakerModeVisibility();
    }
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

    qs('#memory-ai-enabled').addEventListener('change', () => saveMemoryConfig().catch(showError));
    qs('#memory-sync-omi').addEventListener('click', () => syncOmiMemories().catch(showError));
    qs('#memory-run-ai').addEventListener('click', () => runAiSupplement().catch(showError));
    qs('#voiceprint-conversation-select').addEventListener('change', () => {
      state.voiceprintConversationId = qs('#voiceprint-conversation-select').value || null;
      state.voiceprintSelectedSegmentIds.clear();
      loadVoiceprintPendingSegments().catch(showError);
    });
    qs('#voiceprint-refresh-conversations').addEventListener('click', () => {
      loadVoiceprintConversations().then(() => loadVoiceprintPendingSegments()).catch(showError);
    });
    qs('#voiceprint-status-filter').addEventListener('change', () => {
      state.voiceprintStatusFilter = qs('#voiceprint-status-filter').value || 'actionable';
      const visibleIds = new Set(getVisibleVoiceprintSegments().map((segment) => segment.segmentId));
      state.voiceprintSelectedSegmentIds = new Set([...state.voiceprintSelectedSegmentIds].filter((segmentId) => visibleIds.has(segmentId)));
      renderVoiceprintPanel({ conversationId: state.voiceprintConversationId, stats: state.voiceprintStats });
      renderVoiceprintPendingList();
    });
    qs('#voiceprint-scan').addEventListener('click', () => scanVoiceprintConversation().catch(showError));
    qs('#voiceprint-backfill').addEventListener('click', () => backfillVoiceprintConversation().catch(showError));
    qs('#voiceprint-speaker-mode').addEventListener('change', updateVoiceprintSpeakerModeVisibility);
    qs('#voiceprint-enroll-existing').addEventListener('click', () => enrollVoiceprintSegments('existing').catch(showError));
    qs('#voiceprint-enroll-new').addEventListener('click', () => enrollVoiceprintSegments('new').catch(showError));
    qs('#voiceprint-exclude').addEventListener('click', () => enrollVoiceprintSegments('exclude').catch(showError));
    qs('#voiceprint-clear-selection').addEventListener('click', () => {
      state.voiceprintSelectedSegmentIds.clear();
      renderVoiceprintPendingList();
      updateVoiceprintSelectionSummary();
    });
    qs('#conversation-speaker-mode').addEventListener('change', updateConversationSpeakerModeVisibility);
    qs('#conversation-enroll-existing').addEventListener('click', () => enrollSelectedConversationSegments('existing').catch(showError));
    qs('#conversation-enroll-new').addEventListener('click', () => enrollSelectedConversationSegments('new').catch(showError));
    qs('#conversation-exclude').addEventListener('click', () => enrollSelectedConversationSegments('exclude').catch(showError));
    qs('#conversation-scan').addEventListener('click', () => scanSelectedConversation().catch(showError));
    qs('#conversation-backfill').addEventListener('click', () => backfillSelectedConversation().catch(showError));
    qs('#conversation-clear-selection').addEventListener('click', () => {
      state.voiceprintSelectedSegmentIds.clear();
      if (state.selectedConversationId) {
        loadConversationDetail(state.selectedConversationId).catch(showError);
      } else {
        qs('#conversation-selected-count').textContent = '0';
      }
    });
  }

  bindEvents();
  switchTab(state.activeTab);
  Promise.all([
    loadIdentityOptions(),
    loadSpeakers(true),
    loadConversations(true),
    loadMemoryStatus(),
    loadVoiceprintConversations(),
    loadVoiceprintSpeakers(),
  ]).then(() => {
    if (!state.voiceprintConversationId) {
      state.voiceprintConversationId = state.selectedConversationId || (state.voiceprintConversations[0] && state.voiceprintConversations[0].id) || null;
      if (state.voiceprintConversationId) {
        qs('#voiceprint-conversation-select').value = state.voiceprintConversationId;
      }
    }
    updateConversationSpeakerModeVisibility();
    updateVoiceprintSpeakerModeVisibility();
    if (state.voiceprintConversationId) {
      loadVoiceprintPendingSegments().catch(showError);
    }
  }).catch(showError);
})();
