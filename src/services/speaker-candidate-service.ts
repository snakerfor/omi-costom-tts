import { db } from '../db';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export type CandidateDecisionReason = 'low_confidence' | 'conflict' | 'embedding_unavailable';

export interface CreateSpeakerCandidateInput {
  conversationId: string;
  sessionId: string | null;
  speakerLabel: string | null;
  rawEmbedding: number[] | null;
  bestMatchSpeakerId: string | null;
  bestScore: number | null;
  secondMatchSpeakerId: string | null;
  secondScore: number | null;
  decisionReason: CandidateDecisionReason;
  sampleClipPath: string | null;
  sampleText: string | null;
  clips: Array<{
    segmentId: string | null;
    clipPath: string;
    text: string | null;
    startMs: number | null;
    endMs: number | null;
    durationMs: number | null;
  }>;
}

export function createSpeakerCandidate(input: CreateSpeakerCandidateInput): string {
  const now = new Date().toISOString();
  const candidateId = genId('cand');

  const insertCandidate = db.prepare(`
    INSERT INTO speaker_candidates (
      id, conversation_id, session_id, speaker_label, status, raw_embedding_json,
      best_match_speaker_id, best_score, second_match_speaker_id, second_score,
      decision_reason, sample_clip_path, sample_text, confirmed_speaker_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertClip = db.prepare(`
    INSERT INTO speaker_candidate_clips (
      id, candidate_id, segment_id, clip_path, text, start_ms, end_ms, duration_ms,
      decision, person_name, note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    insertCandidate.run(
      candidateId,
      input.conversationId,
      input.sessionId,
      input.speakerLabel,
      'pending',
      input.rawEmbedding?.length ? JSON.stringify(input.rawEmbedding) : null,
      input.bestMatchSpeakerId,
      input.bestScore,
      input.secondMatchSpeakerId,
      input.secondScore,
      input.decisionReason,
      input.sampleClipPath,
      input.sampleText,
      null,
      now,
      now,
    );

    for (const clip of input.clips) {
      insertClip.run(
        genId('candclip'),
        candidateId,
        clip.segmentId,
        clip.clipPath,
        clip.text,
        clip.startMs,
        clip.endMs,
        clip.durationMs,
        'uncertain',
        null,
        null,
        now,
        now,
      );
    }
  });

  tx();
  return candidateId;
}

export function clearPendingCandidatesForConversation(conversationId: string): number {
  const selectIds = db.prepare(`
    SELECT id
    FROM speaker_candidates
    WHERE conversation_id = ? AND status = 'pending'
  `);
  const deleteClips = db.prepare(`
    DELETE FROM speaker_candidate_clips
    WHERE candidate_id = ?
  `);
  const deleteCandidate = db.prepare(`
    DELETE FROM speaker_candidates
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    const rows = selectIds.all(conversationId) as Array<{ id: string }>;
    for (const row of rows) {
      deleteClips.run(row.id);
      deleteCandidate.run(row.id);
    }
    return rows.length;
  });

  return tx();
}
