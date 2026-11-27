/**
 * The door of clients: every `/api/clients` request comes through it first. #274, Clients SRS
 * CLI 93, NFR CLI SEC 04.
 *
 * Somebody with no clients role, who is not a System Administrator, is turned away here, before
 * any route runs, with exactly what an address with nothing at it answers. So every clients
 * endpoint, every id, and every address under `/api/clients` that is no endpoint at all, answers
 * them the same — including endpoints written after this, which cannot forget to.
 *
 * The refusal is still written to the denial log, as every refusal is (NFR SEC 03). Getting
 * through is not permission for anything: each route asks `clientsPolicy` its own question.
 *
 * One narrow way in besides (#292): the person the organisation names as its Chief Executive,
 * with no clients role, comes through to `/clients/me` and the CEO reports, and to nothing else.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Guard } from '../../core/auth/policy.js';
import { actorOf } from '../../core/http/identify.js';
import { NO_SUCH_ROUTE } from '../../core/http/problems.js';
import { accessOf, type ChiefExecutive } from './access.js';
import { clientsPolicy } from './policy.js';
import type { ClientsRoleRepository } from './role.db.js';

/** The addresses, under `/clients`, the Chief Executive may come through to. #292. */
const CEO_REPORT_PATHS = /^\/(me|ceo-reports(\/.*)?)\/?$/;

export function clientsDoor(
  guard: Guard,
  grants: Pick<ClientsRoleRepository, 'rolesOf'>,
  /** Who the Chief Executive is, to let them through to the CEO reports. #292. */
  chiefExecutive?: ChiefExecutive,
): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const actor = actorOf(response);
    const toCeoReports = chiefExecutive !== undefined && CEO_REPORT_PATHS.test(request.path);

    void accessOf(actor, grants, toCeoReports ? chiefExecutive : undefined)
      .then((access) => {
        const decision = clientsPolicy.enter(actor, access);

        /* The Chief Executive's narrow way in is a second chance; whoever has neither is
           written down as refused at the door, as anybody else is. */
        if (
          decision.allowed ||
          (toCeoReports && clientsPolicy.enterCeoReports(actor, access).allowed)
        ) {
          next();
          return;
        }

        guard.record(decision);
        response.status(404).json(NO_SUCH_ROUTE);
      })
      .catch(next);
  };
}
