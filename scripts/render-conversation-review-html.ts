import * as fs from 'fs/promises';
import * as path from 'path';

interface ReviewRow {
  id: string;
  index: number;
  start_ms: number;
  end_ms: number;
  absolute_start_time: string | null;
  original_speaker_label: string | null;
  final_speaker_label: string | null;
  semantic_speaker_label: string | null;
  overlap_ratio: number | null;
  text: string;
  display_name: string;
  suspicious: boolean;
  reasons: string[];
  prev_speaker_label: string | null;
  next_speaker_label: string | null;
}

interface ReviewFile {
  generated_at: string;
  conversation_id: string;
  session_id: string;
  speaker_count: number;
  segment_count: number;
  rows: ReviewRow[];
}

function parseArgs(): { input: string; output: string; title: string } {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (key?.startsWith('--') && value) {
      args.set(key.slice(2), value);
    }
  }

  const input = args.get('input');
  if (!input) {
    throw new Error('missing required arg --input');
  }

  return {
    input: path.resolve(input),
    output: path.resolve(args.get('output') || path.join(process.cwd(), 'public', 'preview', 'conversation-review.html')),
    title: args.get('title') || 'Conversation Review',
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function buildHtml(data: ReviewFile, title: string): string {
  const speakerOptions = [...new Set(data.rows.flatMap(row => {
    return [row.original_speaker_label, row.final_speaker_label, row.semantic_speaker_label].filter(Boolean) as string[];
  }))].sort();

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f4f6f8;
      --panel: #ffffff;
      --line: rgba(24, 35, 44, 0.12);
      --ink: #1b2730;
      --muted: #64717b;
      --accent: #0f8b6d;
      --warning: #d97a00;
      --danger: #c44536;
      --soft: rgba(15, 139, 109, 0.08);
      --warning-soft: rgba(217, 122, 0, 0.08);
      --danger-soft: rgba(196, 69, 54, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "PingFang SC", "Noto Sans SC", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    .shell {
      width: min(1500px, calc(100vw - 24px));
      margin: 12px auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      overflow: hidden;
    }
    header {
      padding: 18px 20px 14px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(15, 139, 109, 0.06), rgba(255,255,255,1));
    }
    h1 { margin: 0 0 8px; font-size: 26px; }
    .subtle { color: var(--muted); font-size: 13px; }
    .chips {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 600;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      padding: 14px 20px;
      border-bottom: 1px solid var(--line);
      background: rgba(248, 250, 252, 0.9);
    }
    .toolbar label {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      font-size: 13px;
      color: var(--muted);
    }
    button, select {
      font: inherit;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 8px 12px;
      cursor: pointer;
      background: var(--accent);
      color: white;
    }
    button.secondary {
      background: transparent;
      color: var(--accent);
      border: 1px solid rgba(15, 139, 109, 0.22);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #f8fafc;
      border-bottom: 1px solid var(--line);
      padding: 10px 8px;
      text-align: left;
      font-size: 12px;
      color: var(--muted);
    }
    tbody td {
      padding: 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      font-size: 13px;
    }
    tbody tr.suspicious {
      background: var(--warning-soft);
    }
    tbody tr.semantic-change {
      box-shadow: inset 3px 0 0 var(--warning);
    }
    .text {
      line-height: 1.5;
      white-space: normal;
      word-break: break-word;
    }
    .reason-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .reason {
      border-radius: 999px;
      padding: 2px 6px;
      background: var(--warning-soft);
      color: var(--warning);
      font-size: 11px;
    }
    .status-controls {
      display: grid;
      gap: 4px;
    }
    .status-select, .speaker-select {
      width: 100%;
      padding: 6px 8px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: white;
    }
    .stats {
      margin-left: auto;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .stat {
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(24, 35, 44, 0.05);
      font-size: 12px;
    }
    .danger {
      color: var(--danger);
    }
    .container {
      max-height: calc(100vh - 180px);
      overflow: auto;
    }
    @media (max-width: 1000px) {
      .shell {
        width: calc(100vw - 12px);
        margin: 6px auto;
      }
      table, thead, tbody, th, td, tr {
        display: block;
      }
      thead {
        display: none;
      }
      tbody tr {
        border-bottom: 1px solid var(--line);
        padding: 10px 12px;
      }
      tbody td {
        border: 0;
        padding: 4px 0;
      }
      tbody td::before {
        content: attr(data-label);
        display: block;
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 2px;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <h1>${escapeHtml(title)}</h1>
      <div class="subtle">conversation: ${escapeHtml(data.conversation_id)} | session: ${escapeHtml(data.session_id)} | generated: ${escapeHtml(data.generated_at)}</div>
      <div class="chips">
        <span class="chip">segments ${data.segment_count}</span>
        <span class="chip">speakers ${data.speaker_count}</span>
        <span class="chip">review page with local export</span>
      </div>
    </header>
    <section class="toolbar">
      <label><input id="show-suspicious" type="checkbox" checked /> 仅看可疑段</label>
      <label><input id="show-semantic-change" type="checkbox" /> 仅看语义建议变更</label>
      <button id="mark-visible-correct" class="secondary">当前筛选全部标为正确</button>
      <button id="export-json">导出标注 JSON</button>
      <div class="stats">
        <span class="stat" id="stat-total">总数 0</span>
        <span class="stat" id="stat-visible">可见 0</span>
        <span class="stat" id="stat-reviewed">已标 0</span>
        <span class="stat" id="stat-correct">正确 0</span>
        <span class="stat danger" id="stat-wrong">错误 0</span>
      </div>
    </section>
    <section class="container">
      <table>
        <thead>
          <tr>
            <th style="width:56px">#</th>
            <th style="width:100px">时间</th>
            <th style="width:110px">原始</th>
            <th style="width:110px">阶段一</th>
            <th style="width:110px">语义建议</th>
            <th>文本</th>
            <th style="width:180px">可疑原因</th>
            <th style="width:150px">你的判定</th>
            <th style="width:150px">人工归属</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </section>
  </main>
  <script>
    const DATA = ${JSON.stringify(data)};
    const SPEAKER_OPTIONS = ${JSON.stringify(speakerOptions)};
    const STORAGE_KEY = 'conversation-review:' + DATA.conversation_id;

    function loadState() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      } catch {
        return {};
      }
    }

    function saveState(state) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    const state = loadState();

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function rowState(id) {
      return state[id] || { verdict: '', manualSpeaker: '' };
    }

    function setRowState(id, patch) {
      state[id] = { ...rowState(id), ...patch };
      saveState(state);
      render();
    }

    function shouldShowRow(row) {
      const suspiciousOnly = document.getElementById('show-suspicious').checked;
      const semanticChangeOnly = document.getElementById('show-semantic-change').checked;
      if (suspiciousOnly && !row.suspicious) return false;
      if (semanticChangeOnly && row.semantic_speaker_label === row.final_speaker_label) return false;
      return true;
    }

    function stats(visibleRows) {
      const values = visibleRows.map(row => rowState(row.id));
      const reviewed = values.filter(value => value.verdict).length;
      const correct = values.filter(value => value.verdict === 'correct').length;
      const wrong = values.filter(value => value.verdict === 'wrong').length;
      document.getElementById('stat-total').textContent = '总数 ' + DATA.rows.length;
      document.getElementById('stat-visible').textContent = '可见 ' + visibleRows.length;
      document.getElementById('stat-reviewed').textContent = '已标 ' + reviewed;
      document.getElementById('stat-correct').textContent = '正确 ' + correct;
      document.getElementById('stat-wrong').textContent = '错误 ' + wrong;
    }

    function render() {
      const rows = DATA.rows.filter(shouldShowRow);
      stats(rows);
      document.getElementById('rows').innerHTML = rows.map(row => {
        const current = rowState(row.id);
        const semanticChanged = row.semantic_speaker_label !== row.final_speaker_label;
        return \`
          <tr class="\${row.suspicious ? 'suspicious' : ''} \${semanticChanged ? 'semantic-change' : ''}">
            <td data-label="#">\${row.index + 1}</td>
            <td data-label="时间">
              <div>\${escapeHtml(row.absolute_start_time || '')}</div>
              <div class="subtle">\${escapeHtml(String(row.start_ms / 1000).replace(/\\.0$/, ''))}s - \${escapeHtml(String(row.end_ms / 1000).replace(/\\.0$/, ''))}s</div>
            </td>
            <td data-label="原始">\${escapeHtml(row.original_speaker_label || '-')}</td>
            <td data-label="阶段一">\${escapeHtml(row.final_speaker_label || '-')}</td>
            <td data-label="语义建议">\${escapeHtml(row.semantic_speaker_label || '-')}</td>
            <td data-label="文本">
              <div class="subtle">\${escapeHtml(row.display_name || '-')}</div>
              <div class="text">\${escapeHtml(row.text || '')}</div>
              <div class="subtle">overlap: \${row.overlap_ratio == null ? '-' : Math.round(row.overlap_ratio * 100) + '%'}</div>
            </td>
            <td data-label="可疑原因">
              <div class="reason-list">\${row.reasons.map(reason => \`<span class="reason">\${escapeHtml(reason)}</span>\`).join('')}</div>
            </td>
            <td data-label="你的判定">
              <div class="status-controls">
                <select class="status-select" data-kind="verdict" data-id="\${row.id}">
                  <option value="" \${current.verdict === '' ? 'selected' : ''}>未标注</option>
                  <option value="correct" \${current.verdict === 'correct' ? 'selected' : ''}>正确</option>
                  <option value="wrong" \${current.verdict === 'wrong' ? 'selected' : ''}>错误</option>
                  <option value="uncertain" \${current.verdict === 'uncertain' ? 'selected' : ''}>不确定</option>
                </select>
              </div>
            </td>
            <td data-label="人工归属">
              <select class="speaker-select" data-kind="manualSpeaker" data-id="\${row.id}">
                <option value="" \${current.manualSpeaker === '' ? 'selected' : ''}>不改</option>
                \${SPEAKER_OPTIONS.map(option => \`<option value="\${escapeHtml(option)}" \${current.manualSpeaker === option ? 'selected' : ''}>\${escapeHtml(option)}</option>\`).join('')}
              </select>
            </td>
          </tr>
        \`;
      }).join('');

      document.querySelectorAll('select[data-id]').forEach(node => {
        node.addEventListener('change', (event) => {
          const target = event.currentTarget;
          setRowState(target.dataset.id, { [target.dataset.kind]: target.value });
        });
      });
    }

    document.getElementById('show-suspicious').addEventListener('change', render);
    document.getElementById('show-semantic-change').addEventListener('change', render);
    document.getElementById('mark-visible-correct').addEventListener('click', () => {
      DATA.rows.filter(shouldShowRow).forEach(row => {
        state[row.id] = { ...rowState(row.id), verdict: 'correct' };
      });
      saveState(state);
      render();
    });
    document.getElementById('export-json').addEventListener('click', () => {
      const payload = {
        conversation_id: DATA.conversation_id,
        session_id: DATA.session_id,
        exported_at: new Date().toISOString(),
        rows: DATA.rows.map(row => ({
          id: row.id,
          index: row.index,
          final_speaker_label: row.final_speaker_label,
          semantic_speaker_label: row.semantic_speaker_label,
          verdict: rowState(row.id).verdict || '',
          manualSpeaker: rowState(row.id).manualSpeaker || '',
          text: row.text,
          reasons: row.reasons,
        })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = DATA.conversation_id + '-manual-review.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    render();
  </script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const data = JSON.parse(await fs.readFile(options.input, 'utf8')) as ReviewFile;
  const html = buildHtml(data, options.title);

  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, html, 'utf8');
  console.log(JSON.stringify({ output: options.output }, null, 2));
}

main().catch(err => {
  console.error('[RenderConversationReviewHtml] failed:', err);
  process.exit(1);
});
