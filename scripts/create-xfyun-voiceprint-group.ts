require('dotenv').config();

import { createGroup, getXfyunVoiceprintConfig } from '../src/services/voiceprint/xfyun-client';

async function main(): Promise<void> {
  const config = getXfyunVoiceprintConfig();
  if (!config) {
    throw new Error('XFYUN_APP_ID, XFYUN_API_KEY, XFYUN_API_SECRET and XFYUN_GROUP_ID are required');
  }

  const groupName = process.env.XFYUN_GROUP_NAME || config.groupId;
  const groupInfo = process.env.XFYUN_GROUP_INFO || 'OMI Segment Voiceprint MVP';
  const result = await createGroup(config, groupName, groupInfo);
  console.log(JSON.stringify({ ok: true, groupId: config.groupId, msg: result.msg, sid: result.sid || null }));
}

main().catch(err => {
  console.error(String((err as Error)?.message ?? err));
  process.exit(1);
});
