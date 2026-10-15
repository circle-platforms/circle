import { Component, type ErrorInfo, type ReactNode } from 'react';
import { copyText } from '../host';
import { t } from '../i18n';
interface Props {
  name: string;
  children: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}
interface State {
  error: Error | null;
  copied: boolean;
  copyFailed: boolean;
}
/** A renderer failure resets this surface only. It never cancels an Agent,
 * closes a PTY, or invokes a workspace mutation as part of recovery. */
export class NativeResourceBoundary extends Component<Props, State> {
  state: State = { error: null, copied: false, copyFailed: false };
  static getDerivedStateFromError(value: unknown) {
    return {
      error: value instanceof Error ? value : Error(String(value)),
      copied: false,
      copyFailed: false,
    };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }
  render() {
    const error = this.state.error;
    if (!error) return this.props.children;
    return (
      <section
        className="native-resource-error"
        role="alert"
        aria-label={t('{name} unavailable', { name: this.props.name })}
      >
        <h3>{t('{name} could not be displayed', { name: this.props.name })}</h3>
        <p>{t('your other views and running work are preserved')}</p>
        <div className="tasks-actions">
          <button
            className="button"
            onClick={() =>
              this.setState({ error: null, copied: false, copyFailed: false })
            }
          >
            {t('retry this view')}
          </button>
          <button
            className="button"
            onClick={() =>
              void copyText(error.stack ?? error.message).then(
                () => this.setState({ copied: true, copyFailed: false }),
                () => this.setState({ copyFailed: true }),
              )
            }
          >
            {this.state.copied ? t('copied') : t('copy diagnostic')}
          </button>
        </div>
        {this.state.copyFailed && <p>{t('clipboard unavailable')}</p>}
        <details>
          <summary>{t('diagnostic details')}</summary>
          <pre>{error.stack ?? error.message}</pre>
        </details>
      </section>
    );
  }
}
