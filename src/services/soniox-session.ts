import { SonioxNodeClient } from '@soniox/node';

const client = new SonioxNodeClient({
  api_key: process.env.SONIOX_API_KEY ?? '',
});

export function createSonioxSession() {
  const languageHints = (process.env.SONIOX_LANGUAGE_HINTS ?? 'zh,en')
    .split(',')
    .map(s => s.trim());

  const config = {
    model: 'stt-rt-v4',
    audio_format: 'pcm_s16le' as const,
    sample_rate: 16000,
    num_channels: 1,
    enable_speaker_diarization: true,
    language_hints: languageHints,
  };

  console.log('[Soniox] Session config:', JSON.stringify(config));

  return client.realtime.stt(config);
}
