import { useState } from 'react';
import { useRuntime } from '../app/context';
import { Button, Modal } from '../components/common';
import { t } from '../i18n';

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MASK = '••••••••';
// A name like these is a password's: the dialog keeps it secret unless told otherwise
const SECRET_NAME =
  /(^|_)(PASS|PASSWORD|PASSWD|PWD|SECRET|TOKEN|KEY|APIKEY|CREDENTIALS?)(_|$)/;

type Kind = 'variable' | 'secret';
/** The variable being added (no previous name) or edited, from the table of its kind. */
interface Editing {
  kind: Kind;
  previous?: string;
  name: string;
  value: string;
  /** Kept as a secret: a plain variable checked here becomes one. */
  secret: boolean;
  /** The person set the secret box; the name no longer decides it. */
  chosen: boolean;
}

/**
 * Variables as Windows keeps environment variables: a table of names and values with new,
 * edit and delete, used as %NAME% in any tool. A secret is one whose value the model never
 * sees and this page never shows again.
 */
export function VariablesSettings() {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const { variables, secrets } = snapshot.settings;
  const [selected, setSelected] = useState<Record<Kind, string | null>>({
    variable: null,
    secret: null,
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const saveVariables = (next: Record<string, string>) =>
    runtime.change((state) => {
      state.settings.variables = next;
    });
  const open = (kind: Kind, name?: string) =>
    setEditing({
      kind,
      ...(name ? { previous: name } : {}),
      name: name ?? '',
      value: name && kind === 'variable' ? (variables[name] ?? '') : '',
      secret: kind === 'secret' || SECRET_NAME.test(name ?? ''),
      chosen: false,
    });
  const remove = (kind: Kind, name: string) =>
    perform(async () => {
      if (kind === 'variable') {
        const { [name]: _removed, ...rest } = variables;
        await saveVariables(rest);
      } else await runtime.request('remove-secret', { name });
      setSelected({ ...selected, [kind]: null });
    });
  const submit = (edit: Editing) => {
    const { kind, previous, name, value, secret } = edit;
    if (!NAME.test(name)) {
      notify(
        t(
          'a variable name is capital letters, digits and _, starting with a letter',
        ),
      );
      return;
    }
    // The name the edited row had does not count against it
    if (name in variables && !(kind === 'variable' && name === previous)) {
      notify(t('{name} is already a variable', { name }));
      return;
    }
    if (secrets.includes(name) && !(kind === 'secret' && name === previous)) {
      notify(t('{name} is already a secret', { name }));
      return;
    }
    perform(async () => {
      if (!secret)
        // A renamed variable keeps its place in the list
        await saveVariables(
          Object.fromEntries(
            previous && previous in variables
              ? Object.entries(variables).map(([key, current]) =>
                  key === previous ? [name, value] : [key, current],
                )
              : [...Object.entries(variables), [name, value]],
          ),
        );
      else
        await runtime.request('save-secret', {
          name,
          value,
          // A plain variable made secret leaves the variables in the same step
          ...(previous && kind === 'secret' ? { previous } : {}),
          ...(previous && kind === 'variable' ? { replaces: previous } : {}),
        });
      const table: Kind = secret ? 'secret' : 'variable';
      setSelected({ ...selected, [table]: name });
      setEditing(null);
    });
  };
  return (
    <section className="settings-block">
      <h2>{t('variables')}</h2>
      <p className="panel-note">
        {t(
          "Written as Windows writes environment variables: %NAME% in a tool's arguments takes the value when the tool runs. The model also reads the values.",
        )}
      </p>
      <VariableTable
        label={t('variables')}
        rows={Object.entries(variables)}
        selected={selected.variable}
        onSelect={(name) => setSelected({ ...selected, variable: name })}
        onNew={() => open('variable')}
        onEdit={(name) => open('variable', name)}
        onDelete={(name) => remove('variable', name)}
      />
      <h3>{t('secrets')}</h3>
      <p className="panel-note">
        {t(
          'Variables whose values the model never sees: it knows the name, and reads %NAME% wherever a value shows in output. A saved value is not shown again.',
        )}
      </p>
      <VariableTable
        label={t('secrets')}
        rows={secrets.map((name) => [name, MASK])}
        selected={selected.secret}
        onSelect={(name) => setSelected({ ...selected, secret: name })}
        onNew={() => open('secret')}
        onEdit={(name) => open('secret', name)}
        onDelete={(name) => remove('secret', name)}
      />
      <Modal
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={
          editing?.kind === 'secret'
            ? editing.previous
              ? t('edit secret')
              : t('new secret')
            : editing?.previous
              ? t('edit variable')
              : t('new variable')
        }
      >
        {editing && (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              submit(editing);
            }}
          >
            <label>
              {t('variable name')}
              <input
                required
                autoFocus
                spellCheck={false}
                value={editing.name}
                onChange={(event) => {
                  const name = event.target.value.toUpperCase();
                  setEditing({
                    ...editing,
                    name,
                    secret:
                      editing.kind === 'secret' ||
                      (editing.chosen
                        ? editing.secret
                        : SECRET_NAME.test(name)),
                  });
                }}
              />
            </label>
            <label>
              {t('variable value')}
              <input
                type={editing.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                required={editing.kind === 'variable' || !editing.previous}
                placeholder={
                  editing.kind === 'secret' && editing.previous
                    ? t('leave empty to keep the value')
                    : undefined
                }
                value={editing.value}
                onChange={(event) =>
                  setEditing({ ...editing, value: event.target.value })
                }
              />
            </label>
            <label className="check-label variable-secret">
              <input
                type="checkbox"
                checked={editing.secret}
                // A secret's value is not known here, so it cannot become plain again
                disabled={editing.kind === 'secret'}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    secret: event.target.checked,
                    chosen: true,
                  })
                }
              />
              {t('secret: the model never sees the value')}
            </label>
            <div className="dialog-actions">
              <Button type="button" onClick={() => setEditing(null)}>
                {t('cancel')}
              </Button>
              <Button type="submit" className="primary">
                {t('ok')}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </section>
  );
}

function VariableTable({
  label,
  rows,
  selected,
  onSelect,
  onNew,
  onEdit,
  onDelete,
}: {
  label: string;
  rows: [string, string][];
  selected: string | null;
  onSelect: (name: string) => void;
  onNew: () => void;
  onEdit: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const current = rows.some(([name]) => name === selected) ? selected : null;
  return (
    <div className="variable-table">
      <div className="variable-table-frame">
        <table aria-label={label}>
          <thead>
            <tr>
              <th>{t('variable')}</th>
              <th>{t('value')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, value]) => (
              <tr
                key={name}
                tabIndex={0}
                aria-selected={name === current}
                onClick={() => onSelect(name)}
                onDoubleClick={() => onEdit(name)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onEdit(name);
                }}
              >
                <td>{name}</td>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="variable-table-actions">
        <Button type="button" onClick={onNew}>
          {t('new…')}
        </Button>
        <Button
          type="button"
          disabled={!current}
          onClick={() => current && onEdit(current)}
        >
          {t('edit…')}
        </Button>
        <Button
          type="button"
          disabled={!current}
          onClick={() => current && onDelete(current)}
        >
          {t('delete')}
        </Button>
      </div>
    </div>
  );
}
