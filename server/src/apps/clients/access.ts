/**
 * What clients knows about who is asking: the clients roles they hold today. #274.
 *
 * The one way every clients service learns it, read fresh on each request from clients_role,
 * so a grant ended a moment ago is ended on the next click rather than at the next sign in.
 * The answer is handed to `clientsPolicy`, which decides; this only reads.
 */

import type { Actor } from '../../core/auth/actor.js';
import { type ClientsAccess, clientsPolicy } from './policy.js';
import type { ClientsRoleRepository } from './role.db.js';

/**
 * Which parts of clients this person has, so the screen draws only those tabs. Each is the
 * policy's own answer to the question that part's routes ask; the routes still refuse whatever
 * the screen draws.
 */
export interface ClientsViews {
  /** Products and lines, and later checklists and reasons. A BD manager's. */
  setUp: boolean;
  /** Who holds which role. A portal System Administrator's. */
  manageRoles: boolean;
  /** Past proposals and financials, to start a new one from (CLI 66, #281). Anybody with a role. */
  pastProposals: boolean;
  /** The POC list and pages (CLI 100, CLI 101, #285). Anybody with a role. */
  pocs: boolean;
  /** Drafting and submitting CEO reports (#292). A BD manager's. */
  draftCeoReports: boolean;
  /** Reading the CEO reports submitted to them (#292). The Chief Executive's. */
  readCeoReports: boolean;
}

export function viewsOf(actor: Actor, access: ClientsAccess): ClientsViews {
  return {
    setUp: clientsPolicy.setUp(actor, access).allowed,
    manageRoles: clientsPolicy.manageRoles(actor, access).allowed,
    pastProposals: clientsPolicy.read(actor, access).allowed,
    pocs: clientsPolicy.read(actor, access).allowed,
    draftCeoReports: clientsPolicy.ceoReport(actor, access).allowed,
    readCeoReports: clientsPolicy.ceoReportScope(actor, access)?.everySubmitted === true,
  };
}

/** Who the organisation names as its Chief Executive, or null. #292. */
export type ChiefExecutive = () => Promise<string | null>;

export async function accessOf(
  actor: Actor,
  grants: Pick<ClientsRoleRepository, 'rolesOf'>,
  /** Asked only where the CEO reports are; left out, nobody is the Chief Executive. */
  chiefExecutive?: ChiefExecutive,
): Promise<ClientsAccess> {
  /* The system is nobody, and nobody holds a clients role. */
  if (actor.employeeId === null) {
    return { holds: [] };
  }

  const holds = await grants.rolesOf(actor.employeeId);
  if (chiefExecutive === undefined) {
    return { holds };
  }

  return { holds, isChiefExecutive: (await chiefExecutive()) === actor.employeeId };
}
