import { createHmac, timingSafeEqual } from 'node:crypto';
import { decimal } from './types.js';

export interface ProposalCursor { v: 1; community: string; before: string; ceiling: string; state: string }
export function pageLimit(value: string | null): number {
  if (value === null) return 20;
  if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new Error('limit must be between 1 and 100');
  return Number(value);
}
export class CursorCodec {
  constructor(private secret: string) {
    if (secret.length < 24) throw new Error('Cursor secret must have at least 24 characters');
  }
  encode(value: ProposalCursor): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }
  decode(value: string, community: string, state = ''): ProposalCursor {
    if (value.length > 1000) throw new Error('Invalid cursor');
    const [body, signature, extra] = value.split('.');
    if (!body || !signature || extra) throw new Error('Invalid cursor');
    const expected = createHmac('sha256', this.secret).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid cursor signature');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString()) as ProposalCursor;
    if (decoded.v !== 1 || decoded.community !== community || decoded.state !== state) throw new Error('Cursor belongs to a different query');
    decimal(decoded.before); decimal(decoded.ceiling);
    return decoded;
  }
}
