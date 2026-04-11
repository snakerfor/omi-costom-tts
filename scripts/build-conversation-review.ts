import * as fs from 'fs/promises';
import * as path from 'path';

interface ConversationSpeakerSummary {
  speaker_label: string | null;
  speaker_id: string | null;
  speaker_name: string | null;
  display_name: string;
  identity_label: string | null;
  segment_count: number;
  total_duration_ms: number;
  is_confirmed: number;
}

interface ConversationSegmentRow {
  id: string;
  start_ms: number;
  end_ms: number;
  absolute_start_time: string | null;
  absolute_end_time: string | null;
  original_speaker_label: string | null;
  speaker_label: string | null;
  speaker_id: string | null;
  speaker_name: string | null;
  speaker_identity: string | null;
  display_name: string;
  text: string;
  confidence: number | null;
  resolution_method: string | null;
}

interface ConversationDetailResponse {
  ok: boolean;
  data: {
    conversation: {
      id: string;
      session_id: string;
      speaker_count: number;
      segment_count: number;
      started_at: string | null;
      ended_at: string | null;
      summary_text: string;
    };
    speakers: ConversationSpeakerSummary[];
    segments: ConversationSegmentRow[];
  };
}

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
  sessionId: string;
  segmentCount: number;
  alignedSpeakerCount: number;
  aligned: AlignmentRow[];
}

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

function parseArgs(): { detail: string; alignment: string | null; output: string } {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (key?.startsWith('--') && value) {
      args.set(key.slice(2), value);
    }
  }

  const detail = args.get('detail');
  if (!detail) {
    throw new Error('missing required arg --detail');
  }

  return {
    detail: path.resolve(detail),
    alignment: args.get('alignment') ? path.resolve(args.get('alignment')!) : null,
    output: path.resolve(args.get('output') || path.join(process.cwd(), 'preview_results', 'conversation-review.json')),
  };
}

function isMeaningfulText(text: string): boolean {
  return /[\p{Script=Han}\p{L}\p{N}]/u.test(text);
}

function isShortSegment(row: ReviewRow): boolean {
  return row.end_ms - row.start_ms <= 1500 || row.text.trim().length <= 6;
}

function normalizeSpeakerLabel(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (/^speaker[_\s-]?(\d+)$/i.test(normalized)) {
    const match = normalized.match(/(\d+)/);
    const num = match ? Number(match[1]) : 0;
    return `SPEAKER_${String(num).padStart(2, '0')}`;
  }
  if (/^\d+$/.test(normalized)) {
    return `SPEAKER_${String(Number(normalized)).padStart(2, '0')}`;
  }
  return normalized;
}

function buildAlignmentMap(alignment: AlignmentFile | null): Map<string, AlignmentRow> {
  return new Map((alignment?.aligned || []).map(row => [row.id, row]));
}

function proposeSemanticSpeaker(rows: ReviewRow[], index: number): { label: string | null; reasons: string[] } {
  const current = rows[index];
  const prev = rows[index - 1] || null;
  const next = rows[index + 1] || null;
  const reasons: string[] = [];
  let suggestion = current.final_speaker_label;

  const currentNormalized = normalizeSpeakerLabel(current.final_speaker_label);
  const prevNormalized = normalizeSpeakerLabel(prev?.final_speaker_label || null);
  const nextNormalized = normalizeSpeakerLabel(next?.final_speaker_label || null);

  if (!isMeaningfulText(current.text)) {
    return { label: suggestion, reasons };
  }

  const lowOverlap = current.overlap_ratio != null && current.overlap_ratio < 0.5;
  const labelLooksRaw = current.final_speaker_label != null && !/^SPEAKER_\d+$/.test(current.final_speaker_label);

  if (labelLooksRaw) {
    reasons.push('残留原始标签');
  }

  if (lowOverlap) {
    reasons.push('时间重叠偏低');
  }

  if (prevNormalized && nextNormalized && prevNormalized === nextNormalized && currentNormalized !== prevNormalized) {
    if (isShortSegment(current) || lowOverlap || labelLooksRaw) {
      suggestion = prevNormalized;
      reasons.push('夹在同一发言人之间');
    }
  }

  if (labelLooksRaw && suggestion === current.final_speaker_label) {
    if (prevNormalized && nextNormalized && prevNormalized === nextNormalized) {
      suggestion = prevNormalized;
      reasons.push('邻居一致');
    } else if (prevNormalized && !nextNormalized) {
      suggestion = prevNormalized;
      reasons.push('沿用上一句');
    } else if (nextNormalized && !prevNormalized) {
      suggestion = nextNormalized;
      reasons.push('沿用下一句');
    }
  }

  if (index === 0 && nextNormalized && (isShortSegment(current) || labelLooksRaw)) {
    suggestion = nextNormalized;
    reasons.push('首句短句跟随后句');
  }

  if (index === rows.length - 1 && prevNormalized && (isShortSegment(current) || labelLooksRaw)) {
    suggestion = prevNormalized;
    reasons.push('尾句短句跟随前句');
  }

  if (suggestion === current.final_speaker_label && lowOverlap && isShortSegment(current)) {
    if (prevNormalized && prevNormalized === nextNormalized && prevNormalized) {
      suggestion = prevNormalized;
      reasons.push('低重叠短句回并');
    }
  }

  return {
    label: suggestion,
    reasons,
  };
}

async function main(): Promise<void> {
  const options = parseArgs();
  const detail = JSON.parse(await fs.readFile(options.detail, 'utf8')) as ConversationDetailResponse;
  const alignment = options.alignment
    ? JSON.parse(await fs.readFile(options.alignment, 'utf8')) as AlignmentFile
    : null;

  const alignmentById = buildAlignmentMap(alignment);
  const baseRows: ReviewRow[] = detail.data.segments.map((segment, index, all) => {
    const aligned = alignmentById.get(segment.id);
    return {
      id: segment.id,
      index,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      absolute_start_time: segment.absolute_start_time,
      original_speaker_label: segment.original_speaker_label,
      final_speaker_label: segment.speaker_label,
      semantic_speaker_label: segment.speaker_label,
      overlap_ratio: aligned?.overlap_ratio ?? null,
      text: segment.text,
      display_name: segment.display_name,
      suspicious: false,
      reasons: [],
      prev_speaker_label: all[index - 1]?.speaker_label ?? null,
      next_speaker_label: all[index + 1]?.speaker_label ?? null,
    };
  });

  const rows = baseRows.map((row, index) => {
    const proposal = proposeSemanticSpeaker(baseRows, index);
    const semanticLabel = proposal.label;
    const changed = semanticLabel !== row.final_speaker_label;
    const suspicious = changed || proposal.reasons.length > 0;
    return {
      ...row,
      semantic_speaker_label: semanticLabel,
      suspicious,
      reasons: proposal.reasons,
    };
  });

  const reviewFile: ReviewFile = {
    generated_at: new Date().toISOString(),
    conversation_id: detail.data.conversation.id,
    session_id: detail.data.conversation.session_id,
    speaker_count: detail.data.conversation.speaker_count,
    segment_count: detail.data.conversation.segment_count,
    rows,
  };

  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, JSON.stringify(reviewFile, null, 2), 'utf8');
  console.log(JSON.stringify({
    output: options.output,
    segmentCount: reviewFile.segment_count,
    suspiciousCount: rows.filter(row => row.suspicious).length,
    semanticChanges: rows.filter(row => row.semantic_speaker_label !== row.final_speaker_label).length,
  }, null, 2));
}

main().catch(err => {
  console.error('[BuildConversationReview] failed:', err);
  process.exit(1);
});
