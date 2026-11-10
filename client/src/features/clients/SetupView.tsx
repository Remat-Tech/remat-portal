import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  ApiError,
  addProduct,
  addProductLine,
  type ClientsProduct,
  type ClientsProductLine,
  isNotSignedIn,
  productLines,
  renameSetupThing,
  retireOrRestore,
  type SetupThing,
} from '../../api';
import { EditButton } from '../../ActionButtons';
import { day } from '../../format';
import { Icon, type IconName } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * Setup, for a BD manager: a menu of its sections down the side, and the one chosen beside it.
 * Products and lines so far; checklists and reasons join the menu when they are built.
 * #293, Clients SRS CLI 07, CLI 08, CLI 104.
 *
 * Drawn only where `/api/clients/me` said this person may set up; every change is refused by the
 * server to anybody else, whatever is drawn.
 */
export function SetupView({ onSignedOut }: { onSignedOut: () => void }) {
  /* Products is the one section built so far. */
  const current: SetupSection = 'products';

  return (
    <div className="clients-setup">
      <nav className="clients-setup-menu" aria-label="Setup sections">
        <p className="clients-setup-menu-title">Setup</p>
        <ul>
          {SECTIONS.map((section) => (
            <li key={section.id}>
              {section.built ? (
                <a
                  href={`#/clients/setup/${section.id}`}
                  aria-current={section.id === current ? 'page' : undefined}
                >
                  <Icon name={section.icon} />
                  {section.label}
                </a>
              ) : (
                /* Not built yet: shown greyed out, so the page has the shape it will have, and
                   not a link, so it leads nowhere. */
                <span className="is-unbuilt" aria-disabled="true">
                  <Icon name={section.icon} />
                  {section.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      </nav>

      <ProductsSection onSignedOut={onSignedOut} />
    </div>
  );
}

type SetupSection = 'products' | 'checklists' | 'reasons';

/**
 * Each section of setup, in the order a BD manager is likely to want them. `built` turns to true
 * as each arrives (CLI 39, CLI 54), and its item becomes a link.
 */
const SECTIONS: readonly {
  id: SetupSection;
  label: string;
  icon: IconName;
  built: boolean;
}[] = [
  { id: 'products', label: 'Products', icon: 'list', built: true },
  { id: 'checklists', label: 'Checklists', icon: 'checklist', built: false },
  { id: 'reasons', label: 'Lost and exit reasons', icon: 'exit-reasons', built: false },
];

/** Which form at the top is open, if either. */
/** Which dialog is open, if either; a product's may start in a chosen line. */
type Adding = { what: 'product'; lineId?: string } | { what: 'line' } | null;

function ProductsSection({ onSignedOut }: { onSignedOut: () => void }) {
  const [lines, setLines] = useState<ClientsProductLine[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<Adding>(null);
  /**
   * The lines shown open. Kept here rather than on each card, so the page reloading after a
   * change leaves open what was open. Every line starts closed: with many products the page is
   * a list of lines to choose from, not a wall to scroll.
   */
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const toggle = useCallback((lineId: string) => {
    setOpen((was) => {
      const next = new Set(was);

      if (next.has(lineId)) {
        next.delete(lineId);
      } else {
        next.add(lineId);
      }
      return next;
    });
  }, []);

  const load = useCallback(() => {
    productLines()
      .then((found) => {
        setLines(found);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      });
  }, [onSignedOut]);

  useEffect(load, [load]);

  /**
   * Runs one change, then reloads the page's lines. True where it went through, so a form can
   * close; false where the server refused, whose sentence is then shown.
   */
  const act = useCallback(
    async (change: () => Promise<void>): Promise<boolean> => {
      setBusy(true);
      setProblem(undefined);

      try {
        await change();
        load();
        return true;
      } catch (error: unknown) {
        if (isNotSignedIn(error)) {
          onSignedOut();
        } else {
          setProblem(problemFrom(error));
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, onSignedOut],
  );

  const liveLines = (lines ?? []).filter((line) => line.retiredOn === null);

  return (
    <section className="clients-setup-body">
      <header className="clients-setup-head">
        <h2>
          Products
          <InfoTip text="Every product belongs to one line. A retired product takes no new deals, and everything already recorded against it stays." />
        </h2>

        <AddMenu
          disabled={busy}
          productBlocked={liveLines.length === 0 ? 'Add a line first' : undefined}
          onPick={(what) => {
            setAdding({ what });
          }}
        />
      </header>

      {adding?.what === 'product' ? (
        <AddProductDialog
          lines={liveLines}
          initialLineId={adding.lineId}
          onAdded={(lineId) => {
            /* Open the line it went into, so it is seen where it landed. */
            setOpen((was) => new Set(was).add(lineId));
            load();
          }}
          onSignedOut={onSignedOut}
          onClose={() => {
            setAdding(null);
          }}
        />
      ) : null}

      {adding?.what === 'line' ? (
        <AddLineDialog
          onAdded={load}
          onSignedOut={onSignedOut}
          onClose={() => {
            setAdding(null);
          }}
        />
      ) : null}

      {problem === undefined ? null : <Notice problem={problem} />}

      {lines === undefined ? null : lines.length === 0 ? (
        <div className="notice plain">
          <p>There are no product lines yet. Use + to add a line, then the products in it.</p>
        </div>
      ) : (
        <>
          <div className="clients-lines-bar">
            <p className="muted">
              {lines.length === 1 ? '1 line' : `${String(lines.length)} lines`},{' '}
              {countOf(lines.flatMap((line) => line.products))}
            </p>
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setOpen(
                  open.size === lines.length ? new Set() : new Set(lines.map((line) => line.id)),
                );
              }}
            >
              {open.size === lines.length ? 'Collapse all' : 'Expand all'}
            </button>
          </div>

          {lines.map((line) => (
            <LineCard
              key={line.id}
              line={line}
              expanded={open.has(line.id)}
              onToggle={() => {
                toggle(line.id);
              }}
              onAddProduct={() => {
                setAdding({ what: 'product', lineId: line.id });
              }}
              busy={busy}
              act={act}
              reload={load}
              onSignedOut={onSignedOut}
            />
          ))}
        </>
      )}
    </section>
  );
}

type Act = (change: () => Promise<void>) => Promise<boolean>;

/** "3 products", and how many of them are retired where any are. */
function countOf(products: readonly ClientsProduct[]): string {
  const live = products.filter((product) => product.retiredOn === null).length;
  const retired = products.length - live;

  return (
    (live === 1 ? '1 product' : `${String(live)} products`) +
    (retired === 0 ? '' : `, ${String(retired)} retired`)
  );
}

/** A line: its head always, its products only while it is open. */
function LineCard({
  line,
  expanded,
  onToggle,
  onAddProduct,
  busy,
  act,
  reload,
  onSignedOut,
}: {
  line: ClientsProductLine;
  expanded: boolean;
  onToggle: () => void;
  /** Adding a product to this line, from inside it. */
  onAddProduct: () => void;
  busy: boolean;
  act: Act;
  reload: () => void;
  onSignedOut: () => void;
}) {
  const productsId = useId();
  const live = line.products.filter((product) => product.retiredOn === null).length;

  return (
    <div
      className={`clients-line${line.retiredOn === null ? '' : ' is-retired'}${expanded ? ' is-open' : ''}`}
    >
      <Row
        thing="lines"
        id={line.id}
        name={line.name}
        retiredOn={line.retiredOn}
        busy={busy}
        act={act}
        reload={reload}
        onSignedOut={onSignedOut}
        toggle={{ expanded, onToggle, controls: productsId }}
        heading={<small>{countOf(line.products)}</small>}
        retireAsks={
          live === 0
            ? undefined
            : `Retire ${line.name} and the ${live === 1 ? 'product' : `${String(live)} products`} in it?`
        }
      />

      {expanded ? (
        <div id={productsId} className="clients-line-products">
          {line.products.length === 0 ? (
            <p className="clients-product clients-line-empty muted">
              No products in {line.name} yet.
            </p>
          ) : (
            line.products.map((product: ClientsProduct) => (
              <Row
                key={product.id}
                thing="products"
                id={product.id}
                name={product.name}
                retiredOn={product.retiredOn}
                busy={busy}
                act={act}
                reload={reload}
                onSignedOut={onSignedOut}
                /* Restored into a retired line is refused; say why before it is tried. */
                restoreBlocked={line.retiredOn === null ? undefined : `Restore ${line.name} first`}
              />
            ))
          )}

          {/* Adding from inside the line is what makes plain that a product lives in one. */}
          {line.retiredOn === null ? (
            <button
              type="button"
              className="clients-add-to-line"
              disabled={busy}
              onClick={onAddProduct}
            >
              <Icon name="plus" />
              Add a product to {line.name}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One line or product: its name, with a pencil beside it to edit the name where it stands, and
 * retired or restored on the right.
 */
function Row({
  thing,
  id,
  name,
  retiredOn,
  busy,
  act,
  reload,
  onSignedOut,
  heading,
  toggle,
  retireAsks,
  restoreBlocked,
}: {
  thing: SetupThing;
  id: string;
  name: string;
  retiredOn: string | null;
  busy: boolean;
  act: Act;
  reload: () => void;
  onSignedOut: () => void;
  /** Present on a line's own row, which is its card's heading. */
  heading?: ReactNode;
  /** On a line's row: whether its products are showing, and showing or hiding them. */
  toggle?: { expanded: boolean; onToggle: () => void; controls: string };
  /** A question to confirm before retiring, where retiring takes more with it. */
  retireAsks?: string;
  restoreBlocked?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const isLine = heading !== undefined;
  const what = isLine ? 'line' : 'product';

  return (
    <div className={isLine ? 'clients-line-head' : 'clients-product'}>
      {editing ? (
        <InlineName
          thing={thing}
          id={id}
          name={name}
          label={`Name of the ${what} ${name}`}
          isLine={isLine}
          onSaved={() => {
            reload();
            setEditing(false);
          }}
          onCancel={() => {
            setEditing(false);
          }}
          onSignedOut={onSignedOut}
        />
      ) : (
        <span className="clients-setup-name">
          {toggle === undefined ? (
            isLine ? (
              <strong>{name}</strong>
            ) : (
              <span>{name}</span>
            )
          ) : (
            /* The chevron and the name are one target, so the whole name opens the line. */
            <button
              type="button"
              className="clients-line-toggle"
              aria-expanded={toggle.expanded}
              aria-controls={toggle.controls}
              onClick={toggle.onToggle}
            >
              <Icon name="down" />
              <strong>{name}</strong>
            </button>
          )}
          <EditButton
            className="clients-edit-name"
            label={`Edit the name of the ${what} ${name}`}
            disabled={busy}
            onClick={() => {
              setEditing(true);
            }}
          />
          {heading}
          {retiredOn === null ? null : (
            <span className="clients-retired">Retired {day(retiredOn)}</span>
          )}
        </span>
      )}

      {editing ? null : (
        <span className="clients-setup-buttons">
          {asking ? (
            <>
              <span className="clients-ask">{retireAsks}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void act(() => retireOrRestore(thing, id, 'retire')).then(() => {
                    setAsking(false);
                  });
                }}
              >
                Retire
              </button>
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
          ) : retiredOn === null ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (retireAsks === undefined) {
                  void act(() => retireOrRestore(thing, id, 'retire'));
                } else {
                  setAsking(true);
                }
              }}
            >
              {isLine ? 'Retire line' : 'Retire'}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || restoreBlocked !== undefined}
              title={restoreBlocked}
              onClick={() => {
                void act(() => retireOrRestore(thing, id, 'restore'));
              }}
            >
              {isLine ? 'Restore line' : 'Restore'}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * A name, edited where it stands. Enter or the tick saves, Escape or the cross puts it back, and
 * a name somebody else already has is said right under the box, which stays open to fix it.
 * Saving the name it already had just closes it.
 */
function InlineName({
  thing,
  id,
  name,
  label,
  isLine,
  onSaved,
  onCancel,
  onSignedOut,
}: {
  thing: SetupThing;
  id: string;
  name: string;
  label: string;
  isLine: boolean;
  onSaved: () => void;
  onCancel: () => void;
  onSignedOut: () => void;
}) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const errorId = useId();

  const save = () => {
    if (value.trim() === name) {
      onCancel();
      return;
    }

    setBusy(true);
    setError(undefined);

    renameSetupThing(thing, id, value)
      .then(onSaved)
      .catch((failure: unknown) => {
        if (isNotSignedIn(failure)) {
          onSignedOut();
          return;
        }
        setError(problemFrom(failure).what);
        setBusy(false);
      });
  };

  return (
    <form
      className={`clients-inline-name${isLine ? ' is-line' : ''}${error === undefined ? '' : ' has-error'}`}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <span className="clients-inline-row">
        <input
          value={value}
          maxLength={80}
          aria-label={label}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
          autoFocus
          autoComplete="off"
          disabled={busy}
          onFocus={(event) => {
            event.target.select();
          }}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
        />
        <button
          type="submit"
          className="iconic clients-inline-save"
          title="Save"
          aria-label="Save the name"
          disabled={busy || value.trim() === ''}
        >
          <Icon name="tick" />
        </button>
        <button
          type="button"
          className="iconic clients-inline-cancel"
          title="Cancel"
          aria-label="Cancel, and keep the name as it was"
          disabled={busy}
          onClick={onCancel}
        >
          <Icon name="cross" />
        </button>
      </span>
      {error === undefined ? null : (
        <p id={errorId} className="clients-field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * One "+" button that opens a short menu of what can be added. A menu button as a screen reader
 * expects one: it says it has a menu and whether it is open, the arrow keys move between the
 * items, Escape or a click anywhere else closes it, and focus goes back to the button.
 */
function AddMenu({
  disabled,
  productBlocked,
  onPick,
}: {
  disabled: boolean;
  /** Why a product cannot be added yet, where it cannot. */
  productBlocked: string | undefined;
  onPick: (what: 'product' | 'line') => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrapper = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);

  /* The parent first, and a word on each, so the two are not jargon to decode. */
  const items: { what: 'product' | 'line'; label: string; hint: string; blocked?: string }[] = [
    { what: 'line', label: 'Product line', hint: 'Groups related products' },
    {
      what: 'product',
      label: 'Product',
      hint: 'Goes in a product line',
      blocked: productBlocked,
    },
  ];

  /* A click anywhere outside closes it. */
  useEffect(() => {
    if (!open) {
      return;
    }

    const away = (event: MouseEvent) => {
      if (wrapper.current !== null && !wrapper.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', away);

    return () => {
      document.removeEventListener('mousedown', away);
    };
  }, [open]);

  /* Opened, the first item that can be chosen takes focus, so the keys work straight away. */
  useEffect(() => {
    if (open) {
      wrapper.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    }
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const move = (from: HTMLElement, step: 1 | -1) => {
    const enabled = Array.from(
      wrapper.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        [],
    );
    const at = enabled.indexOf(from as HTMLButtonElement);

    enabled[(at + step + enabled.length) % enabled.length]?.focus();
  };

  return (
    <div className="clients-add" ref={wrapper}>
      <button
        ref={button}
        type="button"
        className="primary clients-add-button"
        aria-label="Add"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        <span className="clients-add-plus">
          <Icon name="plus" />
        </span>
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Add"
          className="clients-add-menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              move(event.target as HTMLElement, event.key === 'ArrowDown' ? 1 : -1);
            } else if (event.key === 'Tab') {
              setOpen(false);
            }
          }}
        >
          {items.map((item) => (
            <button
              key={item.what}
              type="button"
              role="menuitem"
              disabled={item.blocked !== undefined}
              onClick={() => {
                setOpen(false);
                onPick(item.what);
              }}
            >
              <span>{item.label}</span>
              <small>{item.blocked ?? item.hint}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * An info icon whose text appears beside it: on hover, on keyboard focus, and on a tap, since a
 * phone has no hover. A screen reader is given the text as the button's description, so it is
 * read whether or not it is shown. Escape, or a tap elsewhere, puts it away.
 */
function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const tipId = useId();

  return (
    <span className={`clients-info${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="clients-info-button"
        aria-label="About this page"
        aria-describedby={tipId}
        aria-expanded={open}
        onClick={() => {
          setOpen((was) => !was);
        }}
        onBlur={() => {
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      >
        <Icon name="info" />
      </button>
      <span id={tipId} role="tooltip" className="clients-info-tip">
        {text}
      </span>
    </span>
  );
}

/* ---------------------------------------------------------------- adding, in a dialog */

/**
 * A dialog over the page, for adding one thing. The browser's own `<dialog>`: it keeps focus
 * inside while open, closes on Escape, and hands focus back to the button that opened it.
 * Clicking the shaded page around it closes it too.
 */
function Dialog({
  title,
  intro,
  onClose,
  children,
}: {
  title: string;
  intro: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;

    if (element !== null && !element.open) {
      element.showModal();
    }

    return () => {
      element?.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="clients-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        /* Escape. Closed by the page, so the page's state and the dialog never disagree. */
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        /* Only the shade around the panel is the dialog itself; the panel fills the rest. */
        if (event.target === dialog.current) {
          onClose();
        }
      }}
    >
      <div className="clients-dialog-panel">
        <header className="clients-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="iconic" aria-label="Close" onClick={onClose}>
            <Icon name="cross" />
          </button>
        </header>
        <p className="muted">{intro}</p>
        {children}
      </div>
    </dialog>
  );
}

/** A labelled field, its hint, and the server's sentence when it is about this field. */
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint === undefined ? null : hintId, error === undefined ? null : errorId]
      .filter((one) => one !== null)
      .join(' ') || undefined;

  return (
    <div className={`clients-field${error === undefined ? '' : ' has-error'}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy })}
      {hint === undefined ? null : (
        <p id={hintId} className="clients-field-hint">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="clients-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Sending one add, and what came of it: busy while it runs, closed when it is done, and the
 * server's sentence kept, beside the name where it was about the name.
 */
function useAdding(onAdded: () => void, onClose: () => void, onSignedOut: () => void) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [code, setCode] = useState<string | undefined>(undefined);

  const send = (add: () => Promise<void>) => {
    setBusy(true);
    setProblem(undefined);
    setCode(undefined);

    add()
      .then(() => {
        onAdded();
        onClose();
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
        setCode(error instanceof ApiError ? error.code : undefined);
        setBusy(false);
      });
  };

  /* A name already taken is about the name, though the server names no field for it. */
  const aboutTheName = problem?.field === 'name' || code === 'ClientsNameTaken';

  return {
    busy,
    send,
    nameError: aboutTheName ? problem?.what : undefined,
    lineError: problem?.field === 'lineId' ? problem.what : undefined,
    /** Anything else, shown across the foot of the dialog. */
    other:
      problem !== undefined && !aboutTheName && problem.field !== 'lineId' ? problem : undefined,
  };
}

function AddLineDialog({
  onAdded,
  onClose,
  onSignedOut,
}: {
  onAdded: () => void;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [name, setName] = useState('');
  const adding = useAdding(onAdded, onClose, onSignedOut);

  return (
    <Dialog
      title="Add a product line"
      intro="A line groups related products, so the pipeline can be read for the whole family or one product at a time."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          adding.send(() => addProductLine(name));
        }}
      >
        <Field
          label="Line name"
          hint="As it should read everywhere, for example Dura Capital."
          error={adding.nameError}
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              value={name}
              maxLength={80}
              autoFocus
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={adding.nameError === undefined ? undefined : true}
              disabled={adding.busy}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>

        {adding.other === undefined ? null : <Notice problem={adding.other} />}

        <footer className="clients-dialog-foot">
          <button type="button" disabled={adding.busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={adding.busy || name.trim() === ''}>
            {adding.busy ? 'Adding…' : 'Add line'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

function AddProductDialog({
  lines,
  initialLineId,
  onAdded,
  onClose,
  onSignedOut,
}: {
  /** The lines taking new products: a retired line takes none. */
  lines: ClientsProductLine[];
  /** The line to start in, where it was opened from inside one. */
  initialLineId?: string;
  /** Told which line the product went into. */
  onAdded: (lineId: string) => void;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [name, setName] = useState('');
  const [lineId, setLineId] = useState(
    lines.some((line) => line.id === initialLineId) ? (initialLineId ?? '') : (lines[0]?.id ?? ''),
  );
  const adding = useAdding(
    () => {
      onAdded(lineId);
    },
    onClose,
    onSignedOut,
  );

  return (
    <Dialog
      title="Add a product"
      intro="Once added, the product can be chosen for new deals straight away."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          adding.send(() => addProduct(lineId, name));
        }}
      >
        <Field label="Product name" hint="For example CreditStudio." error={adding.nameError}>
          {({ id, describedBy }) => (
            <input
              id={id}
              value={name}
              maxLength={80}
              autoFocus
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={adding.nameError === undefined ? undefined : true}
              disabled={adding.busy}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          label="Product line"
          hint="A product stays in its line for good. It can be renamed or retired later, but not moved."
          error={adding.lineError}
        >
          {({ id, describedBy }) => (
            <select
              id={id}
              value={lineId}
              aria-describedby={describedBy}
              disabled={adding.busy}
              onChange={(event) => {
                setLineId(event.target.value);
              }}
            >
              {lines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        {adding.other === undefined ? null : <Notice problem={adding.other} />}

        <footer className="clients-dialog-foot">
          <button type="button" disabled={adding.busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={adding.busy || name.trim() === '' || lineId === ''}
          >
            {adding.busy ? 'Adding…' : 'Add product'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
