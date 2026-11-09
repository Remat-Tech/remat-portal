/**
 * Clients, over HTTP. #274, Clients TDD 11.
 *
 * The business development and customer success department's pipeline: clients, their
 * opportunities, POCs and the reports made from them. Every route is under `/clients`, and
 * every one asks `clientsPolicy` through its service; none decides anything itself.
 *
 * Still being built, so app.ts mounts this outside production only: `/api/clients` answers 404
 * there until it goes live, and the portal home shows no clients card there either.
 */

import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';
import { actorOf } from '../../core/http/identify.js';
import type { Grant } from './role.js';
import type { RoleService, RolesScreen } from './role.service.js';

export interface ClientsRoutes {
  /**
   * `clientsDoor`, which every request under `/clients` comes through first. Required, so there
   * is no way to build these routes without it.
   */
  door: RequestHandler;
  /** The roles screen. A portal System Administrator's. */
  roles: RoleService;
}

export function clientsRoutes({ door, roles }: ClientsRoutes): Router {
  const routes = Router();

  /* First, before any route below: somebody with no clients role is turned away here, from
     every address under /clients whether or not there is a route at it. NFR CLI SEC 04. */
  routes.use('/clients', door);

  /** Who holds which role, and who could be granted one. */
  routes.get('/clients/roles', (_request: Request, response: Response, next: NextFunction) => {
    void roles
      .screen(actorOf(response))
      .then((screen) => {
        response.json(screenAsJson(screen));
      })
      .catch(next);
  });

  /** Grants a role: `{ employeeId, role }`. */
  routes.post('/clients/roles', (request: Request, response: Response, next: NextFunction) => {
    void roles
      .grant(actorOf(response), request.body)
      .then((grant) => {
        response.status(201).json(grantAsJson(grant));
      })
      .catch(next);
  });

  /** Ends a grant. The row stays, as the record that it was held and who ended it. */
  routes.delete(
    '/clients/roles/:id',
    (request: Request, response: Response, next: NextFunction) => {
      void roles
        .end(actorOf(response), String(request.params.id))
        .then((grant) => {
          response.json(grantAsJson(grant));
        })
        .catch(next);
    },
  );

  return routes;
}

function screenAsJson(screen: RolesScreen): unknown {
  return {
    today: screen.today,
    grants: screen.grants.map((grant) => ({
      ...grant,
      grantedAt: grant.grantedAt.toISOString(),
    })),
    people: screen.people,
  };
}

function grantAsJson(grant: Grant): unknown {
  return {
    id: grant.id,
    employeeId: grant.employeeId,
    role: grant.role,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt.toISOString(),
    endedAt: grant.endedAt?.toISOString() ?? null,
    endedBy: grant.endedBy,
    endedReason: grant.endedReason,
  };
}
