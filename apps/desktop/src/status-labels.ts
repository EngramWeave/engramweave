import type { Source } from '@engramweave/contracts';

const processingLabels: Record<NonNullable<Source['processing_status']>, string> = {
  pending: 'Pending', compiled: 'Compiled', reviewed: 'Reviewed', planned: 'Planned', archived: 'Archived',
};
export const processingLabel = (status: Source['processing_status']) => status === null ? 'Not set' : processingLabels[status];
export const lifecycleLabel = (status: Source['lifecycle_status']) => status === null ? 'Unknown' : status === 'active' ? 'Active' : 'Discarded';
