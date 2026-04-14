import * as path from 'path';

function resolveFrom(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

export const appRoot = path.resolve(process.cwd());
export const dataRoot = resolveFrom(appRoot, process.env.DATA_ROOT ?? '.');
const hasDataRootOverride = !!process.env.DATA_ROOT;

export const dbPathDefault = resolveFrom(dataRoot, 'app.db');
export const audioUploadsDir = resolveFrom(dataRoot, process.env.AUDIO_UPLOADS_DIR ?? 'audio-uploads');
export const rawResultsDir = resolveFrom(dataRoot, process.env.RAW_RESULTS_DIR ?? 'raw_results');
export const finalizedResultsDir = resolveFrom(dataRoot, process.env.FINALIZED_RESULTS_DIR ?? 'finalized_results');
export const previewResultsDir = resolveFrom(dataRoot, process.env.PREVIEW_RESULTS_DIR ?? 'preview_results');
export const clipsDir = process.env.CLIPS_DIR
  ? resolveFrom(dataRoot, process.env.CLIPS_DIR)
  : hasDataRootOverride
    ? resolveFrom(dataRoot, 'clips')
    : resolveFrom(appRoot, path.join('data', 'clips'));
export const omiSyncVideoRoot = process.env.OMI_SYNC_VIDEO_ROOT
  ? resolveFrom(dataRoot, process.env.OMI_SYNC_VIDEO_ROOT)
  : hasDataRootOverride
    ? resolveFrom(dataRoot, 'omi-videos')
    : resolveFrom(appRoot, path.join('data', 'omi-videos'));

export const publicDir = resolveFrom(appRoot, process.env.PUBLIC_DIR ?? 'public');
export const adminDir = path.join(publicDir, 'admin');
export const previewStaticDir = path.join(publicDir, 'preview');
