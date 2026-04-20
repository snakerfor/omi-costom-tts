import 'dotenv/config';
import { db, initDb } from '../src/db';
import { mapSpeakersForConversation } from '../src/services/speaker-mapper';

interface Args {
  apply: boolean;
  from: string;
  to: string;
  limit: number | null;
  order: 'asc' | 'desc';
}

interface CountRow {
  key: string;
  cnt: number;
}

function parseArgs(): Args {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token?.startsWith('--')) continue;
    const next = process.argv[i + 1];
    const value = next && !next.startsWith('--') ? next : 'true';
    args.set(token.slice(2), value);
  }

  const now = new Date();
  const to = args.get('to') || now.toISOString();
  const days = Number(args.get('days') || '5');
  const parsedDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 5;
  const fromDefault = new Date(now.getTime() - parsedDays * 24 * 60 * 60 * 1000).toISOString();
  const from = args.get('from') || fromDefault;

  const limitArg = Number(args.get('limit'));
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : null;

  const orderArg = (args.get('order') || 'desc').toLowerCase();
  const order = orderArg === 'asc' ? 'asc' : 'desc';

  return {
    apply: args.get('apply') === 'true' || process.argv.includes('--apply'),
    from,
    to,
    limit,
    order,
  };
}

function loadMethodBreakdown(from: string, to: string): CountRow[] {
  return db.prepare(`
    SELECT COALESCE(cs.resolution_method, 'null') AS key, COUNT(*) AS cnt
    FROM conversation_segments cs
    JOIN conversations c ON c.id = cs.conversation_id
    WHERE c.created_at >= ? AND c.created_at < ?
    GROUP BY cs.resolution_method
    ORDER BY cnt DESC
  `).all(from, to) as CountRow[];
}

function loadWindowStats(from: string, to: string): {
  conversations: number;
  segments: number;
  mappedSegments: number;
  confirmedHitSegments: number;
} {
  const conversations = db.prepare(`
    SELECT COUNT(DISTINCT c.id) AS cnt
    FROM conversations c
    WHERE c.created_at >= ? AND c.created_at < ?
  `).get(from, to) as { cnt: number };

  const segments = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM conversation_segments cs
    JOIN conversations c ON c.id = cs.conversation_id
    WHERE c.created_at >= ? AND c.created_at < ?
  `).get(from, to) as { cnt: number };

  const mappedSegments = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM conversation_segments cs
    JOIN conversations c ON c.id = cs.conversation_id
    WHERE c.created_at >= ? AND c.created_at < ?
      AND cs.speaker_id IS NOT NULL
  `).get(from, to) as { cnt: number };

  const confirmedHitSegments = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM conversation_segments cs
    JOIN conversations c ON c.id = cs.conversation_id
    JOIN speakers s ON s.id = cs.speaker_id
    WHERE c.created_at >= ? AND c.created_at < ?
      AND s.status = 'confirmed'
  `).get(from, to) as { cnt: number };

  return {
    conversations: conversations.cnt || 0,
    segments: segments.cnt || 0,
    mappedSegments: mappedSegments.cnt || 0,
    confirmedHitSegments: confirmedHitSegments.cnt || 0,
  };
}

function loadTargetConversationIds(from: string, to: string, limit: number | null, order: 'asc' | 'desc'): string[] {
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const orderBy = order === 'asc' ? 'ASC' : 'DESC';
  const rows = db.prepare(`
    SELECT c.id
    FROM conversations c
    WHERE c.created_at >= ? AND c.created_at < ?
      AND EXISTS (
        SELECT 1
        FROM conversation_segments cs
        WHERE cs.conversation_id = c.id
      )
    ORDER BY c.created_at ${orderBy}
    ${limitClause}
  `).all(from, to) as Array<{ id: string }>;

  return rows.map(row => row.id);
}

async function main(): Promise<void> {
  initDb();
  const args = parseArgs();
  const beforeStats = loadWindowStats(args.from, args.to);
  const beforeMethods = loadMethodBreakdown(args.from, args.to);
  const targetConversationIds = loadTargetConversationIds(args.from, args.to, args.limit, args.order);

  console.log(
    `[backfill-window] mode=${args.apply ? 'apply' : 'dry-run'} from=${args.from} to=${args.to} order=${args.order} target_conversations=${targetConversationIds.length}`,
  );
  console.log('[backfill-window] before_stats=' + JSON.stringify(beforeStats));
  console.log('[backfill-window] before_methods=' + JSON.stringify(beforeMethods));

  if (!args.apply) {
    for (const conversationId of targetConversationIds.slice(0, 30)) {
      console.log(`[backfill-window] plan|conversation_id=${conversationId}`);
    }
    if (targetConversationIds.length > 30) {
      console.log(`[backfill-window] ... (${targetConversationIds.length - 30} more conversations)`);
    }
    return;
  }

  let success = 0;
  let failed = 0;
  for (const conversationId of targetConversationIds) {
    try {
      await mapSpeakersForConversation(conversationId);
      success += 1;
      console.log(`[backfill-window] done|conversation_id=${conversationId}`);
    } catch (err) {
      failed += 1;
      console.error(
        `[backfill-window] failed|conversation_id=${conversationId}|error=${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  const afterStats = loadWindowStats(args.from, args.to);
  const afterMethods = loadMethodBreakdown(args.from, args.to);
  console.log(`[backfill-window] result|success=${success}|failed=${failed}`);
  console.log('[backfill-window] after_stats=' + JSON.stringify(afterStats));
  console.log('[backfill-window] after_methods=' + JSON.stringify(afterMethods));
}

main().catch(err => {
  console.error('[backfill-window] failed:', err);
  process.exit(1);
});
