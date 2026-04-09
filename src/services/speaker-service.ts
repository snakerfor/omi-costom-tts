import { db } from '../db';

export interface SpeakerRow {
  id: string;
  name: string | null;
  status: string;
  display_label: string | null;
  sample_text: string | null;
  sample_segment_id: string | null;
  sample_audio_path: string | null;
  created_at: string;
  updated_at: string;
  conversation_count: number;
  segment_count: number;
}

export function listAllSpeakers(): SpeakerRow[] {
  return db.prepare(`
    SELECT
      s.id,
      s.name,
      s.status,
      s.display_label,
      s.sample_text,
      s.sample_segment_id,
      s.sample_audio_path,
      s.created_at,
      s.updated_at,
      COUNT(DISTINCT cs.conversation_id) AS conversation_count,
      COUNT(cs.id) AS segment_count
    FROM speakers s
    LEFT JOIN conversation_segments cs ON cs.speaker_id = s.id
    GROUP BY s.id, s.name, s.status, s.display_label, s.sample_text, s.sample_segment_id, s.sample_audio_path, s.created_at, s.updated_at
    ORDER BY s.created_at DESC
  `).all() as SpeakerRow[];
}

export function listAnonymousSpeakers(): SpeakerRow[] {
  return db.prepare(`
    SELECT
      s.id,
      s.name,
      s.status,
      s.display_label,
      s.sample_text,
      s.sample_segment_id,
      s.sample_audio_path,
      s.created_at,
      s.updated_at,
      COUNT(DISTINCT cs.conversation_id) AS conversation_count,
      COUNT(cs.id) AS segment_count
    FROM speakers s
    LEFT JOIN conversation_segments cs ON cs.speaker_id = s.id
    WHERE s.status = 'anonymous'
    GROUP BY s.id, s.name, s.status, s.display_label, s.sample_text, s.sample_segment_id, s.sample_audio_path, s.created_at, s.updated_at
    ORDER BY s.created_at DESC
  `).all() as SpeakerRow[];
}

export function confirmSpeakerName(speakerId: string, realName: string): { success: true; speakerId: string; realName: string } {
  if (!speakerId) {
    throw new Error('speakerId is required');
  }

  if (!realName || !realName.trim()) {
    throw new Error('realName is required');
  }

  const speaker = db.prepare(`SELECT id FROM speakers WHERE id = ?`).get(speakerId) as { id: string } | undefined;
  if (!speaker) {
    throw new Error(`speaker not found: ${speakerId}`);
  }

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE speakers
      SET name = ?, status = 'confirmed', display_label = ?, updated_at = ?
      WHERE id = ?
    `).run(realName.trim(), realName.trim(), now, speakerId);

    db.prepare(`
      UPDATE conversation_segments
      SET speaker_name = ?, resolution_method = 'manual_confirm', updated_at = ?
      WHERE speaker_id = ?
    `).run(realName.trim(), now, speakerId);
  });

  tx();

  return {
    success: true,
    speakerId,
    realName: realName.trim(),
  };
}
