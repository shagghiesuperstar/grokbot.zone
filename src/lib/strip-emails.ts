// Bot author/description text is harvested from third parties and sometimes carries a contact
// address. Every public surface (pages, JSON, feeds, digests) shows it through this helper.
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const stripEmails = (s: string): string => s.replace(EMAIL_RE, '[email hidden]');
