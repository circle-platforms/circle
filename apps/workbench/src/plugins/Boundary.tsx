import { Component } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../components/common';
import { t } from '../i18n';
/** Contains React render failures; it is not code or process isolation. */
export class PluginBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="plugin-error" role="alert">
        <strong>
          {t('{name} could not be displayed', { name: this.props.name })}
        </strong>
        <p>{t('The conversation and other components remain available.')}</p>
        <Button onClick={() => this.setState({ failed: false })}>
          {t('retry')}
        </Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
