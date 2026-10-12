import { CoreError } from '../errors.js';
import { normalizeVaultPath, excludedName } from '../files/paths.js';

export const changeSetId = (id: string) => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new CoreError('VALIDATION_ERROR', 'Invalid ChangeSet ID', 400);
  return id;
};
export const formalRoots = ['10_Ideas', '40_Knowledge', '50_Research', '60_Projects'] as const;
export function formalPath(input: string, directory = false) {
  const result = normalizeVaultPath(input); const parts = result.split('/');
  if (!formalRoots.some(root => root === parts[0]) || !directory && (parts.length < 2 || !/\.md$/i.test(result)) || parts.some(excludedName)) {
    throw new CoreError('PATH_OUTSIDE_SCOPE', 'Planner targets only formal Markdown and directories', 403);
  }
  return result;
}
export function changeSetFile(input: string) {
  const normalized = normalizeVaultPath(input); const parts = normalized.split('/');
  if (parts[0] !== '70_ChangeSets' || parts.length < 3) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Only ChangeSet files are permitted', 403);
  changeSetId(parts[1]!);
  if (parts.length === 3 && parts[2] === 'manifest.json') return normalized;
  if (parts[2] !== 'candidates') throw new CoreError('PATH_OUTSIDE_SCOPE', 'Invalid candidate mapping', 403);
  formalPath(parts.slice(3).join('/'));
  return normalized;
}
export const plannerTemplatePath = (input: string) => input === '90_System/Prompts/Planner.md';
