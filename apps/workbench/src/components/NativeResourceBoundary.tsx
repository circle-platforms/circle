import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Tooltip } from 'radix-ui';
import { CopyButton, RowActions } from './common';
import { t } from '../i18n';
interface Props {
  name: string;
  resetKey?: string;
  children: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}
interface State {
  error: Error | null;
}
/** A renderer failure resets this surface only. It never cancels an Agent,
 * closes a PTY, or invokes a workspace mutation as part of recovery. */
export class NativeResourceBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(value: unknown) {
    return {
      error: value instanceof Error ? value : Error(String(value)),
    };
  }
  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: null });
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      this.props.onError?.(error, info);
    } catch {
      /* diagnostics must never crash another resource */
    }
  }
  render() {
    const error = this.state.error;
    if (!error) return this.props.children;
    // The last view left must not depend on what is around it: it brings its own tips
    return (
      <Tooltip.Provider delayDuration={300}>
        <section
          className="native-resource-error"
          role="alert"
          aria-label={t('{name} unavailable', { name: this.props.name })}
        >
          <header className="head-row">
            <h3>
              {t('{name} could not be displayed', { name: this.props.name })}
            </h3>
            <RowActions>
              <CopyButton
                text={error.stack ?? error.message}
                label={t('copy diagnostic')}
              />
            </RowActions>
          </header>
          <p>{t('your other views and running work are preserved')}</p>
          <div className="tasks-actions">
            <button
              className="button"
              onClick={() => this.setState({ error: null })}
            >
              {t('retry this view')}
            </button>
          </div>
          <details>
            <summary>{t('diagnostic details')}</summary>
            <pre>{error.stack ?? error.message}</pre>
          </details>
        </section>
      </Tooltip.Provider>
    );
  }
}
