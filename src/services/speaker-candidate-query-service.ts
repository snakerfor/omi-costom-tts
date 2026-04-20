import { db } from '../db';

export interface SpeakerCandidateListRow {
  id: string;
  conversation_id: string;
  session_id: string | null;
  speaker_label: string | null;
  status: string;
  best_match_speaker_id: string | null;
  best_match_name: string | null;
  best_score: number | null;
  second_match_speaker_id: string | null;
  second_match_name: string | null;
  second_score: number | null;
  decision_reason: string | null;
  sample_clip_path: string | null;
  sample_text: string | null;
  confirmed_speaker_id: string | null;
  clip_count: number;
  created_at: string;
  updated_at: string;
}

export interface SpeakerCandidateClipRow {
  id: string;
  candidate_id: string;
  segment_id: string | null;
  clip_path: string;
  text: string | null;
  start_ms: number | null;
  end_ms: number | null;
  duration_ms: number | null;
  decision: string;
  person_name: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpeakerCandidateDetail {
  candidate: SpeakerCandidateListRow;
  clips: SpeakerCandidateClipRow[];
}

export function listPendingSpeakerCandidates(): SpeakerCandidateListRow[] {
  return db.prepare(`
    SELECT
      sc.id,
      sc.conversation_id,
      sc.session_id,
      sc.speaker_label,
      sc.status,
      sc.best_match_speaker_id,
      s1.name AS best_match_name,
      sc.best_score,
      sc.second_match_speaker_id,
      s2.name AS second_match_name,
      sc.second_score,
      sc.decision_reason,
      sc.sample_clip_path,
      sc.sample_text,
      sc.confirmed_speaker_id,
      COUNT(scc.id) AS clip_count,
      sc.created_at,
      sc.updated_at
    FROM speaker_candidates sc
    LEFT JOIN speakers s1 ON s1.id = sc.best_match_speaker_id
    LEFT JOIN speakers s2 ON s2.id = sc.second_match_speaker_id
    LEFT JOIN speaker_candidate_clips scc ON scc.candidate_id = sc.id
    WHERE sc.status = 'pending'
    GROUP BY
      sc.id, sc.conversation_id, sc.session_id, sc.speaker_label, sc.status,
      sc.best_match_speaker_id, s1.name, sc.best_score,
      sc.second_match_speaker_id, s2.name, sc.second_score,
      sc.decision_reason, sc.sample_clip_path, sc.sample_text,
      sc.confirmed_speaker_id, sc.created_at, sc.updated_at
    ORDER BY sc.created_at DESC
  `).all() as SpeakerCandidateListRow[];
}

export function getSpeakerCandidateDetail(candidateId: string): SpeakerCandidateDetail {
  const candidate = db.prepare(`
    SELECT
      sc.id,
      sc.conversation_id,
      sc.session_id,
      sc.speaker_label,
      sc.status,
      sc.best_match_speaker_id,
      s1.name AS best_match_name,
      sc.best_score,
      sc.second_match_speaker_id,
      s2.name AS second_match_name,
      sc.second_score,
      sc.decision_reason,
      sc.sample_clip_path,
      sc.sample_text,
      sc.confirmed_speaker_id,
      (
        SELECT COUNT(*)
        FROM speaker_candidate_clips x
        WHERE x.candidate_id = sc.id
      ) AS clip_count,
      sc.created_at,
      sc.updated_at
    FROM speaker_candidates sc
    LEFT JOIN speakers s1 ON s1.id = sc.best_match_speaker_id
    LEFT JOIN speakers s2 ON s2.id = sc.second_match_speaker_id
    WHERE sc.id = ?
  `).get(candidateId) as SpeakerCandidateListRow | undefined;

  if (!candidate) {
    throw new Error(`candidate not found: ${candidateId}`);
  }

  const clips = db.prepare(`
    SELECT
      id, candidate_id, segment_id, clip_path, text,
      start_ms, end_ms, duration_ms, decision, person_name, note,
      created_at, updated_at
    FROM speaker_candidate_clips
    WHERE candidate_id = ?
    ORDER BY duration_ms DESC, created_at ASC
  `).all(candidateId) as SpeakerCandidateClipRow[];

  return {
    candidate,
    clips,
  };
}
