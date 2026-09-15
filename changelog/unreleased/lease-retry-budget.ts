import type { Change } from '@absolutejs/changelog';
export const change: Change = {
  kind: 'fixed',
  summary: 'Count expired worker claims toward maxAttempts so repeated process death cannot retry a job indefinitely',
  symbols: ['createInMemoryJobStore'],
};
