import * as fs from 'fs/promises';
import * as path from 'path';

interface AlignmentRow {
  id: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  original_speaker_label: string | null;
  aligned_speaker: string | null;
  overlap_ratio: number;
  text: string;
}

interface AlignmentFile {
  sonioxSessionId: string;
  segmentCount: number;
  originalSpeakerLabelCount: number;
  alignedSpeakerCount: number;
  byAlignedSpeaker: Record<string, number>;
  aligned: AlignmentRow[];
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
    output: path.resolve(args.get('output') || path.join(process.cwd(), 'public', 'preview', 'alignment.html')),
    title: args.get('title') || 'Soniox + pyannote Alignment Preview',
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
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(part => String(part).padStart(2, '0')).join(':');
}

function renderRow(row: AlignmentRow): string {
  const speaker = row.aligned_speaker || 'UNRESOLVED';
  const overlap = `${Math.round(row.overlap_ratio * 100)}%`;
  return `
    <tr>
      <td class="speaker">${escapeHtml(speaker)}</td>
      <td class="text-cell">
        <div class="text">${escapeHtml(row.text)}</div>
        <div class="meta">
          <span>${formatMs(row.start_ms)} - ${formatMs(row.end_ms)}</span>
          <span>original: ${escapeHtml(row.original_speaker_label || '-')}</span>
          <span>overlap: ${overlap}</span>
        </div>
      </td>
    </tr>
  `;
}

function buildHtml(data: AlignmentFile, title: string): string {
  const summaryItems = Object.entries(data.byAlignedSpeaker)
    .map(([speaker, count]) => `<span class="chip">${escapeHtml(speaker)}: ${count}</span>`)
    .join('');

  const rows = data.aligned.map(renderRow).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f5f1e8;
      --panel: rgba(255,255,255,0.92);
      --ink: #1d1b18;
      --muted: #6c6459;
      --line: rgba(29,27,24,0.12);
      --accent: #1f6b5c;
      --accent-soft: rgba(31,107,92,0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", "Noto Serif SC", Georgia, serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(31,107,92,0.14), transparent 32%),
        radial-gradient(circle at top right, rgba(188,90,47,0.14), transparent 28%),
        linear-gradient(180deg, #efe7d7 0%, var(--bg) 48%, #efe8df 100%);
    }
    .shell {
      width: min(1200px, calc(100vw - 40px));
      margin: 28px auto;
      padding: 28px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 24px;
      box-shadow: 0 24px 80px rgba(40, 31, 18, 0.08);
      backdrop-filter: blur(10px);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 32px;
      line-height: 1.1;
    }
    .subtle {
      color: var(--muted);
      font-size: 15px;
    }
    .summary {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin: 18px 0 24px;
    }
    .chip {
      padding: 8px 12px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 13px;
      font-weight: 600;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    thead th {
      text-align: left;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    tbody td {
      padding: 14px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    .speaker {
      width: 180px;
      font-weight: 700;
      color: var(--accent);
      font-size: 15px;
    }
    .text {
      font-size: 18px;
      line-height: 1.55;
    }
    .meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    @media (max-width: 760px) {
      .shell {
        width: calc(100vw - 20px);
        margin: 10px auto;
        padding: 16px;
      }
      .speaker {
        width: 110px;
        font-size: 13px;
      }
      .text {
        font-size: 16px;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <h1>${escapeHtml(title)}</h1>
    <div class="subtle">session: ${escapeHtml(data.sonioxSessionId)} | segments: ${data.segmentCount} | original labels: ${data.originalSpeakerLabelCount} | aligned speakers: ${data.alignedSpeakerCount}</div>
    <div class="summary">${summaryItems}</div>
    <table>
      <thead>
        <tr>
          <th>Speaker</th>
          <th>Content</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </main>
</body>
</html>`;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const data = JSON.parse(await fs.readFile(options.input, 'utf8')) as AlignmentFile;
  const html = buildHtml(data, options.title);

  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, html, 'utf8');
  console.log(JSON.stringify({ output: options.output }, null, 2));
}

main().catch(err => {
  console.error('[RenderAlignmentHtml] failed:', err);
  process.exit(1);
});
