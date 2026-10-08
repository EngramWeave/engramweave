import { fileURLToPath } from 'node:url';

// Both src/files and dist/files resolve to the Core-owned build artifact.
export const windowsFilesExecutable = fileURLToPath(new URL('../../dist/native/windows-files.exe', import.meta.url));
