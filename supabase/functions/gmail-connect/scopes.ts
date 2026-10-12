// Which Google permissions to ask for (issue #22): Gmail is always needed; calendar and tasks only for a member who may use them
// (Pro, or everybody while billing is not enforced). A member who cannot use them is never asked for them (least privilege).
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks.readonly';
export function scopeFor(pro: boolean | null): string {
  return (pro === true ? [GMAIL_SCOPE, CALENDAR_SCOPE, TASKS_SCOPE] : [GMAIL_SCOPE]).concat(['openid', 'email']).join(' ');
}