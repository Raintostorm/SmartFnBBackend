import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export type PasswordResetEvent = { type: 'password-reset.requested' | 'password-reset.resolved'; chainId: string | null; requestId: string };

@Injectable()
export class PasswordResetEvents {
  readonly changes = new Subject<PasswordResetEvent>();
  publish(event: PasswordResetEvent) { this.changes.next(event); }
}
