import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { type ClientsViews, clientsViews, isNotSignedIn } from '../../api';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { RolesView } from './RolesView';
import { SetupView } from './SetupView';

/**
 * Clients, the business development pipeline. #274, #293.
 *
 * Reached only under `npm run web` while it is being built (see `CLIENTS_OPEN` in App.tsx); a
 * build has no card and sends `#/clients` back to the portal.
 *
 * The views so far: the pipeline, still to come, at `#/clients`; setup, a BD manager's, at
 * `#/clients/setup`; and roles, a System Administrator's, at `#/clients/roles`. Which tabs are
 * drawn is the server's answer, from `/api/clients/me`: the page asks rather than decides, and
 * every route refuses whoever it refuses whatever is drawn.
 */
export function ClientsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const view = useClientsView();

  /* Undefined until the server has answered. */
  const [views, setViews] = useState<ClientsViews | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);

    clientsViews()
      .then((found) => {
        setViews(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [onSignedOut]);

  useEffect(load, [load]);

  /* For anybody without it, a view's address is the pipeline: the address says nothing about a
     screen they cannot have, not even that it exists. */
  const showing: ClientsView =
    (view === 'setup' && views?.setUp === true) || (view === 'roles' && views?.manageRoles === true)
      ? view
      : 'pipeline';

  return (
    <div className="portal">
      <main className="portal-page clients">
        <header className="directory-head">
          <a className="back" href="#/" aria-label="Back to Remat Portal">
            <Icon name="back" />
          </a>

          <h1>Clients</h1>
        </header>

        {views?.setUp === true || views?.manageRoles === true ? (
          <nav className="directory-views" aria-label="Clients views">
            <a href="#/clients" aria-current={showing === 'pipeline' ? 'page' : undefined}>
              Pipeline
            </a>
            {views.setUp ? (
              <a href="#/clients/setup" aria-current={showing === 'setup' ? 'page' : undefined}>
                Setup
              </a>
            ) : null}
            {views.manageRoles ? (
              <a href="#/clients/roles" aria-current={showing === 'roles' ? 'page' : undefined}>
                Roles
              </a>
            ) : null}
          </nav>
        ) : null}

        {problem === undefined ? null : (
          <Notice problem={problem} retrying={loading} onRetry={load} />
        )}

        {/* Blank while the server is still answering, so the pipeline does not flash in front
            of the view the address asked for. */}
        {views === undefined ? null : showing === 'setup' ? (
          <SetupView onSignedOut={onSignedOut} />
        ) : showing === 'roles' ? (
          <RolesView onSignedOut={onSignedOut} />
        ) : (
          <p>Clients is being built. The pipeline will open here.</p>
        )}
      </main>
    </div>
  );
}

type ClientsView = 'pipeline' | 'setup' | 'roles';

/** Which view the address names. Anything after `#/clients` it does not know is the pipeline. */
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

  if (path === 'clients/roles') {
    return 'roles';
  }

  return path === 'clients/setup' || path.startsWith('clients/setup/') ? 'setup' : 'pipeline';
}
