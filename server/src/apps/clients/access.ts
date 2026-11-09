/**
 * What clients knows about who is asking: the clients roles they hold today. #274.
 *
 * The one way every clients service learns it, read fresh on each request from clients_role,
 * so a grant ended a moment ago is ended on the next click rather than at the next sign in.
 * The answer is handed to `clientsPolicy`, which decides; this only reads.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { ClientsAccess } from './policy.js';
import type { ClientsRoleRepository } from './role.db.js';

export async function accessOf(
  actor: Actor,
  grants: Pick<ClientsRoleRepository, 'rolesOf'>,
): Promise<ClientsAccess> {
  /* The system is nobody, and nobody holds a clients role. */
  return { holds: actor.employeeId === null ? [] : await grants.rolesOf(actor.employeeId) };
}
