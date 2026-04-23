import { createHmac } from 'crypto';
import * as fs from 'fs/promises';
import * as https from 'https';
import { URL } from 'url';

const SERVICE_PATH = process.env.XFYUN_VOICEPRINT_PATH || 's1aa729d0';
const SERVICE_HOST = 'api.xf-yun.com';
const SERVICE_URL = `https://${SERVICE_HOST}/v1/private/${SERVICE_PATH}`;

export interface XfyunConfig {
  appId: string;
  apiKey: string;
  apiSecret: string;
  groupId: string;
  servicePath: string;
}

export interface XfyunScoreItem {
  score: number;
  featureId?: string | null;
  featureInfo?: string | null;
}

export interface XfyunSearchResponse {
  scoreList: XfyunScoreItem[];
  raw: unknown;
  sid: string | null;
}

export interface XfyunFeatureResponse {
  featureId: string;
  raw: unknown;
  sid: string | null;
}

export interface XfyunGroupResponse {
  msg: string;
  raw: unknown;
  sid: string | null;
}

export function getXfyunVoiceprintConfig(): XfyunConfig | null {
  const appId = process.env.XFYUN_APP_ID?.trim() || '';
  const apiKey = process.env.XFYUN_API_KEY?.trim() || '';
  const apiSecret = process.env.XFYUN_API_SECRET?.trim() || '';
  const groupId = process.env.XFYUN_GROUP_ID?.trim() || '';

  if (!appId || !apiKey || !apiSecret || !groupId) {
    return null;
  }

  return {
    appId,
    apiKey,
    apiSecret,
    groupId,
    servicePath: SERVICE_PATH,
  };
}

export function isXfyunVoiceprintEnabled(): boolean {
  return (process.env.XFYUN_VOICEPRINT_ENABLED || '').toLowerCase() === 'true';
}

function encodeBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function buildAuthorization(config: XfyunConfig, date: string, requestLine: string): string {
  const signatureOrigin = `host: ${SERVICE_HOST}\ndate: ${date}\n${requestLine}`;
  const signature = createHmac('sha256', config.apiSecret).update(signatureOrigin).digest('base64');
  const origin = `api_key="${config.apiKey}",algorithm="hmac-sha256",headers="host date request-line",signature="${signature}"`;
  return encodeBase64(origin);
}

async function requestXfyun<T>(config: XfyunConfig, body: unknown): Promise<T> {
  const url = new URL(SERVICE_URL);
  const date = new Date().toUTCString();
  const requestLine = `POST ${url.pathname} HTTP/1.1`;
  url.searchParams.set('authorization', buildAuthorization(config, date, requestLine));
  url.searchParams.set('host', SERVICE_HOST);
  url.searchParams.set('date', date);

  const payload = JSON.stringify(body);

  const result = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: SERVICE_HOST,
          appid: config.appId,
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      },
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  let parsed: any;
  try {
    parsed = JSON.parse(result);
  } catch (err) {
    throw new Error(`xfyun response is not valid JSON: ${result.slice(0, 500)}`);
  }

  const header = parsed?.header || {};
  if (header.code !== 0) {
    throw new Error(`xfyun request failed (${header.code ?? 'unknown'}): ${header.message || 'unknown error'}`);
  }

  return parsed as T;
}

function decodePayloadText<T>(payload: any, field: string): T {
  const text = payload?.[field]?.text;
  if (typeof text !== 'string' || !text) {
    throw new Error(`xfyun response missing payload.${field}.text`);
  }
  const decoded = Buffer.from(text, 'base64').toString('utf8');
  try {
    return JSON.parse(decoded) as T;
  } catch {
    throw new Error(`xfyun response payload.${field}.text is not valid JSON`);
  }
}

async function readAudioBase64(audioPath: string): Promise<string> {
  const file = await fs.readFile(audioPath);
  return file.toString('base64');
}

function encodeAudioBase64(audio: Buffer): string {
  return audio.toString('base64');
}

function buildCommonParameter(func: string, groupId: string, responseField: string): Record<string, unknown> {
  return {
    func,
    groupId,
    [responseField]: {
      encoding: 'utf8',
      compress: 'raw',
      format: 'json',
    },
  };
}

async function searchFeaBase64(
  config: XfyunConfig,
  audio: string,
  topK: number,
): Promise<XfyunSearchResponse> {
  if (Buffer.byteLength(audio, 'utf8') > 4_000_000) {
    throw new Error('xfyun search payload exceeds 4M after base64 encoding');
  }

  const response = await requestXfyun<any>(config, {
    header: {
      app_id: config.appId,
      status: 3,
    },
    parameter: {
      [config.servicePath]: {
        ...buildCommonParameter('searchFea', config.groupId, 'searchFeaRes'),
        topK,
      },
    },
    payload: {
      resource: {
        encoding: 'raw',
        sample_rate: 16000,
        channels: 1,
        bit_depth: 16,
        status: 3,
        audio,
      },
    },
  });

  const payload = response?.payload || {};
  const result = decodePayloadText<{ scoreList?: XfyunScoreItem[] }>(payload, 'searchFeaRes');
  const scoreList = Array.isArray(result.scoreList) ? result.scoreList : [];
  return {
    scoreList,
    raw: response,
    sid: typeof response?.header?.sid === 'string' ? response.header.sid : null,
  };
}

export async function searchFea(
  config: XfyunConfig,
  audioPath: string,
  topK = 2,
): Promise<XfyunSearchResponse> {
  const audio = await readAudioBase64(audioPath);
  try {
    return await searchFeaBase64(config, audio, topK);
  } catch (err) {
    if (String((err as Error)?.message ?? err).includes('payload exceeds 4M')) {
      throw new Error(`xfyun search payload exceeds 4M after base64 encoding: ${audioPath}`);
    }
    throw err;
  }
}

export async function searchFeaAudioBuffer(
  config: XfyunConfig,
  audioBuffer: Buffer,
  topK = 2,
): Promise<XfyunSearchResponse> {
  const audio = encodeAudioBase64(audioBuffer);
  if (Buffer.byteLength(audio, 'utf8') > 4_000_000) {
    throw new Error('xfyun search payload exceeds 4M after base64 encoding: audio buffer');
  }
  return searchFeaBase64(config, audio, topK);
}

export async function searchScoreFea(
  config: XfyunConfig,
  audioPath: string,
  featureId: string,
): Promise<XfyunFeatureResponse> {
  const audio = await readAudioBase64(audioPath);
  if (Buffer.byteLength(audio, 'utf8') > 4_000_000) {
    throw new Error(`xfyun searchScore payload exceeds 4M after base64 encoding: ${audioPath}`);
  }

  const response = await requestXfyun<any>(config, {
    header: {
      app_id: config.appId,
      status: 3,
    },
    parameter: {
      [config.servicePath]: {
        func: 'searchScoreFea',
        groupId: config.groupId,
        dstFeatureId: featureId,
        searchScoreFeaRes: {
          encoding: 'utf8',
          compress: 'raw',
          format: 'json',
        },
      },
    },
    payload: {
      resource: {
        encoding: 'raw',
        sample_rate: 16000,
        channels: 1,
        bit_depth: 16,
        status: 3,
        audio,
      },
    },
  });

  const payload = response?.payload || {};
  const result = decodePayloadText<{ score?: number; featureId?: string }>(payload, 'searchScoreFeaRes');
  return {
    featureId: result.featureId || featureId,
    raw: response,
    sid: typeof response?.header?.sid === 'string' ? response.header.sid : null,
  };
}

export async function createFeature(
  config: XfyunConfig,
  audioPath: string,
  featureId: string,
  featureInfo?: string,
): Promise<XfyunFeatureResponse> {
  const audio = await readAudioBase64(audioPath);
  if (Buffer.byteLength(audio, 'utf8') > 4_000_000) {
    throw new Error(`xfyun createFeature payload exceeds 4M after base64 encoding: ${audioPath}`);
  }

  const response = await requestXfyun<any>(config, {
    header: {
      app_id: config.appId,
      status: 3,
    },
    parameter: {
      [config.servicePath]: {
        func: 'createFeature',
        groupId: config.groupId,
        featureId,
        featureInfo,
        createFeatureRes: {
          encoding: 'utf8',
          compress: 'raw',
          format: 'json',
        },
      },
    },
    payload: {
      resource: {
        encoding: 'raw',
        sample_rate: 16000,
        channels: 1,
        bit_depth: 16,
        status: 3,
        audio,
      },
    },
  });

  const payload = response?.payload || {};
  const result = decodePayloadText<{ featureId?: string }>(payload, 'createFeatureRes');
  return {
    featureId: result.featureId || featureId,
    raw: response,
    sid: typeof response?.header?.sid === 'string' ? response.header.sid : null,
  };
}

export async function updateFeature(
  config: XfyunConfig,
  audioPath: string,
  featureId: string,
  featureInfo?: string,
): Promise<XfyunFeatureResponse> {
  const audio = await readAudioBase64(audioPath);
  if (Buffer.byteLength(audio, 'utf8') > 4_000_000) {
    throw new Error(`xfyun updateFeature payload exceeds 4M after base64 encoding: ${audioPath}`);
  }

  const response = await requestXfyun<any>(config, {
    header: {
      app_id: config.appId,
      status: 3,
    },
    parameter: {
      [config.servicePath]: {
        func: 'updateFeature',
        groupId: config.groupId,
        featureId,
        featureInfo,
        updateFeatureRes: {
          encoding: 'utf8',
          compress: 'raw',
          format: 'json',
        },
      },
    },
    payload: {
      resource: {
        encoding: 'raw',
        sample_rate: 16000,
        channels: 1,
        bit_depth: 16,
        status: 3,
        audio,
      },
    },
  });

  const payload = response?.payload || {};
  const result = decodePayloadText<{ featureId?: string }>(payload, 'updateFeatureRes');
  return {
    featureId: result.featureId || featureId,
    raw: response,
    sid: typeof response?.header?.sid === 'string' ? response.header.sid : null,
  };
}

export async function createGroup(
  config: XfyunConfig,
  groupName?: string,
  groupInfo?: string,
): Promise<XfyunGroupResponse> {
  const response = await requestXfyun<any>(config, {
    header: {
      app_id: config.appId,
      status: 3,
    },
    parameter: {
      [config.servicePath]: {
        func: 'createGroup',
        groupId: config.groupId,
        groupName,
        groupInfo,
        createGroupRes: {
          encoding: 'utf8',
          compress: 'raw',
          format: 'json',
        },
      },
    },
  });

  const payload = response?.payload || {};
  const result = decodePayloadText<{ msg?: string }>(payload, 'createGroupRes');
  return {
    msg: result.msg || 'success',
    raw: response,
    sid: typeof response?.header?.sid === 'string' ? response.header.sid : null,
  };
}

export async function queryFeatureList(config: XfyunConfig): Promise<Array<{ featureId: string; featureInfo?: string }>> {
  const response = await requestXfyun<any>(config, {
    header: {
      app_id: config.appId,
      status: 3,
    },
    parameter: {
      [config.servicePath]: {
        func: 'queryFeatureList',
        groupId: config.groupId,
        queryFeatureListRes: {
          encoding: 'utf8',
          compress: 'raw',
          format: 'json',
        },
      },
    },
  });

  const payload = response?.payload || {};
  const result = decodePayloadText<Array<{ featureId: string; featureInfo?: string }>>(payload, 'queryFeatureListRes');
  return Array.isArray(result) ? result : [];
}
