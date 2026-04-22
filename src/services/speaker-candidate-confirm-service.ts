import { db } from '../db';
import { buildEmbedding } from './embedding-provider';
import { cosineSimilarity } from '../utils/similarity';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface ClipDecisionInput {
  clip_id: string;
  decision: 'keep' | 'drop' | 'uncertain';
  person_name?: string | null;
  note?: string | null;
}

interface PendingCandidateRow {
  id: string;
  raw_embedding_json: string | null;
}

interface CandidateClipRow {
  id: string;
  segment_id: string | null;
  clip_path: string;
  text: string | null;
  decision: string;
  person_name: string | null;
  note: string | null;
}

interface CandidateRow {
  id: string;
  speaker_label: string | null;
  local_speaker_key: string | null;
  session_id: string | null;
  sample_text: string | null;
  sample_clip_path: string | null;
}

function latestEmbeddingBySpeaker(): Array<{ speaker_id: string; embedding: number[] }> {
  const rows = db.prepare(`
    SELECT se.speaker_id, se.embedding_json
    FROM speaker_embeddings se
    JOIN (
      SELECT speaker_id, MAX(created_at) AS max_created_at
      FROM speaker_embeddings
      GROUP BY speaker_id
    ) latest
      ON latest.speaker_id = se.speaker_id
     AND latest.max_created_at = se.created_at
  `).all() as Array<{ speaker_id: string; embedding_json: string }>;

  return rows.map(row => {
    let embedding: number[] = [];
    try {
      embedding = JSON.parse(row.embedding_json) as number[];
    } catch {
      embedding = [];
    }
    return {
      speaker_id: row.speaker_id,
      embedding,
    };
  }).filter(row => row.embedding.length > 0);
}

function resolveOrCreateConfirmedSpeaker(personName: string, sampleText: string | null, sampleSegmentId: string | null, sampleAudioPath: string | null): { speakerId: string; created: boolean } {
  const existing = db.prepare(`
    SELECT id
    FROM speakers
    WHERE status = 'confirmed' AND name = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(personName) as { id?: string } | undefined;

  const now = new Date().toISOString();
  if (existing?.id) {
    db.prepare(`
      UPDATE speakers
      SET
        name = ?,
        display_label = ?,
        sample_text = COALESCE(?, sample_text),
        sample_segment_id = COALESCE(?, sample_segment_id),
        sample_audio_path = COALESCE(?, sample_audio_path),
        updated_at = ?
      WHERE id = ?
    `).run(
      personName,
      personName,
      sampleText,
      sampleSegmentId,
      sampleAudioPath,
      now,
      existing.id,
    );
    return { speakerId: existing.id, created: false };
  }

  const speakerId = genId('spk');
  db.prepare(`
    INSERT INTO speakers (
      id, name, status, display_label, identity_label, identity_status, notes,
      first_seen_at, last_seen_at, sample_text, sample_segment_id, sample_audio_path,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    speakerId,
    personName,
    'confirmed',
    personName,
    null,
    'unconfirmed',
    null,
    now,
    now,
    sampleText,
    sampleSegmentId,
    sampleAudioPath,
    now,
    now,
  );
  return { speakerId, created: true };
}

export function saveCandidateDecisions(candidateId: string, decisions: ClipDecisionInput[]): void {
  const validClipIds = new Set((db.prepare(`
    SELECT id
    FROM speaker_candidate_clips
    WHERE candidate_id = ?
  `).all(candidateId) as Array<{ id: string }>).map(row => row.id));

  const now = new Date().toISOString();
  const updateStmt = db.prepare(`
    UPDATE speaker_candidate_clips
    SET decision = ?, person_name = ?, note = ?, updated_at = ?
    WHERE id = ? AND candidate_id = ?
  `);

  const tx = db.transaction(() => {
    for (const item of decisions) {
      if (!validClipIds.has(item.clip_id)) {
        throw new Error(`invalid clip_id: ${item.clip_id}`);
      }
      if (!['keep', 'drop', 'uncertain'].includes(item.decision)) {
        throw new Error(`invalid decision for clip ${item.clip_id}`);
      }
      const personName = item.person_name == null ? null : String(item.person_name).trim() || null;
      if (item.decision === 'keep' && !personName) {
        throw new Error(`person_name is required when decision=keep for clip ${item.clip_id}`);
      }
      updateStmt.run(
        item.decision,
        personName,
        item.note == null ? null : String(item.note).trim() || null,
        now,
        item.clip_id,
        candidateId,
      );
    }
  });

  tx();
}

export async function confirmCandidate(candidateId: string): Promise<{
  confirmedSpeakerId: string;
  personName: string;
  createdNewSpeaker: boolean;
  embeddingClipCount: number;
  mergedCandidateCount: number;
  updatedSegmentCount: number;
}> {
  const candidate = db.prepare(`
    SELECT id, speaker_label, local_speaker_key, session_id, sample_text, sample_clip_path
    FROM speaker_candidates
    WHERE id = ? AND status = 'pending'
  `).get(candidateId) as CandidateRow | undefined;
  if (!candidate) {
    throw new Error(`pending candidate not found: ${candidateId}`);
  }

  const clips = db.prepare(`
    SELECT id, segment_id, clip_path, text, decision, person_name, note
    FROM speaker_candidate_clips
    WHERE candidate_id = ?
    ORDER BY duration_ms DESC, created_at ASC
  `).all(candidateId) as CandidateClipRow[];

  const keepClips = clips.filter(clip => clip.decision === 'keep');
  if (!keepClips.length) {
    throw new Error('at least one keep clip is required before confirm');
  }

  const keepNames = [...new Set(keepClips.map(clip => (clip.person_name || '').trim()).filter(Boolean))];
  if (keepNames.length !== 1) {
    throw new Error('keep clips must resolve to exactly one person_name');
  }
  const personName = keepNames[0];

  const embeddingResult = await buildEmbedding({
    speakerLabel: null,
    tokens: [],
    textSample: keepClips.map(clip => clip.text || '').join(' ').slice(0, 500),
    audioPaths: keepClips.map(clip => clip.clip_path),
  });
  if (!embeddingResult.usableForIdentity || !embeddingResult.embedding.length) {
    throw new Error(`clean embedding unavailable: provider=${embeddingResult.provider}`);
  }

  const sampleClip = keepClips[0] || null;
  const resolved = resolveOrCreateConfirmedSpeaker(
    personName,
    sampleClip?.text || candidate.sample_text || null,
    sampleClip?.segment_id || null,
    sampleClip?.clip_path || candidate.sample_clip_path || null,
  );

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO speaker_embeddings (
      id, speaker_id, embedding_json, sample_rate, duration_ms,
      source_audio_file_id, source_segment_id, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    genId('emb'),
    resolved.speakerId,
    JSON.stringify(embeddingResult.embedding),
    16000,
    null,
    null,
    sampleClip?.segment_id || null,
    'confirmed_seed',
    now,
  );

  const updateSegmentsForCandidate = db.prepare(`
    UPDATE conversation_segments
    SET speaker_id = ?, speaker_name = ?, confidence = ?, resolution_method = ?, updated_at = ?
    WHERE id IN (
      SELECT segment_id
      FROM speaker_candidate_segments
      WHERE candidate_id = ?
    )
  `);

  const updateCandidate = db.prepare(`
    UPDATE speaker_candidates
    SET status = ?, confirmed_speaker_id = ?, updated_at = ?
    WHERE id = ?
  `);

  const pendingCandidates = db.prepare(`
    SELECT id, raw_embedding_json
    FROM speaker_candidates
    WHERE status = 'pending' AND id != ?
  `).all(candidateId) as PendingCandidateRow[];

  const mergeThreshold = Number(process.env.SPEAKER_CANDIDATE_MERGE_THRESHOLD || 0.82);
  const mergedCandidateIds: string[] = [];
  let updatedSegmentCount = 0;

  const tx = db.transaction(() => {
    updateCandidate.run(
      resolved.created ? 'confirmed_created' : 'confirmed_merged',
      resolved.speakerId,
      now,
      candidateId,
    );

    const result = updateSegmentsForCandidate.run(
      resolved.speakerId,
      personName,
      1,
      'candidate_manual_confirm',
      now,
      candidateId,
    ) as { changes?: number };
    updatedSegmentCount += result.changes || 0;

    for (const row of pendingCandidates) {
      let rawEmbedding: number[] = [];
      try {
        rawEmbedding = row.raw_embedding_json ? JSON.parse(row.raw_embedding_json) as number[] : [];
      } catch {
        rawEmbedding = [];
      }
      if (!rawEmbedding.length) continue;
      const similarity = cosineSimilarity(embeddingResult.embedding, rawEmbedding);
      if (similarity < mergeThreshold) continue;

      updateCandidate.run('confirmed_merged', resolved.speakerId, now, row.id);
      const mergeResult = updateSegmentsForCandidate.run(
        resolved.speakerId,
        personName,
        similarity,
        'candidate_auto_merged',
        now,
        row.id,
      ) as { changes?: number };
      updatedSegmentCount += mergeResult.changes || 0;
      mergedCandidateIds.push(row.id);
    }
  });

  tx();

  return {
    confirmedSpeakerId: resolved.speakerId,
    personName,
    createdNewSpeaker: resolved.created,
    embeddingClipCount: keepClips.length,
    mergedCandidateCount: mergedCandidateIds.length,
    updatedSegmentCount,
  };
}
