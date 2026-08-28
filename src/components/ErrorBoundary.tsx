import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Keeps one broken page from blanking the whole app.
 *
 * Ark renders data scraped from a page nobody controls, so an unexpected shape
 * reaching a component is a real possibility rather than a theoretical one.
 * When it happens the rest of the hub should stay usable, and the error should
 * be visible and copyable rather than only in a console nobody has open.
 */

interface Props {
  children: ReactNode
  /** Shown in the message so the user knows which part failed. */
  label?: string
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ark] render error', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="card p-6" role="alert">
        <h2 className="text-lg font-semibold text-ink-100">
          {this.props.label ? `${this.props.label} could not be displayed` : 'Something broke'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-300">
          The rest of the app still works — use the navigation above to move on. If this keeps
          happening, the data behind this page is probably a shape Ark did not expect.
        </p>
        <pre className="mt-4 max-h-48 overflow-auto rounded-lg bg-ink-950 p-3 font-mono text-xs leading-relaxed text-blitz-400">
          {error.message}
        </pre>
        <button
          type="button"
          className="btn mt-4"
          onClick={() => this.setState({ error: null })}
        >
          Try rendering again
        </button>
      </div>
    )
  }
}
