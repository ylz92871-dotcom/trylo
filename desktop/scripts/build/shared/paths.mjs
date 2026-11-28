import { fileURLToPath } from 'node:url';

export const desktopRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
