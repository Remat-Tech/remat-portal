import { Icon } from '../../Icon';

/**
 * Where the portal's Clients card lands while clients is being built.
 *
 * Reached only under `npm run web` (see `CLIENTS_OPEN` in App.tsx); a build shows the card as
 * "Coming soon" and sends `#/clients` back to the portal. The pipeline replaces this page.
 */
export function ClientsPage() {
  return (
    <div className="portal">
      <main className="portal-page">
        <header className="directory-head">
          <a className="back" href="#/" aria-label="Back to Remat Portal">
            <Icon name="back" />
          </a>

          <h1>Clients</h1>
        </header>

        <p>Clients is being built. The pipeline will open here.</p>
      </main>
    </div>
  );
}
