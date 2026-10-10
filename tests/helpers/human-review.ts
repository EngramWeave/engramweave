import { randomUUID } from 'node:crypto';
import type { HumanReviewRequest } from '@engramweave/contracts';
import { analyzerFixture } from './analyzer.js';
import { HumanReviewActions } from '../../packages/core/src/review/human.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';

export async function humanFixture(analyzed = true) {
  const f = await analyzerFixture(async () => { throw new CoreError('EXECUTION_FAILED', 'Ended failed analysis'); });
  if (analyzed) { await f.analyzer.submit(f.request()); await f.analyzer.wait(); }
  const create = () => new HumanReviewActions(f.config, f.db, () => false);
  const human = create(); await human.initialize();
  const request = async (action: HumanReviewRequest['action'], note = '', draft = f.draftPath): Promise<HumanReviewRequest> => ({
    request_id: randomUUID(), action, note, source_path: f.sourcePath, source_revision: (await readMarkdown(f.config.vault_path,f.sourcePath)).revision,
    draft_path: draft, draft_revision: (await readMarkdown(f.config.vault_path,draft)).revision,
  });
  return { ...f, create, human, request };
}
