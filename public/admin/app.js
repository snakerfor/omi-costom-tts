(function () {
  const state = {
    activeTab: 'conversations',
    identityOptions: [],
    memoryStatus: null,
    speakers: [],
    speakerPagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    selectedSpeakerId: null,
    selectedSpeakerDetail: null,
    speakerEditModalOpen: false,
    speakerMaterialDraft: null,
    confirmedSpeakerOptions: [],
    conversations: [],
    conversationPagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    selectedConversationId: null,
    selectedConversationDetail: null,
    selectedConversationSpeakerFilter: null,
    selectedConversationStatusFilter: '',
    hideShortConversationSegments: false,
    conversationSegmentPagination: { page: 1, pageSize: 30, total: 0, totalPages: 1 },
    selectedSegmentIds: new Set(),
    speakerModalOpen: false,
    materialDrawerOpen: false,
    materialSpeakerMode: 'existing',
  };
  let conversationPlaybackStopTimer = null;
  let speakerPreviewAudio = null;
  let speakerPreviewStopTimer = null;
  const conversationPlaybackStartOffsetMs = 180;
  const conversationPlaybackEndPaddingMs = 120;

  function qs(selector) {
    return document.querySelector(selector);
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function formatTimeOnly(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatAbsoluteTimeMeta(startValue, endValue) {
    if (!startValue && !endValue) {
      return { rangeLabel: '-' };
    }
    if (!startValue || !endValue) {
      const value = startValue || endValue;
      return {
        rangeLabel: formatTimeOnly(value),
      };
    }
    const startDate = new Date(startValue);
    const endDate = new Date(endValue);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return {
        rangeLabel: `${formatTimeOnly(startValue)} - ${formatTimeOnly(endValue)}`,
      };
    }
    return {
      rangeLabel: `${formatTimeOnly(startValue)} - ${formatTimeOnly(endValue)}`,
    };
  }

  function formatSegmentSeconds(value) {
    return `${(Math.max(0, Number(value || 0)) / 1000).toFixed(1)}s`;
  }

  function formatSegmentClock(value) {
    const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
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
    };
    if (value === 'manual_identity_confirm' || value === 'manual_confirm') {
      return '人工确认';
    }
    return labels[value] || '未命中';
  }

  function voiceprintDecisionClass(value) {
    if (value === 'xfyun_error') return 'danger';
    if (value === 'xfyun_low_confidence' || value === 'xfyun_conflict') return 'warning';
    return '';
  }

  function formatConversationError(value) {
    const message = String(value || '').trim();
    if (!message) return '';
    const labels = {
      recovered_after_server_restart: '服务重启后恢复未完成会话',
      superseded_by_new_connection: '同一设备发起了新连接，旧会话被覆盖',
    };
    return labels[message] || message;
  }

  function conversationStatusMeta(item) {
    const status = String(item?.status || '');
    if (status === 'failed') {
      return { label: '失败', className: 'danger' };
    }
    if (status === 'recording') {
      return { label: '录音中', className: 'warning' };
    }
    if (status === 'completed') {
      return { label: '已完成', className: '' };
    }
    return { label: status || '-', className: '' };
  }

  function isShortUnmatchedSegment(segment) {
    const method = segment?.resolution_method || '';
    const durationMs = Math.max(0, Number(segment?.end_ms || 0) - Number(segment?.start_ms || 0));
    if (segment?.speaker_id || segment?.speaker_name) return false;
    if (method === 'xfyun_low_confidence' || method === 'xfyun_conflict' || method === 'xfyun_no_match' || method === 'xfyun_error') {
      return false;
    }
    if (method === 'xfyun_skipped_short') return true;
    return durationMs < 1200;
  }

  function segmentStatusMeta(segment) {
    const method = segment?.resolution_method || '';
    if (method === 'human_segment_excluded') {
      return { label: '已排除', className: 'danger' };
    }
    if (segment?.speaker_id || segment?.speaker_name) {
      return { label: '已实名', className: '' };
    }
    if (isShortUnmatchedSegment(segment)) {
      return { label: '片段过短', className: 'warning' };
    }
    const labels = {
      xfyun_low_confidence: { label: lowConfidenceLabel(segment), className: 'warning' },
      xfyun_conflict: { label: '冲突', className: 'warning' },
      xfyun_no_match: { label: '未命中', className: 'warning' },
      xfyun_error: { label: '识别错误', className: 'danger' },
      xfyun_skipped_short: { label: '片段过短', className: 'warning' },
    };
    if (method === 'manual_identity_confirm' || method === 'manual_confirm') {
      return { label: '已实名', className: '' };
    }
    return labels[method] || { label: '未命中', className: 'warning' };
  }

  function segmentStatusKey(segment) {
    const method = segment?.resolution_method || '';
    if (segment?.speaker_id || segment?.speaker_name) return 'confirmed';
    if (method === 'xfyun_low_confidence' || method === 'xfyun_conflict') return 'low';
    if (method === 'xfyun_no_match') return 'no_match';
    if (method === 'xfyun_error') return 'error';
    if (isShortUnmatchedSegment(segment)) return 'short';
    return 'no_match';
  }

  function conversationListIssueLabel(item) {
    const errorCount = Number(item?.error_count || 0);
    const lowCount = Number(item?.low_confidence_count || 0);
    const noMatchCount = Number(item?.no_match_count || 0);
    const shortCount = Number(item?.short_segment_count || 0);
    if (errorCount > 0) return `错误 ${errorCount}`;
    if (lowCount > 0) return `低置信 ${lowCount}`;
    if (noMatchCount > 0) return `未命中 ${noMatchCount}`;
    if (shortCount > 0) return `过短 ${shortCount}`;
    return '低置信 0';
  }

  function materialUsageMeta(segment) {
    if (segment?.speaker_id || segment?.speaker_name) {
      return { label: `正式语料 · ${conversationDisplaySpeaker(segment)}`, className: 'material-confirmed' };
    }
    const statusKey = segmentStatusKey(segment);
    if (statusKey === 'low') {
      const target = segment?.voiceprint_top_speaker_name || segment?.voiceprint_top_speaker_id || '候选';
      return { label: `加入${target}候选`, className: 'material-candidate' };
    }
    if (statusKey === 'short') {
      return { label: '不可加入语料', className: 'material-disabled' };
    }
    return { label: '候选语料', className: 'material-candidate' };
  }

  function formatScore(value) {
    if (value == null || value === '') return '-';
    const score = Number(value);
    if (!Number.isFinite(score)) return String(value);
    return score > 1 ? score.toFixed(1) : score.toFixed(3);
  }

  function lowConfidenceLabel(segment) {
    const score = segment?.voiceprint_top_score ?? segment?.confidence;
    const speakerName = segment?.voiceprint_top_speaker_name || segment?.voiceprint_top_speaker_id;
    const speaker = segment?.voiceprint_top_speaker_identity && speakerName
      ? `${speakerName}/${segment.voiceprint_top_speaker_identity}`
      : speakerName;
    const parts = [`低置信 ${formatScore(score)}`];
    if (speaker) parts.push(speaker);
    return parts.join(' · ');
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

  function formatRawSpeakerLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = raw.match(/^SPEAKER_(\d+)$/i);
    if (match) {
      return `Speaker ${match[1]}`;
    }
    return raw;
  }

  function unresolvedConversationSpeakerLabel(segmentOrSpeaker) {
    return formatRawSpeakerLabel(
      segmentOrSpeaker?.original_speaker_label
      || segmentOrSpeaker?.speaker_label
      || ''
    );
  }

  function materialSegmentLabel(item) {
    return formatRawSpeakerLabel(item?.original_speaker_label || item?.speaker_label || '') || '未识别片段';
  }

  function materialTimeLabel(item) {
    return `${formatSegmentClock(item?.start_ms)} - ${formatSegmentClock(item?.end_ms)}`;
  }

  function summarizeSpeakerMaterialDraft(draft) {
    const items = draft?.items || [];
    const formalItems = items.filter((item) => item.bucket === 'formal');
    const candidateItems = items.filter((item) => item.bucket === 'candidate');
    const formalDurationMs = formalItems.reduce((sum, item) => sum + Math.max(0, Number(item.end_ms || 0) - Number(item.start_ms || 0)), 0);
    const candidateDurationMs = candidateItems.reduce((sum, item) => sum + Math.max(0, Number(item.end_ms || 0) - Number(item.start_ms || 0)), 0);
    return {
      formalItems,
      candidateItems,
      formalDurationMs,
      candidateDurationMs,
    };
  }

  function initializeSpeakerMaterialDraft(detail) {
    const seen = new Set();
    const items = [];
    (detail.formalMaterials || []).forEach((item) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      items.push({ ...item, bucket: 'formal' });
    });
    (detail.candidateMaterials || []).forEach((item) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      items.push({ ...item, bucket: 'candidate' });
    });
    state.speakerMaterialDraft = {
      speakerId: detail.speaker.id,
      originalFormalIds: new Set((detail.formalMaterials || []).map((item) => item.id)),
      items,
    };
  }

  function clearSpeakerPreviewPlayback() {
    if (speakerPreviewStopTimer) {
      window.clearTimeout(speakerPreviewStopTimer);
      speakerPreviewStopTimer = null;
    }
    if (speakerPreviewAudio) {
      speakerPreviewAudio.pause();
      speakerPreviewAudio = null;
    }
  }

  function playSpeakerMaterial(item) {
    if (!item?.audio_file_url) {
      throw new Error('该片段没有可播放音频');
    }
    clearSpeakerPreviewPlayback();
    const audio = new Audio(item.audio_file_url);
    speakerPreviewAudio = audio;
    const startSec = Math.max(0, (Number(item.start_ms || 0) + conversationPlaybackStartOffsetMs) / 1000);
    const endSec = Math.max(startSec, (Number(item.end_ms || 0) + conversationPlaybackStartOffsetMs + conversationPlaybackEndPaddingMs) / 1000);
    const startPlayback = () => {
      audio.currentTime = startSec;
      void audio.play().catch(showError);
      speakerPreviewStopTimer = window.setTimeout(() => {
        audio.pause();
        audio.currentTime = endSec;
      }, Math.max(200, Math.round((endSec - startSec) * 1000) + 120));
    };
    audio.addEventListener('loadedmetadata', startPlayback, { once: true });
    audio.load();
  }

  async function moveSpeakerMaterial(id, bucket) {
    if (!state.speakerMaterialDraft || !state.selectedSpeakerId || !id) return;
    const target = state.speakerMaterialDraft.items.find((item) => item.id === id);
    if (!target) return;
    await apiSend(`/api/admin/speakers/${encodeURIComponent(state.selectedSpeakerId)}/voiceprint/materials`, 'POST', {
      segmentIds: [id],
      materialStatus: bucket === 'formal' ? 'formal' : 'candidate',
      source: 'admin_speaker_detail',
    });
    await loadSpeakerDetail(state.selectedSpeakerId);
  }

  async function removeSpeakerMaterial(id) {
    if (!state.selectedSpeakerId || !id) return;
    await apiSend(`/api/admin/speakers/${encodeURIComponent(state.selectedSpeakerId)}/voiceprint/materials/${encodeURIComponent(id)}`, 'DELETE');
    await loadSpeakerDetail(state.selectedSpeakerId);
  }

  async function promoteAllCandidateMaterials() {
    if (!state.speakerMaterialDraft || !state.selectedSpeakerId) return;
    const ids = state.speakerMaterialDraft.items
      .filter((item) => item.bucket === 'candidate')
      .map((item) => item.id);
    if (!ids.length) {
      window.alert('当前没有候选语料。');
      return;
    }
    await apiSend(`/api/admin/speakers/${encodeURIComponent(state.selectedSpeakerId)}/voiceprint/materials`, 'POST', {
      segmentIds: ids,
      materialStatus: 'formal',
      source: 'admin_promote_all',
    });
    await loadSpeakerDetail(state.selectedSpeakerId);
  }

  function conversationDisplaySpeaker(segment) {
    if (segment?.speaker_id || segment?.speaker_name) {
      return segment.speaker_name || segment.display_name || segment.speaker_label || '未知发言人';
    }
    return unresolvedConversationSpeakerLabel(segment) || '未识别发言人';
  }

  function conversationSegmentSpeakerKey(segment) {
    return conversationParticipantKey(segment);
  }

  function getFilteredConversationSegments(detail = state.selectedConversationDetail) {
    let rows = detail?.segments || [];
    if (state.selectedConversationSpeakerFilter) {
      rows = rows.filter((segment) => conversationSegmentSpeakerKey(segment) === state.selectedConversationSpeakerFilter);
    }
    if (state.selectedConversationStatusFilter) {
      rows = rows.filter((segment) => segmentStatusKey(segment) === state.selectedConversationStatusFilter);
    }
    if (state.hideShortConversationSegments) {
      rows = rows.filter((segment) => segmentStatusKey(segment) !== 'short');
    }
    return rows;
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

  function openMaterialDrawer() {
    state.materialDrawerOpen = true;
    qs('.material-panel').classList.add('open');
    qs('#material-drawer-backdrop').classList.add('open');
  }

  function closeMaterialDrawer() {
    state.materialDrawerOpen = false;
    qs('.material-panel').classList.remove('open');
    qs('#material-drawer-backdrop').classList.remove('open');
  }

  function setMaterialSpeakerMode(mode) {
    state.materialSpeakerMode = mode === 'new' ? 'new' : 'existing';
    document.querySelectorAll('[data-material-mode]').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-material-mode') === state.materialSpeakerMode);
    });
    qs('#material-existing-fields').classList.toggle('hidden', state.materialSpeakerMode !== 'existing');
    qs('#material-new-fields').classList.toggle('hidden', state.materialSpeakerMode !== 'new');
  }

  function resetMaterialDrawerFields() {
    setMaterialSpeakerMode('existing');
    const target = qs('#conversation-material-target');
    if (target) target.selectedIndex = 0;
    const newName = qs('#conversation-material-new-name');
    if (newName) newName.value = '';
    const newIdentity = qs('#conversation-material-new-identity');
    if (newIdentity) newIdentity.value = '';
    const newNote = qs('#conversation-material-new-note');
    if (newNote) newNote.value = '';
  }

  async function openSpeakerEditModal(speakerId) {
    if (!speakerId) return;
    state.selectedSpeakerId = speakerId;
    state.speakerEditModalOpen = true;
    qs('#speaker-edit-modal').classList.remove('hidden');
    await loadSpeakerDetail(speakerId);
  }

  function closeSpeakerEditModal() {
    state.speakerEditModalOpen = false;
    qs('#speaker-edit-modal').classList.add('hidden');
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
    qs('#conv-identity-label').innerHTML = `<option value="">身份：全部</option>${html}`;
    qs('#conversation-new-identity').innerHTML = `<option value="">未确认</option>${html}`;
    const materialNewIdentity = qs('#conversation-material-new-identity');
    if (materialNewIdentity) {
      materialNewIdentity.innerHTML = `<option value="">未确认</option>${html}`;
    }
  }

  function setConfirmedSpeakerOptions(speakers) {
    state.confirmedSpeakerOptions = Array.isArray(speakers) ? speakers : [];
    const optionsHtml = '<option value="">请选择已有发言人</option>' + state.confirmedSpeakerOptions.map((speaker) => `
      <option value="${escapeHtml(speaker.id)}">${escapeHtml(speaker.name || speaker.display_label || speaker.id)}</option>
    `).join('');
    qs('#conversation-existing-speaker').innerHTML = optionsHtml;
    const conversationSpeakerFilter = qs('#conv-speaker-filter');
    if (conversationSpeakerFilter) {
      conversationSpeakerFilter.innerHTML = '<option value="">正式发言人：全部</option>' + state.confirmedSpeakerOptions.map((speaker) => {
        const label = speaker.name || speaker.display_label || speaker.id;
        return `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`;
      }).join('');
    }
    const materialTarget = qs('#conversation-material-target');
    if (materialTarget) {
      materialTarget.innerHTML = state.confirmedSpeakerOptions.length
        ? state.confirmedSpeakerOptions.map((speaker) => `
          <option value="${escapeHtml(speaker.id)}">${escapeHtml(speaker.name || speaker.display_label || speaker.id)}${speaker.identity_label ? ` / ${escapeHtml(speaker.identity_label)}` : ''}</option>
        `).join('')
        : '<option value="">暂无正式发言人</option>';
    }
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
    qs('#speaker-list-count').textContent = `共 ${state.speakerPagination.total} 位`;
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
          <div class="speaker-list-row">
            <div class="speaker-list-avatar ${item.id === state.selectedSpeakerId ? 'is-active' : ''}">${escapeHtml((speakerDisplayName(item).trim()[0] || '?').toUpperCase())}</div>
            <div class="speaker-list-main">
              <strong>${highlightText(speakerDisplayName(item), keyword)}</strong>
              <span class="subtle">${highlightText(item.identity_label || '身份未确认', keyword)}</span>
            </div>
            <div class="speaker-list-meta subtle">
              <button type="button" class="inline-action compact-action secondary-button" data-edit-speaker="${escapeHtml(item.id)}">编辑</button>
            </div>
          </div>
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
    listEl.querySelectorAll('[data-edit-speaker]').forEach((node) => {
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        openSpeakerEditModal(node.getAttribute('data-edit-speaker')).catch(showError);
      });
    });
  }

  function resetSpeakerDetail() {
    state.selectedSpeakerDetail = null;
    state.speakerMaterialDraft = null;
    clearSpeakerPreviewPlayback();
    qs('#speaker-empty').classList.remove('hidden');
    qs('#speaker-detail').classList.add('hidden');
    closeSpeakerEditModal();
  }

  async function loadSpeakers(resetPage) {
    if (resetPage) state.speakerPagination.page = 1;
    const params = new URLSearchParams();
    const q = qs('#speaker-q').value.trim();
    const confirmation = qs('#speaker-confirmation').value || 'confirmed';
    const pageSize = Number(qs('#speaker-page-size').value || '20');

    if (q) params.set('q', q);
    params.set('confirmation', confirmation);
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
    state.selectedSpeakerDetail = detail;
    initializeSpeakerMaterialDraft(detail);
    qs('#speaker-empty').classList.add('hidden');
    qs('#speaker-detail').classList.remove('hidden');
    qs('#speaker-detail-title').textContent = speakerDisplayName(detail.speaker);
    qs('#speaker-form-name').value = detail.speaker.name || '';
    qs('#speaker-form-identity').value = detail.speaker.identity_label || '';
    qs('#speaker-form-notes').value = detail.speaker.notes || '';
    qs('#speaker-edit-modal-title').textContent = `编辑 ${speakerDisplayName(detail.speaker)}`;
    qs('#speaker-confirm-summary').innerHTML = `
      <span><strong>身份</strong>${escapeHtml(detail.speaker.identity_label || '未确认')}</span>
      <span><strong>备注</strong>${escapeHtml(detail.speaker.notes || '无')}</span>
      <span><strong>说明</strong>当前优先管理正式语料与候选语料，基础信息单独保存。</span>
    `;
    const preview = qs('#speaker-material-preview-player');
    if (preview) {
      preview.classList.add('hidden');
      preview.innerHTML = '';
    }

    renderSpeakerMaterials();
  }

  function renderSpeakerMaterials() {
    const draft = state.speakerMaterialDraft;
    if (!draft) return;
    const summary = summarizeSpeakerMaterialDraft(draft);
    qs('#speaker-formal-title').textContent = `正式语料 ${summary.formalItems.length}`;
    qs('#speaker-candidate-title').textContent = `候选语料 ${summary.candidateItems.length}`;

    const renderItem = (item, mode) => {
      const durationText = formatSegmentSeconds(Math.max(0, Number(item.end_ms || 0) - Number(item.start_ms || 0)));
      const metaText = mode === 'formal'
        ? `${durationText} · ${Math.max(0, Number(item.text?.length || 0))} 字`
        : `${durationText} · 命中 ${formatScore(item.voiceprint_top_score)}`;
      return `
      <article class="segment-item speaker-material-item compact-material-item">
        <span class="speaker-material-speaker" title="${escapeHtml(materialSegmentLabel(item))}">${escapeHtml(materialSegmentLabel(item))}</span>
        <span class="speaker-material-time" title="${escapeHtml(`${formatDate(item.started_at)} · ${materialTimeLabel(item)}`)}">${escapeHtml(formatDate(item.started_at))} · ${escapeHtml(materialTimeLabel(item))}</span>
        <span class="speaker-material-text" title="${escapeHtml(item.text || '暂无转录文本')}">${escapeHtml(item.text || '暂无转录文本')}</span>
        <span class="speaker-material-meta">${escapeHtml(metaText)}</span>
        <span class="badge ${segmentStatusMeta(item).className || 'neutral'}">${escapeHtml(segmentStatusMeta(item).label)}</span>
        <div class="speaker-material-actions">
          ${mode === 'formal'
            ? `<button type="button" class="inline-action secondary-button" data-speaker-material-play="${escapeHtml(item.id)}">试听</button><button type="button" class="inline-action secondary-button" data-speaker-material-demote="${escapeHtml(item.id)}">候选</button><button type="button" class="inline-action secondary-button" data-speaker-material-remove="${escapeHtml(item.id)}">移除</button>`
            : `<button type="button" class="inline-action secondary-button" data-speaker-material-play="${escapeHtml(item.id)}">试听</button><button type="button" data-speaker-material-promote="${escapeHtml(item.id)}">正式</button><button type="button" class="inline-action secondary-button" data-speaker-material-remove="${escapeHtml(item.id)}">移除</button>`}
        </div>
      </article>
    `;
    };

    qs('#speaker-formal-materials').innerHTML = summary.formalItems.length
      ? summary.formalItems.map((item) => renderItem(item, 'formal')).join('')
      : '<p class="subtle">暂无正式语料。可以先从右侧候选语料中转入。</p>';
    qs('#speaker-candidate-materials').innerHTML = summary.candidateItems.length
      ? summary.candidateItems.map((item) => renderItem(item, 'candidate')).join('')
      : '<p class="subtle">暂无候选语料。可以先到对话记录页勾选片段加入候选语料。</p>';

    document.querySelectorAll('[data-speaker-material-play]').forEach((node) => {
      node.addEventListener('click', () => {
        const id = node.getAttribute('data-speaker-material-play');
        const item = draft.items.find((entry) => entry.id === id);
        if (!item) return;
        playSpeakerMaterial(item);
      });
    });
    document.querySelectorAll('[data-speaker-material-promote]').forEach((node) => {
      node.addEventListener('click', () => {
        moveSpeakerMaterial(node.getAttribute('data-speaker-material-promote'), 'formal').catch(showError);
      });
    });
    document.querySelectorAll('[data-speaker-material-demote]').forEach((node) => {
      node.addEventListener('click', () => {
        moveSpeakerMaterial(node.getAttribute('data-speaker-material-demote'), 'candidate').catch(showError);
      });
    });
    document.querySelectorAll('[data-speaker-material-remove]').forEach((node) => {
      node.addEventListener('click', () => {
        removeSpeakerMaterial(node.getAttribute('data-speaker-material-remove')).catch(showError);
      });
    });
  }

  async function loadSpeakerDetail(speakerId) {
    if (!speakerId) return;
    const result = await apiGet(`/api/admin/speakers/${encodeURIComponent(speakerId)}/voiceprint/materials`);
    renderSpeakerDetail(result.data);
  }

  async function saveSpeakerMaterials() {
    if (!state.selectedSpeakerId) {
      throw new Error('请先选择正式发言人');
    }
    const result = await apiSend(`/api/admin/speakers/${encodeURIComponent(state.selectedSpeakerId)}/voiceprint/xfyun/sync`, 'POST', {});
    window.alert(`讯飞声纹已更新：${result.data.action}，正式语料 ${result.data.processedSegmentCount} 段，音频 ${formatSegmentSeconds(result.data.durationMs || 0)}。`);
    await loadSpeakerDetail(state.selectedSpeakerId);
    await loadConfirmedSpeakerOptions();
  }

  async function previewSpeakerMaterials() {
    if (!state.selectedSpeakerId) {
      throw new Error('请先选择正式发言人');
    }
    const result = await apiSend(`/api/admin/speakers/${encodeURIComponent(state.selectedSpeakerId)}/voiceprint/xfyun/preview`, 'POST', {});
    const preview = qs('#speaker-material-preview-player');
    preview.classList.remove('hidden');
    preview.innerHTML = `
      <span class="subtle">试听音频 · ${escapeHtml(formatSegmentSeconds(result.data.durationMs || 0))} · ${escapeHtml(String(result.data.segmentCount || 0))} 段</span>
      <audio controls src="${escapeHtml(result.data.audioUrl || '')}"></audio>
    `;
  }

  function renderConversationPagination() {
    qs('#conversation-pagination').textContent = `第 ${state.conversationPagination.page} / ${state.conversationPagination.totalPages} 页`;
    qs('#conv-prev-page').disabled = state.conversationPagination.page <= 1;
    qs('#conv-next-page').disabled = state.conversationPagination.page >= state.conversationPagination.totalPages;
  }

  function renderConversationList() {
    const keyword = qs('#conv-keyword').value.trim();
    const listEl = qs('#conversation-list');
    renderConversationPagination();
    listEl.innerHTML = state.conversations.length
      ? state.conversations.map((item) => {
        const statusMeta = conversationStatusMeta(item);
        const errorText = item.status === 'failed' ? formatConversationError(item.error_message) : '';
        return `
          <article class="list-item ${item.id === state.selectedConversationId ? 'active' : ''}" data-conversation-id="${item.id}">
            <div class="list-item-title">
              <span>${escapeHtml(formatListDate(item.started_at))}</span>
              <span class="badge ${statusMeta.className}">${escapeHtml(statusMeta.label)}</span>
            </div>
            <p class="conversation-list-stats">发言人 ${item.speaker_count} · 片段 ${item.segment_count} · ${escapeHtml(conversationListIssueLabel(item))}</p>
            ${errorText ? `<p class="subtle danger-text">失败原因：${escapeHtml(errorText)}</p>` : ''}
            <p class="conversation-list-preview">${highlightText(item.summary_text || '暂无摘要', keyword)}</p>
          </article>
        `;
      }).join('')
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

  function formatListDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return formatDate(value);
    return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function clearConversationPlaybackTimer() {
    if (conversationPlaybackStopTimer) {
      window.clearTimeout(conversationPlaybackStopTimer);
      conversationPlaybackStopTimer = null;
    }
  }

  function conversationParticipantKey(segment) {
    if (segment?.speaker_id) return `speaker:${segment.speaker_id}`;
    const label = segment?.original_speaker_label || segment?.speaker_label || segment?.voiceprint_top_speaker_id || 'unknown';
    return `label:${label}`;
  }

  function conversationParticipantName(segment) {
    if (segment?.speaker_id || segment?.speaker_name) {
      return segment?.speaker_name
        || segment?.display_name
        || segment?.voiceprint_top_speaker_name
        || unresolvedConversationSpeakerLabel(segment)
        || '未知发言人';
    }
    return unresolvedConversationSpeakerLabel(segment) || '未识别发言人';
  }

  function conversationParticipantMeta(card) {
    return card.confirmedCount === card.count && card.count > 0
      ? `${card.count}段 · 已实名`
      : `${card.count}段 · 未识别`;
  }

  function buildConversationSpeakerCards(detail) {
    const cards = new Map();
    (detail.segments || []).forEach((segment) => {
      const key = conversationParticipantKey(segment);
      const statusKey = segmentStatusKey(segment);
      const existing = cards.get(key) || {
        key,
        name: conversationParticipantName(segment),
        identity: segment.speaker_identity || '',
        count: 0,
        confirmedCount: 0,
        lowCount: 0,
        errorCount: 0,
      };
      existing.count += 1;
      existing.confirmedCount += statusKey === 'confirmed' ? 1 : 0;
      existing.lowCount += statusKey === 'low' ? 1 : 0;
      existing.errorCount += statusKey === 'error' ? 1 : 0;
      cards.set(key, existing);
    });

    (detail.speakers || []).forEach((speaker) => {
      const key = speaker.speaker_id ? `speaker:${speaker.speaker_id}` : `label:${speaker.speaker_label || 'unknown'}`;
      const existing = cards.get(key);
      if (existing) {
        existing.name = speaker.speaker_id
          ? (speaker.display_name || speaker.speaker_name || existing.name)
          : (formatRawSpeakerLabel(speaker.speaker_label) || existing.name);
        existing.identity = speaker.identity_label || existing.identity;
        existing.count = Math.max(existing.count, Number(speaker.segment_count || 0));
        if (speaker.is_confirmed) existing.confirmedCount = Math.max(existing.confirmedCount, existing.count);
        return;
      }
      cards.set(key, {
        key,
        name: speaker.speaker_id
          ? (speaker.display_name || speaker.speaker_name || '未知发言人')
          : (formatRawSpeakerLabel(speaker.speaker_label) || '未识别发言人'),
        identity: speaker.identity_label || '',
        count: Number(speaker.segment_count || 0),
        confirmedCount: speaker.is_confirmed ? Number(speaker.segment_count || 0) : 0,
        lowCount: 0,
        errorCount: 0,
      });
    });

    return [...cards.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
  }

  function playConversationSegment(segment) {
    const player = qs('#conversation-audio-player');
    if (!player || !player.getAttribute('src')) {
      throw new Error('当前会话没有可播放音频');
    }

    const rawStartMs = Math.max(0, Number(segment.start_ms || 0));
    const rawEndMs = Math.max(rawStartMs, Number(segment.end_ms || 0));
    const startSec = Math.max(0, (rawStartMs + conversationPlaybackStartOffsetMs) / 1000);
    const endSec = Math.max(
      startSec,
      (rawEndMs + conversationPlaybackStartOffsetMs + conversationPlaybackEndPaddingMs) / 1000,
    );
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
    const shortCount = selected.filter((segment) => segmentStatusKey(segment) === 'short').length;
    qs('#conversation-selected-count').textContent = String(selected.length);
    qs('#conversation-selected-duration').textContent = `${(selectedDurationMs / 1000).toFixed(1)}s`;
    qs('#conversation-selected-labels').textContent = labels.length ? labels.join(', ') : '-';
    const toolbarCount = qs('#conversation-toolbar-selected-count');
    const toolbarDuration = qs('#conversation-toolbar-selected-duration');
    const excludedShort = qs('#conversation-excluded-short-count');
    const preview = qs('#conversation-selected-preview');
    if (toolbarCount) toolbarCount.textContent = String(selected.length);
    if (toolbarDuration) toolbarDuration.textContent = `${(selectedDurationMs / 1000).toFixed(1)}s`;
    if (excludedShort) excludedShort.textContent = String(shortCount);
    if (preview) {
      preview.innerHTML = selected.length
        ? selected.slice(0, 3).map((segment) => `<p>${escapeHtml(segment.text || '无文本')}</p>`).join('')
        : '尚未选择片段。';
    }
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
    const speakerCards = buildConversationSpeakerCards(detail);
    const visibleCards = speakerCards.slice(0, 4);
    qs('#conversation-speakers').innerHTML = visibleCards.length
      ? visibleCards.map((speaker) => {
        const isActive = state.selectedConversationSpeakerFilter === speaker.key;
        const meta = conversationParticipantMeta(speaker);
        const identity = speaker.identity ? `/${speaker.identity}` : '';
        return `
          <article class="speaker-summary-item ${isActive ? 'active' : ''}" data-conversation-speaker-filter="${escapeHtml(speaker.key)}">
            <div class="speaker-summary-main">
              <strong>${escapeHtml(`${speaker.name}${identity}`)}</strong>
              <span class="subtle ${speaker.errorCount ? 'danger-text' : ''}">${escapeHtml(meta)}</span>
            </div>
          </article>
        `;
      }).join('')
      : '<p class="subtle">暂无参与者信息。</p>';

    const overflow = Math.max(0, speakerCards.length - visibleCards.length);
    const clearButton = qs('#conversation-clear-speaker-filter');
    if (clearButton) {
      clearButton.textContent = overflow ? `+${overflow}` : '+0';
      clearButton.classList.toggle('hidden', overflow === 0 && !state.selectedConversationSpeakerFilter);
    }

    qs('#conversation-speakers').querySelectorAll('[data-conversation-speaker-filter]').forEach((node) => {
      node.addEventListener('click', () => {
        state.selectedConversationSpeakerFilter = node.getAttribute('data-conversation-speaker-filter') || null;
        state.conversationSegmentPagination.page = 1;
        renderConversationSpeakerFilter(detail);
        renderConversationSpeakerSummary(detail);
        renderConversationTranscript(detail);
      });
    });
  }

  function renderConversationSpeakerFilter(detail) {
    const select = qs('#conversation-segment-speaker-filter');
    const options = buildConversationSpeakerCards(detail).map((speaker) => {
      const label = `${speaker.name} · ${speaker.count} 段`;
      return `<option value="${escapeHtml(speaker.key)}">${escapeHtml(label)}</option>`;
    }).join('');
    select.innerHTML = `<option value="">全部发言人</option>${options}`;
    select.value = state.selectedConversationSpeakerFilter || '';
  }

  function renderConversationDetailBadges(detail) {
    const segments = detail.segments || [];
    const counts = segments.reduce((acc, segment) => {
      const key = segmentStatusKey(segment);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const badges = [
      { label: `低置信 ${counts.low || 0}`, className: 'warning' },
      { label: `已实名 ${counts.confirmed || 0}`, className: '' },
      { label: `未命中 ${counts.no_match || 0}`, className: 'neutral' },
      { label: `错误 ${counts.error || 0}`, className: 'danger' },
    ];
    const target = qs('#conversation-detail-badges');
    if (target) {
      target.innerHTML = badges.map((badge) => `<span class="badge ${badge.className}">${escapeHtml(badge.label)}</span>`).join('');
    }
  }

  function renderConversationTranscript(detail) {
    const keyword = qs('#conv-keyword').value.trim();
    const rows = getFilteredConversationSegments(detail);
    state.conversationSegmentPagination = {
      page: 1,
      pageSize: rows.length || 1,
      total: rows.length,
      totalPages: 1,
    };
    const pageRows = rows;
    qs('#conversation-segment-pagination').textContent = '';
    qs('#conversation-segment-prev-page').disabled = true;
    qs('#conversation-segment-next-page').disabled = true;

    qs('#conversation-segments').innerHTML = pageRows.length
      ? pageRows.map((segment) => {
        const checked = state.selectedSegmentIds.has(segment.id) ? 'checked' : '';
        const displaySpeaker = conversationDisplaySpeaker(segment);
        const timeMeta = formatAbsoluteTimeMeta(segment.absolute_start_time, segment.absolute_end_time);
        const statusMeta = segmentStatusMeta(segment);
        const statusKey = segmentStatusKey(segment);
        const materialMeta = materialUsageMeta(segment);
        const speakerAction = segment.speaker_id
          ? `<button type="button" class="inline-action compact-action secondary-button" data-go-speaker="${escapeHtml(segment.speaker_id)}">查看发言人</button>`
          : '';
        return `
          <article class="transcript-row status-${escapeHtml(statusKey)}" data-conversation-segment-id="${escapeHtml(segment.id)}">
            <label class="voiceprint-check transcript-select">
              <input type="checkbox" data-conversation-segment-select ${checked} />
              <span class="sr-only">选择片段</span>
            </label>
            <div class="transcript-time">
              <span class="transcript-relative-range">${escapeHtml(formatSegmentClock(segment.start_ms))} - ${escapeHtml(formatSegmentClock(segment.end_ms))}</span>
              <div class="subtle transcript-absolute-range">${escapeHtml(timeMeta.rangeLabel)}</div>
            </div>
            <div class="transcript-speaker">
              <strong>${escapeHtml(displaySpeaker)}</strong>
              ${segment.speaker_identity ? `<span class="subtle">${escapeHtml(segment.speaker_identity)}</span>` : ''}
            </div>
            <div class="transcript-text">
              <div class="transcript-text-content">${highlightText(segment.text, keyword)}</div>
            </div>
            <div class="transcript-actions">
              <div class="transcript-action-row">
                <span class="transcript-status-text ${statusMeta.className}">${escapeHtml(statusMeta.label)}</span>
                <span class="transcript-material-text ${materialMeta.className}">${escapeHtml(materialMeta.label)}</span>
                <button type="button" class="inline-action compact-action secondary-button" data-play-segment="${escapeHtml(segment.id)}">试听</button>
                ${speakerAction}
              </div>
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
    const errorBanner = qs('#conversation-error-banner');
    if (errorBanner) {
      errorBanner.classList.add('hidden');
      errorBanner.textContent = '';
    }
    const player = qs('#conversation-audio-player');
    clearConversationPlaybackTimer();
    player.pause();
    player.removeAttribute('src');
    player.classList.add('hidden');
    qs('#conversation-audio-empty').classList.remove('hidden');
    state.selectedConversationDetail = null;
    state.selectedConversationSpeakerFilter = null;
    state.selectedConversationStatusFilter = '';
    state.hideShortConversationSegments = false;
    state.conversationSegmentPagination.page = 1;
    state.selectedSegmentIds.clear();
    updateConversationSelectionSummary(null);
  }

  async function loadConversations(resetPage) {
    if (resetPage) state.conversationPagination.page = 1;
    const params = new URLSearchParams();
    const identityLabel = qs('#conv-identity-label').value;
    const speakerName = qs('#conv-speaker-filter').value;
    const keyword = qs('#conv-keyword').value.trim();
    const status = qs('#conv-status').value;
    const start = qs('#conv-start').value;
    const end = qs('#conv-end').value;
    const pageSize = Number(qs('#conv-page-size').value || '20');

    if (identityLabel) params.set('identity_label', identityLabel);
    if (speakerName) params.set('speaker_name', speakerName);
    if (keyword) params.set('keyword', keyword);
    if (status) params.set('status', status);
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
    if (qs('#conversation-segment-speaker-filter').value !== (state.selectedConversationSpeakerFilter || '')) {
      state.conversationSegmentPagination.page = 1;
    }
    qs('#conversation-empty').classList.add('hidden');
    qs('#conversation-detail').classList.remove('hidden');
    qs('#conversation-title').textContent = detail.conversation.id;
    const dateLabel = qs('#conversation-date-label');
    if (dateLabel) {
      const started = detail.conversation.started_at ? new Date(detail.conversation.started_at) : null;
      dateLabel.textContent = started && !Number.isNaN(started.getTime())
        ? `${started.getFullYear()}/${String(started.getMonth() + 1).padStart(2, '0')}/${String(started.getDate()).padStart(2, '0')}`
        : '-';
    }
    qs('#conversation-session-id').textContent = detail.conversation.session_id;
    qs('#conversation-status').textContent = conversationStatusMeta(detail.conversation).label;
    qs('#conversation-started-at').textContent = formatDate(detail.conversation.started_at);
    qs('#conversation-ended-at').textContent = formatDate(detail.conversation.ended_at);
    qs('#conversation-speaker-count').textContent = detail.conversation.speaker_count;
    qs('#conversation-segment-count').textContent = detail.conversation.segment_count;
    const errorBanner = qs('#conversation-error-banner');
    const errorText = detail.conversation.status === 'failed' ? formatConversationError(detail.conversation.error_message) : '';
    if (errorBanner) {
      errorBanner.textContent = errorText ? `失败原因：${errorText}` : '';
      errorBanner.classList.toggle('hidden', !errorText);
    }

    const audioPlayer = qs('#conversation-audio-player');
    const audioEmpty = qs('#conversation-audio-empty');
    if (detail.conversation.audio_file_url) {
      audioPlayer.src = detail.conversation.audio_file_url;
      audioPlayer.classList.remove('hidden');
      audioEmpty.classList.add('hidden');
    } else {
      audioPlayer.pause();
      audioPlayer.removeAttribute('src');
      audioPlayer.classList.add('hidden');
      audioEmpty.classList.remove('hidden');
    }

    renderConversationSpeakerSummary(detail);
    renderConversationSpeakerFilter(detail);
    renderConversationDetailBadges(detail);
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

  async function enrollFromMaterialDrawer() {
    if (!state.selectedConversationId) {
      throw new Error('请先选择会话');
    }
    const selectedIds = [...state.selectedSegmentIds];
    if (!selectedIds.length) {
      throw new Error('请先勾选至少一个片段');
    }

    const speakerMode = state.materialSpeakerMode === 'new' ? 'new' : 'existing';
    const body = {
      segmentIds: selectedIds,
      materialStatus: 'candidate',
      speakerId: speakerMode === 'existing' ? (qs('#conversation-material-target').value || null) : null,
      speakerName: speakerMode === 'new' ? qs('#conversation-material-new-name').value.trim() : null,
      identityLabel: speakerMode === 'new' ? (qs('#conversation-material-new-identity').value || null) : null,
      notes: speakerMode === 'new' ? (qs('#conversation-material-new-note').value.trim() || null) : null,
    };

    if (speakerMode === 'existing' && !body.speakerId) {
      throw new Error('请选择正式发言人');
    }
    if (speakerMode === 'new' && !body.speakerName) {
      throw new Error('请输入新发言人姓名');
    }

    const button = qs('#conversation-confirm-material');
    button.disabled = true;
    let result;
    try {
      result = speakerMode === 'existing'
        ? await apiSend(`/api/admin/speakers/${encodeURIComponent(body.speakerId)}/voiceprint/materials`, 'POST', {
          segmentIds: selectedIds,
          materialStatus: 'candidate',
          source: 'conversation_selection',
        })
        : await apiSend('/api/admin/voiceprint/speakers', 'POST', body);
    } finally {
      button.disabled = false;
    }

    state.selectedSegmentIds.clear();
    closeMaterialDrawer();
    resetMaterialDrawerFields();
    await loadConversationDetail(state.selectedConversationId);
    await loadConversations(false);
    await loadSpeakers(false);
    await loadConfirmedSpeakerOptions();
    window.alert(`已加入候选语料：${selectedIds.length} 条。`);
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
        limit: 80,
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
    window.alert(`本批重刷完成：自动命中 ${result.data.hit}，低置信 ${result.data.lowConfidence}，冲突 ${result.data.conflict}，未命中 ${result.data.noMatch}，跳过 ${result.data.skipped}，错误 ${result.data.error}`);
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
      window.alert(`OMI 记忆同步完成：导入 ${result.data.inserted}，合并 ${result.data.merged}，总量 ${result.data.totalActive}`);
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
    const title = qs('#app-title');
    const subtitle = qs('#app-subtitle');
    if (title && subtitle) {
      if (tabName === 'directory') {
        title.textContent = 'OMI Speaker Admin';
        subtitle.textContent = '基础信息 · 声纹语料 · 更新讯飞';
      } else {
        title.textContent = 'OMI Speaker Admin';
        subtitle.textContent = tabName === 'systems' ? '系统工具 · 记忆同步与补充' : '转录核对 · 声纹语料工作台';
      }
    }
  }

  function showError(err) {
    window.alert(err?.message || String(err));
  }

  function bindEvents() {
    document.querySelectorAll('.tab-button').forEach((button) => {
      button.addEventListener('click', () => switchTab(button.getAttribute('data-tab')));
    });

    qs('#conv-search').addEventListener('click', () => loadConversations(true).catch(showError));
    qs('#conv-keyword').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        loadConversations(true).catch(showError);
      }
    });
    qs('#conv-speaker-filter').addEventListener('change', () => loadConversations(true).catch(showError));
    qs('#conv-identity-label').addEventListener('change', () => loadConversations(true).catch(showError));
    qs('#conv-status').addEventListener('change', () => loadConversations(true).catch(showError));
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
      state.conversationSegmentPagination.page = 1;
      if (state.selectedConversationDetail) {
        renderConversationSpeakerFilter(state.selectedConversationDetail);
        renderConversationSpeakerSummary(state.selectedConversationDetail);
        renderConversationTranscript(state.selectedConversationDetail);
      }
    });
    qs('#conversation-segment-speaker-filter').addEventListener('change', () => {
      state.selectedConversationSpeakerFilter = qs('#conversation-segment-speaker-filter').value || null;
      state.conversationSegmentPagination.page = 1;
      if (state.selectedConversationDetail) {
        renderConversationSpeakerSummary(state.selectedConversationDetail);
        renderConversationTranscript(state.selectedConversationDetail);
      }
    });
    qs('#conversation-segment-status-filter').addEventListener('change', () => {
      state.selectedConversationStatusFilter = qs('#conversation-segment-status-filter').value || '';
      state.conversationSegmentPagination.page = 1;
      if (state.selectedConversationDetail) {
        renderConversationTranscript(state.selectedConversationDetail);
      }
    });
    qs('#conversation-hide-short').addEventListener('change', () => {
      state.hideShortConversationSegments = qs('#conversation-hide-short').checked;
      state.conversationSegmentPagination.page = 1;
      if (state.selectedConversationDetail) {
        renderConversationTranscript(state.selectedConversationDetail);
      }
    });
    qs('#conversation-segment-page-size').addEventListener('change', () => {
      state.conversationSegmentPagination.page = 1;
      if (state.selectedConversationDetail) {
        renderConversationTranscript(state.selectedConversationDetail);
      }
    });
    qs('#conversation-segment-prev-page').addEventListener('click', () => {
      if (state.conversationSegmentPagination.page <= 1) return;
      state.conversationSegmentPagination.page -= 1;
      if (state.selectedConversationDetail) renderConversationTranscript(state.selectedConversationDetail);
    });
    qs('#conversation-segment-next-page').addEventListener('click', () => {
      if (state.conversationSegmentPagination.page >= state.conversationSegmentPagination.totalPages) return;
      state.conversationSegmentPagination.page += 1;
      if (state.selectedConversationDetail) renderConversationTranscript(state.selectedConversationDetail);
    });
    qs('#conversation-open-modal').addEventListener('click', () => {
      openMaterialDrawer();
    });
    qs('#conversation-confirm-material').addEventListener('click', () => {
      enrollFromMaterialDrawer().catch(showError);
    });
    qs('#material-drawer-close').addEventListener('click', () => closeMaterialDrawer());
    qs('#material-drawer-backdrop').addEventListener('click', () => closeMaterialDrawer());
    document.querySelectorAll('[data-material-mode]').forEach((button) => {
      button.addEventListener('click', () => setMaterialSpeakerMode(button.getAttribute('data-material-mode')));
    });
    qs('#speaker-modal-close').addEventListener('click', () => closeSpeakerModal());
    qs('#speaker-modal').addEventListener('click', (event) => {
      if (event.target === qs('#speaker-modal')) {
        closeSpeakerModal();
      }
    });
    qs('#speaker-edit-modal-close').addEventListener('click', () => closeSpeakerEditModal());
    qs('#speaker-edit-modal').addEventListener('click', (event) => {
      if (event.target === qs('#speaker-edit-modal')) {
        closeSpeakerEditModal();
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
    qs('#speaker-detail-edit').addEventListener('click', () => {
      if (!state.selectedSpeakerId) return;
      openSpeakerEditModal(state.selectedSpeakerId).catch(showError);
    });
    qs('#speaker-material-save').addEventListener('click', () => saveSpeakerMaterials().catch(showError));
    qs('#speaker-material-preview').addEventListener('click', () => previewSpeakerMaterials().catch(showError));
    qs('#speaker-candidate-promote-all').addEventListener('click', () => promoteAllCandidateMaterials().catch(showError));
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
    qs('#speaker-edit-cancel').addEventListener('click', () => {
      closeSpeakerEditModal();
    });
    qs('#speaker-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!state.selectedSpeakerId) return;
      await apiSend(`/api/speakers/${state.selectedSpeakerId}`, 'PATCH', {
        name: qs('#speaker-form-name').value,
        identityLabel: qs('#speaker-form-identity').value || null,
        notes: qs('#speaker-form-notes').value,
      });
      closeSpeakerEditModal();
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
