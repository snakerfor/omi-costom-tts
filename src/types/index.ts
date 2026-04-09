// Soniox token from WebSocket response
export interface SonioxToken {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  is_final: boolean;
  speaker?: string;
}

// Soniox full response
export interface SonioxResponse {
  tokens: SonioxToken[];
  final_audio_proc_ms?: number;
  total_audio_proc_ms?: number;
  finished?: boolean;
}

// Segment returned to APP (matches APP's response mode config)
export interface Segment {
  text: string;
  start: number;
  end: number;
  speaker?: string;
}

// APP message control signal
export interface AppMessage {
  type: 'CloseStream';
}

// Service response to APP
export interface AppResponse {
  segments: Segment[];
}
