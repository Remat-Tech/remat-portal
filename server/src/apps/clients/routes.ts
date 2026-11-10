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
import { accessOf, viewsOf } from './access.js';
import type { Grant } from './role.js';
import type { ClientsRoleRepository } from './role.db.js';
import type { RoleService, RolesScreen } from './role.service.js';
import type { SetupService } from './setup.service.js';

export interface ClientsRoutes {
  /**
   * `clientsDoor`, which every request under `/clients` comes through first. Required, so there
   * is no way to build these routes without it.
   */
  door: RequestHandler;
  /** Who holds what, read for `/clients/me`. */
  grants: Pick<ClientsRoleRepository, 'rolesOf'>;
  /** The roles screen. A portal System Administrator's. */
  roles: RoleService;
  /** Products and lines. A BD manager's. Optional, so a test app without them has no such routes. */
  setup?: SetupService;
}

export function clientsRoutes({ door, grants, roles, setup }: ClientsRoutes): Router {
  const routes = Router();

  /* First, before any route below: somebody with no clients role is turned away here, from
     every address under /clients whether or not there is a route at it. NFR CLI SEC 04. */
  routes.use('/clients', door);

  /** Which parts of clients this person has, so the screen draws only those tabs. */
  routes.get('/clients/me', (_request: Request, response: Response, next: NextFunction) => {
    const actor = actorOf(response);

    void accessOf(actor, grants)
      .then((access) => {
        response.json(viewsOf(actor, access));
      })
      .catch(next);
  });

  if (setup !== undefined) {
    setupRoutes(routes, setup);
  }

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

/**
 * Products and lines, under `/clients/setup`. #293, Clients TDD 11. Every one asks
 * `clientsPolicy.setUp` through the service, so an associate is refused openly and somebody with
 * no role never gets past the door.
 */
function setupRoutes(routes: Router, setup: SetupService): void {
  /** Answers with the result, or with nothing where there is nothing to say. */
  const answer =
    (work: (request: Request, response: Response) => Promise<unknown>, status = 200) =>
    (request: Request, response: Response, next: NextFunction) => {
      void work(request, response)
        .then((result) => {
          if (result === undefined) {
            response.status(204).end();
          } else {
            response.status(status).json(result);
          }
        })
        .catch(next);
    };

  const idOf = (request: Request): string => String(request.params.id);

  /** Every line with its products, retired ones included. */
  routes.get(
    '/clients/setup/products',
    answer(async (_request, response) => ({
      lines: await setup.lines(actorOf(response)),
    })),
  );

  /** `{ name }`. */
  routes.post(
    '/clients/setup/lines',
    answer((request, response) => setup.addLine(actorOf(response), request.body), 201),
  );

  /** `{ lineId, name }`. */
  routes.post(
    '/clients/setup/products',
    answer((request, response) => setup.addProduct(actorOf(response), request.body), 201),
  );

  /** `{ name }`. */
  routes.patch(
    '/clients/setup/lines/:id',
    answer((request, response) => setup.renameLine(actorOf(response), idOf(request), request.body)),
  );

  routes.patch(
    '/clients/setup/products/:id',
    answer((request, response) =>
      setup.renameProduct(actorOf(response), idOf(request), request.body),
    ),
  );

  routes.post(
    '/clients/setup/lines/:id/retire',
    answer((request, response) => setup.retireLine(actorOf(response), idOf(request))),
  );

  routes.post(
    '/clients/setup/lines/:id/restore',
    answer((request, response) => setup.restoreLine(actorOf(response), idOf(request))),
  );

  routes.post(
    '/clients/setup/products/:id/retire',
    answer((request, response) => setup.retireProduct(actorOf(response), idOf(request))),
  );

  routes.post(
    '/clients/setup/products/:id/restore',
    answer((request, response) => setup.restoreProduct(actorOf(response), idOf(request))),
  );
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
