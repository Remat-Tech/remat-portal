/** How often one person may knock on one door. NFR SEC 03. */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { type Guard, policyFor } from '../auth/policy.js';
import { actorOf } from './identify.js';

/** At most `max` requests in any one window, for one person. */
export interface RateLimit {
  max: number;
  windowSeconds: number;
}

/** Over a limit. The sentence is the route's, and `Retry-After` says when. */
export class TooManyRequests extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'TooManyRequests';
  }
}

const about = policyFor('rate limit');

/**
 * Refuses a person's requests past `limit`, until the window they started ends.
 *
 * Mounted behind identify, because it counts by who is asking rather than by address: an office
 * shares one address, and a proxy decides what the address looks like. So it holds one entry per
 * employee, and needs no sweeping.
 *
 * Held in this process, so a restart forgets it and each process counts for itself. That is what
 * this is for: slowing somebody down, rather than a figure anything else relies on.
 *
 * One handler is one count, however many routes it is put in front of. A refusal goes to the
 * denial log, as every other does. NFR SEC 03.
 */
export function rateLimit(
  guard: Guard,
  action: string,
  limit: RateLimit,
  told: string,
  now: () => number = Date.now,
): RequestHandler {
  const windowMilliseconds = limit.windowSeconds * 1000;
  const windows = new Map<string, { startedAt: number; used: number }>();

  return (_request: Request, response: Response, next: NextFunction) => {
    const actor = actorOf(response);
    const key = actor.employeeId ?? actor.description;
    const at = now();
    const running = windows.get(key);

    if (running === undefined || at - running.startedAt >= windowMilliseconds) {
      windows.set(key, { startedAt: at, used: 1 });
      next();
      return;
    }

    if (running.used < limit.max) {
      running.used += 1;
      next();
      return;
    }

    const retryAfterSeconds = Math.ceil((running.startedAt + windowMilliseconds - at) / 1000);

    guard.record(
      about.refuse(
        actor,
        action,
        null,
        `more than ${String(limit.max)} in ${String(limit.windowSeconds)} seconds`,
      ),
    );

    response.set('Retry-After', String(retryAfterSeconds));
    next(new TooManyRequests(told, retryAfterSeconds));
  };
}
