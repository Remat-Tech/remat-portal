import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  ApiError,
  type ClientsGrant,
  type ClientsRole,
  type ClientsRoles,
  clientsRoles,
  endClientsRole,
  grantClientsRole,
  isNotSignedIn,
} from '../../api';
import { RemoveButton } from '../../ActionButtons';
import { momentDate } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * Clients, the business development pipeline. #274.
 *
 * Reached only under `npm run web` while it is being built (see `CLIENTS_OPEN` in App.tsx); a
 * build has no card and sends `#/clients` back to the portal.
 *
 * Two views so far: the pipeline, which is still to come, at `#/clients`, and the roles screen
 * at `#/clients/roles`. The Roles tab is drawn only where the server answered the roles screen:
 * the page asks rather than decides, and the server refuses everybody else whatever is drawn.
 */
export function ClientsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const view = useClientsView();

  /* Undefined until the server has answered; null where it refused. */
  const [roles, setRoles] = useState<ClientsRoles | null | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);

    clientsRoles()
      .then((found) => {
        setRoles(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        /* Not a System Administrator: there is no roles screen to show them. */
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          setRoles(null);
          setProblem(undefined);
          return;
        }

        setProblem(problemFrom(error));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [onSignedOut]);

  useEffect(load, [load]);

  const mayManageRoles = roles !== null && roles !== undefined;

  return (
    <div className="portal">
      <main className="portal-page clients">
        <header className="directory-head">
          <a className="back" href="#/" aria-label="Back to Remat Portal">
            <Icon name="back" />
          </a>

          <h1>Clients</h1>
        </header>

        {mayManageRoles ? (
          <nav className="directory-views" aria-label="Clients views">
            <a href="#/clients" aria-current={view === 'pipeline' ? 'page' : undefined}>
              Pipeline
            </a>
            <a href="#/clients/roles" aria-current={view === 'roles' ? 'page' : undefined}>
              Roles
            </a>
          </nav>
        ) : null}

        {problem === undefined ? null : (
          <Notice problem={problem} retrying={loading} onRetry={load} />
        )}

        {/* For anybody the server refused, `#/clients/roles` is the pipeline: the address
            says nothing about a screen they cannot have, not even that it exists. Blank only
            while the server is still answering, so the pipeline does not flash first. */}
        {view === 'roles' && mayManageRoles ? (
          <RolesView roles={roles} onChanged={load} onSignedOut={onSignedOut} />
        ) : view === 'roles' && roles === undefined ? null : (
          <p>Clients is being built. The pipeline will open here.</p>
        )}
      </main>
    </div>
  );
}

const ROLE_NAMES: Record<ClientsRole, string> = {
  BD_MANAGER: 'BD manager',
  ASSOCIATE: 'Associate',
};

/** Who holds which role, a way to grant one, and a way to end each. CLI 94. */
function RolesView({
  roles,
  onChanged,
  onSignedOut,
}: {
  roles: ClientsRoles;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [role, setRole] = useState<ClientsRole>('ASSOCIATE');
  const [granting, setGranting] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const grant = () => {
    setGranting(true);
    setProblem(undefined);

    grantClientsRole(employeeId, role)
      .then(() => {
        setEmployeeId('');
        onChanged();
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      })
      .finally(() => {
        setGranting(false);
      });
  };

  return (
    <>
      <p className="muted">
        Granting a role lets somebody see clients. BD managers can also reassign work, read every
        meeting report and keep the products and lists. Only a portal system administrator can grant
        or end a role.
      </p>

      <form
        className="filter-bar clients-grant"
        onSubmit={(event) => {
          event.preventDefault();
          grant();
        }}
      >
        <label>
          <span className="visually-hidden">Person</span>
          <select
            value={employeeId}
            disabled={granting}
            required
            onChange={(event) => {
              setEmployeeId(event.target.value);
            }}
          >
            <option value="">Choose somebody…</option>
            {roles.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
                {person.jobTitle === null ? '' : `, ${person.jobTitle}`}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="visually-hidden">Role</span>
          <select
            value={role}
            disabled={granting}
            onChange={(event) => {
              setRole(event.target.value as ClientsRole);
            }}
          >
            <option value="ASSOCIATE">Associate</option>
            <option value="BD_MANAGER">BD manager</option>
          </select>
        </label>

        <button type="submit" className="primary" disabled={granting || employeeId === ''}>
          {granting ? 'Granting…' : 'Grant the role'}
        </button>
      </form>

      {problem === undefined ? null : <Notice problem={problem} />}

      {roles.grants.length === 0 ? (
        <div className="notice plain">
          <p>Nobody holds a role in clients yet. Start with a BD manager.</p>
        </div>
      ) : (
        <div className="directory-card">
          <table className="directory-table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Granted</th>
                <th scope="col">
                  <span className="visually-hidden">End</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {roles.grants.map((grant) => (
                <GrantRow
                  key={grant.id}
                  grant={grant}
                  onChanged={onChanged}
                  onSignedOut={onSignedOut}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function GrantRow({
  grant,
  onChanged,
  onSignedOut,
}: {
  grant: ClientsGrant;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const roleName = ROLE_NAMES[grant.role];

  const end = () => {
    setBusy(true);

    endClientsRole(grant.id)
      .then(onChanged)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
        setBusy(false);
      });
  };

  return (
    <tr>
      <td>
        {grant.holder.name}
        {grant.holder.jobTitle === null ? null : <small> {grant.holder.jobTitle}</small>}
        {grant.holder.current ? null : (
          <small className="clients-gone"> Not at the company today</small>
        )}
      </td>
      <td>{roleName}</td>
      <td>
        {momentDate(grant.grantedAt)}
        <small> by {grant.grantedBy.name}</small>
      </td>
      <td className="clients-end">
        {asking ? (
          <>
            <button type="button" className="linkish" disabled={busy} onClick={end}>
              {busy ? 'Ending…' : 'End it'}
            </button>{' '}
            <button
              type="button"
              className="linkish"
              disabled={busy}
              onClick={() => {
                setAsking(false);
              }}
            >
              Keep it
            </button>
          </>
        ) : (
          <RemoveButton
            label={`End ${grant.holder.name}'s ${roleName.toLowerCase()} role`}
            onClick={() => {
              setAsking(true);
            }}
          />
        )}
        {problem === undefined ? null : <Notice problem={problem} />}
      </td>
    </tr>
  );
}

type ClientsView = 'pipeline' | 'roles';

/** Which view the address names. Anything after `#/clients` that is not `roles` is the pipeline. */
function useClientsView(): ClientsView {
  return useSyncExternalStore(subscribe, viewInTheAddress, () => 'pipeline');
}

function subscribe(changed: () => void): () => void {
  window.addEventListener('hashchange', changed);

  return () => {
    window.removeEventListener('hashchange', changed);
  };
}

function viewInTheAddress(): ClientsView {
  const path = window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';

  return path === 'clients/roles' ? 'roles' : 'pipeline';
}
