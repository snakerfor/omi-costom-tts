import { Segment } from '../types';

function normalizeReason(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthor') ||
    lower.includes('expired') ||
    lower.includes('forbidden') ||
    lower.includes('invalid api key') ||
    lower.includes('api key') ||
    lower.includes('token')
  ) {
    return 'Soniox API 认证失败或已过期';
  }

  return 'Soniox API 当前不可用';
}

export function buildSttUnavailableSegment(error: unknown): Segment {
  const rawMessage = String((error as Error)?.message ?? error ?? '');
  const reason = normalizeReason(rawMessage);

  return {
    id: `stt_unavailable_${Date.now().toString(36)}`,
    text: `【实时转录不可用：${reason}】`,
    start: 0,
    end: 0,
    speaker_resolution: 'stt_unavailable',
    speaker_error: rawMessage || reason,
  };
}
